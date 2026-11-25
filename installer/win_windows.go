//go:build windows

// Windows side of the setup: elevation, processes, shortcuts, registry, folders, permissions,
// message boxes.
package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const aumid = "app.goldline.takeoff" // the app's AppUserModelID (app.setAppUserModelId) - taskbar grouping

var (
	user32  = windows.NewLazySystemDLL("user32.dll")
	shell32 = windows.NewLazySystemDLL("shell32.dll")
	ole32   = windows.NewLazySystemDLL("ole32.dll")
	mpr     = windows.NewLazySystemDLL("mpr.dll")

	procMessageBoxW                 = user32.NewProc("MessageBoxW")
	procShellExecuteExW             = shell32.NewProc("ShellExecuteExW")
	procSHCreateItemFromParsingName = shell32.NewProc("SHCreateItemFromParsingName")
	procCoCreateInstance            = ole32.NewProc("CoCreateInstance")
	procCoInitializeEx              = ole32.NewProc("CoInitializeEx")
	procCoTaskMemFree               = ole32.NewProc("CoTaskMemFree")
	procWNetGetUniversalNameW       = mpr.NewProc("WNetGetUniversalNameW")
)

const (
	mbInfo  = 0x40 // MB_ICONINFORMATION
	mbWarn  = 0x30 // MB_ICONWARNING
	mbError = 0x10 // MB_ICONERROR
	mbYesNo = 0x04
	idYes   = 6
)

// underWine: this is Wine, not Windows (Wine's ntdll has its own export wine_get_version; Windows'
// ntdll, in System32 where no user can change it, never has).
var underWine = windows.NewLazySystemDLL("ntdll.dll").NewProc("wine_get_version").Find() == nil

func messageBox(text string, flags uint32) int {
	// The automated runs under Wine (tests/wine-*.sh) answer every prompt "yes" with this switch. On
	// Windows it is ignored: anything able to set an environment variable for the person must not be
	// able to answer "Remove Goldline Takeoff?" or "Install for everyone?" for them.
	if underWine && os.Getenv("GT_SETUP_NO_DIALOGS") == "1" {
		logf("messagebox: %s", text)
		return idYes
	}
	t, _ := windows.UTF16PtrFromString(text)
	c, _ := windows.UTF16PtrFromString("Goldline Takeoff Setup")
	r, _, _ := procMessageBoxW.Call(ownerHwnd, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), uintptr(flags|0x10000 /*MB_SETFOREGROUND*/))
	return int(r)
}

func isElevated() bool {
	return windows.GetCurrentProcessToken().IsElevated()
}

// exeLocked: Goldline Takeoff from that folder is running. Opening the exe for writing tells (a
// running exe can't be written) - but without admin rights a copy in Program Files always says
// "access denied", so the running programs are looked through as well.
func exeLocked(path string) bool {
	if p, err := windows.UTF16PtrFromString(path); err == nil {
		h, err := windows.CreateFile(p, windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
		if err == nil {
			windows.CloseHandle(h)
		} else if errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
			return true
		}
	}
	return appRunning(path)
}

// appRunning: a process started from exactly this exe (those this user may look at).
func appRunning(exe string) bool {
	want := strings.ToLower(filepath.Clean(exe))
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(snap)
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	base := strings.ToLower(filepath.Base(exe))
	for err = windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		if strings.ToLower(windows.UTF16ToString(e.ExeFile[:])) != base || e.ProcessID == uint32(os.Getpid()) {
			continue
		}
		h, err2 := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, e.ProcessID)
		if err2 != nil {
			continue // another user's (the elevated worker sees those - it checks again)
		}
		buf := make([]uint16, windows.MAX_LONG_PATH)
		n := uint32(len(buf))
		err2 = windows.QueryFullProcessImageName(h, 0, &buf[0], &n)
		windows.CloseHandle(h)
		if err2 == nil && strings.ToLower(filepath.Clean(windows.UTF16ToString(buf[:n]))) == want {
			return true
		}
	}
	return false
}

// launchApp starts Goldline Takeoff ("Open it now") through Explorer, always - as if the person
// double-clicked it - never as a child of this program:
//   - an app started from an elevated setup would be elevated too; Explorer starts it at the person's
//     normal level;
//   - a program that writes an exe into AppData and then starts it itself is what antivirus (Sophos)
//     calls dropper behaviour - that is what stopped the PDF Editor's update (29 Oct 2026). Started by
//     Explorer, the app's first start is the same as every later one from the Start menu.
//
// If Explorer can't be started, the app is NOT started directly (that is the very pattern above): the
// caller says to open it from the Start menu.
func launchApp(path string) error {
	// Windows' own folder as Windows reports it, not %WINDIR% (which the person can set: run as admin, the
	// setup would start whatever "explorer.exe" a changed WINDIR points at)
	win, err := windows.GetSystemWindowsDirectory()
	if err != nil || win == "" {
		logf("windows folder: %v", err)
		return fmt.Errorf("the Windows folder could not be found")
	}
	err = exec.Command(filepath.Join(win, "explorer.exe"), path).Start()
	if err != nil {
		logf("explorer %s: %v", path, err)
	}
	return err
}

func knownFolder(id *windows.KNOWNFOLDERID, fallback string) string {
	if p, err := windows.KnownFolderPath(id, 0); err == nil && p != "" {
		return p
	}
	return fallback
}

// programFilesDir: C:\Program Files (the 64-bit one). From Windows' own record of it first: the
// environment (ProgramW6432) can be set by the person, and the elevated copy uses this to decide
// where an install for everyone may go.
func programFilesDir() string {
	if p, err := windows.KnownFolderPath(windows.FOLDERID_ProgramFilesX64, 0); err == nil && p != "" {
		return p
	}
	if pf := os.Getenv("ProgramW6432"); pf != "" {
		return pf
	}
	return `C:\Program Files`
}

func defaultDir(scope string) string {
	if scope == "machine" {
		return filepath.Join(programFilesDir(), appName)
	}
	return filepath.Join(knownFolder(windows.FOLDERID_UserProgramFiles, filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs")), appName)
}

// userDataDirs: the app's folder for this person on this PC (main.cjs: %LOCALAPPDATA%\Goldline Takeoff -
// data\profile-<name> inside it, and the store of downloaded copies, app\).
func userDataDirs() []string {
	return []string{filepath.Join(knownFolder(windows.FOLDERID_LocalAppData, os.Getenv("LOCALAPPDATA")), appName)}
}

// toUNC turns a mapped drive path (S:\Tenders) into \\server\share\Tenders; other paths stay.
// onNetwork: a folder on a network share - a \\server path, or a drive letter mapped to one (0.23.2,
// DeepSeek #6: a mapped drive S:\ was taken as "this PC")
func onNetwork(p string) bool {
	if strings.HasPrefix(p, `\\`) {
		return true
	}
	if len(p) >= 2 && p[1] == ':' {
		if root, err := windows.UTF16PtrFromString(p[:2] + `\`); err == nil && windows.GetDriveType(root) == windows.DRIVE_REMOTE {
			return true
		}
		return strings.HasPrefix(toUNC(p), `\\`)
	}
	return false
}

func toUNC(p string) string {
	if strings.HasPrefix(p, `\\`) || len(p) < 2 || p[1] != ':' {
		return p
	}
	lp, err := windows.UTF16PtrFromString(p)
	if err != nil {
		return p
	}
	buf := make([]byte, 4096)
	size := uint32(len(buf))
	r, _, _ := procWNetGetUniversalNameW.Call(uintptr(unsafe.Pointer(lp)), 1 /*UNIVERSAL_NAME_INFO_LEVEL*/, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)))
	if r != 0 {
		return p // a local drive (or not connected): keep it
	}
	ptr := *(**uint16)(unsafe.Pointer(&buf[0]))
	if ptr == nil {
		return p
	}
	if u := windows.UTF16PtrToString(ptr); u != "" {
		return u
	}
	return p
}

// ---------------------------------------------------------------- elevation

type shellExecuteInfo struct {
	cbSize         uint32
	fMask          uint32
	hwnd           uintptr
	lpVerb         *uint16
	lpFile         *uint16
	lpParameters   *uint16
	lpDirectory    *uint16
	nShow          int32
	hInstApp       uintptr
	lpIDList       uintptr
	lpClass        *uint16
	hkeyClass      uintptr
	dwHotKey       uint32
	hIconOrMonitor uintptr
	hProcess       windows.Handle
}

// ownerHwnd: the setup window, so Windows' admin prompt belongs to it
var ownerHwnd uintptr

func shellExecute(verb, file, params string, wait bool) (uint32, error) {
	v, _ := windows.UTF16PtrFromString(verb)
	f, _ := windows.UTF16PtrFromString(file)
	pa, _ := windows.UTF16PtrFromString(params)
	sei := shellExecuteInfo{fMask: 0x00000040 /*SEE_MASK_NOCLOSEPROCESS*/ | 0x00000100 /*SEE_MASK_NOASYNC*/, hwnd: ownerHwnd, lpVerb: v, lpFile: f, lpParameters: pa, nShow: 1}
	sei.cbSize = uint32(unsafe.Sizeof(sei))
	r, _, e := procShellExecuteExW.Call(uintptr(unsafe.Pointer(&sei)))
	if r == 0 {
		return 0, e
	}
	if sei.hProcess == 0 {
		return 0, nil
	}
	defer windows.CloseHandle(sei.hProcess)
	if !wait {
		return 0, nil
	}
	_, _ = windows.WaitForSingleObject(sei.hProcess, windows.INFINITE)
	var code uint32
	_ = windows.GetExitCodeProcess(sei.hProcess, &code)
	return code, nil
}

func quoteArgs(args ...string) string {
	q := make([]string, len(args))
	for i, a := range args {
		q[i] = syscall.EscapeArg(a)
	}
	return strings.Join(q, " ")
}

// runElevated hands the job to a copy of this program started with admin rights (Windows asks
// the person) and follows its progress.
func runElevated(j Job, prog progressFn) error {
	self, _ := os.Executable()
	// a setup started from a mapped drive (S:\...\Setup): the admin side doesn't see the drive
	// letters of the person's session - it is started by the network path
	self = toUNC(self)
	jf := filepath.Join(os.TempDir(), fmt.Sprintf("gtsetup-job-%d.json", time.Now().UnixNano()))
	// the job's fingerprint goes on the elevated copy's command line: a job file changed while Windows
	// asks for admin rights is refused there (readJob)
	sum, err := writeJob(jf, j)
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(jf); _ = os.Remove(jf + ".progress"); _ = os.Remove(jf + ".result") }()
	done := make(chan error, 1)
	go func() {
		_, err := shellExecute("runas", self, quoteArgs("--worker", jf, "--job-sha", sum), true)
		done <- err
	}()
	for {
		select {
		case err := <-done:
			if err != nil {
				if errors.Is(err, windows.ERROR_CANCELLED) {
					return errors.New("administrator permission was not given")
				}
				return err
			}
			var res jobResult
			if err := readJSON(jf+".result", &res); err != nil {
				return errors.New("the installer with admin rights stopped without finishing")
			}
			if !res.OK {
				if res.Running {
					return errRunning
				}
				if res.Newer {
					return fmt.Errorf("%w: %s", errNewer, res.Err)
				}
				return errors.New(res.Err)
			}
			return nil
		case <-time.After(150 * time.Millisecond):
			if b, err := os.ReadFile(jf + ".progress"); err == nil {
				if parts := strings.SplitN(string(b), "|", 2); len(parts) == 2 {
					if f, err := strconv.ParseFloat(parts[0], 64); err == nil {
						prog(f, parts[1])
					}
				}
			}
		}
	}
}

// ---------------------------------------------------------------- COM (shortcuts, folder picker)

func comCall(obj uintptr, idx int, args ...uintptr) uintptr {
	vtbl := *(*uintptr)(unsafe.Pointer(obj))
	fn := *(*uintptr)(unsafe.Pointer(vtbl + uintptr(idx)*unsafe.Sizeof(uintptr(0))))
	r, _, _ := syscall.SyscallN(fn, append([]uintptr{obj}, args...)...)
	return r
}

func comRelease(obj uintptr) {
	if obj != 0 {
		comCall(obj, 2)
	}
}

func mustGUID(s string) windows.GUID {
	g, err := windows.GUIDFromString(s)
	if err != nil {
		panic(err)
	}
	return g
}

var (
	clsidShellLink      = mustGUID("{00021401-0000-0000-C000-000000000046}")
	iidShellLinkW       = mustGUID("{000214F9-0000-0000-C000-000000000046}")
	iidPersistFile      = mustGUID("{0000010b-0000-0000-C000-000000000046}")
	iidPropertyStore    = mustGUID("{886d8eeb-8cf2-4446-8d02-cdba1dbdcf99}")
	pkeyAppUserModelID  = mustGUID("{9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}")
	clsidFileOpenDialog = mustGUID("{DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7}")
	iidFileOpenDialog   = mustGUID("{d57c7288-d4ad-4768-be02-9d969532d960}")
	iidShellItem        = mustGUID("{43826d1e-e718-42ee-bc55-a1e261c37bfe}")
)

func coCreate(clsid, iid *windows.GUID) (uintptr, error) {
	var p uintptr
	hr, _, _ := procCoCreateInstance.Call(uintptr(unsafe.Pointer(clsid)), 0, 1 /*CLSCTX_INPROC_SERVER*/, uintptr(unsafe.Pointer(iid)), uintptr(unsafe.Pointer(&p)))
	if int32(hr) < 0 || p == 0 {
		return 0, fmt.Errorf("CoCreateInstance failed: %08x", uint32(hr))
	}
	return p, nil
}

func comQI(obj uintptr, iid *windows.GUID) (uintptr, error) {
	var p uintptr
	hr := comCall(obj, 0, uintptr(unsafe.Pointer(iid)), uintptr(unsafe.Pointer(&p)))
	if int32(hr) < 0 || p == 0 {
		return 0, fmt.Errorf("QueryInterface failed: %08x", uint32(hr))
	}
	return p, nil
}

// withCOM runs f on a locked thread with COM ready (shortcut creation from a worker goroutine).
func withCOM(f func() error) error {
	ch := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		procCoInitializeEx.Call(0, 2 /*COINIT_APARTMENTTHREADED*/)
		ch <- f()
	}()
	return <-ch
}

type propertyKey struct {
	fmtid windows.GUID
	pid   uint32
}

type propVariant struct {
	vt       uint16
	r1, r2   uint16
	r3       uint16
	val      uintptr
	reserved uintptr
}

func makeShortcut(lnk, target, workdir, icon, desc string) error {
	sl, err := coCreate(&clsidShellLink, &iidShellLinkW)
	if err != nil {
		return err
	}
	defer comRelease(sl)
	strs := []string{target, workdir, desc, icon, lnk, aumid}
	keep := make([]*uint16, len(strs))
	for i, s := range strs {
		keep[i], _ = windows.UTF16PtrFromString(s)
	}
	// (the strings Windows reads must stay in memory until this returns - on every way out)
	defer runtime.KeepAlive(keep)
	// a shortcut whose target wasn't taken would still be saved - and do nothing when clicked: the
	// error is returned instead (the install goes on; the log says which shortcut is missing)
	if hr := comCall(sl, 20, uintptr(unsafe.Pointer(keep[0]))); int32(hr) < 0 { // SetPath
		return fmt.Errorf("shortcut %s: its target %s was refused (%08x)", lnk, target, uint32(hr))
	}
	comCall(sl, 9, uintptr(unsafe.Pointer(keep[1])))     // SetWorkingDirectory
	comCall(sl, 7, uintptr(unsafe.Pointer(keep[2])))     // SetDescription
	comCall(sl, 17, uintptr(unsafe.Pointer(keep[3])), 0) // SetIconLocation
	if ps, err := comQI(sl, &iidPropertyStore); err == nil {
		key := propertyKey{fmtid: pkeyAppUserModelID, pid: 5}
		pv := propVariant{vt: 31 /*VT_LPWSTR*/, val: uintptr(unsafe.Pointer(keep[5]))}
		comCall(ps, 6, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(&pv))) // SetValue
		comCall(ps, 7)                                                              // Commit
		comRelease(ps)
	}
	pf, err := comQI(sl, &iidPersistFile)
	if err != nil {
		return err
	}
	defer comRelease(pf)
	_ = os.MkdirAll(filepath.Dir(lnk), 0o755)
	if hr := comCall(pf, 6, uintptr(unsafe.Pointer(keep[4])), 1); int32(hr) < 0 { // Save
		return fmt.Errorf("saving %s failed: %08x", lnk, uint32(hr))
	}
	return nil
}

// shortcutPaths: where the Start menu and desktop shortcuts are
func shortcutPaths(scope string) (start, desktop string) {
	name := displayName
	if scope == "machine" {
		return filepath.Join(knownFolder(windows.FOLDERID_CommonPrograms, filepath.Join(os.Getenv("ProgramData"), `Microsoft\Windows\Start Menu\Programs`)), name+".lnk"),
			filepath.Join(knownFolder(windows.FOLDERID_PublicDesktop, filepath.Join(os.Getenv("PUBLIC"), "Desktop")), name+".lnk")
	}
	return filepath.Join(knownFolder(windows.FOLDERID_Programs, filepath.Join(os.Getenv("APPDATA"), `Microsoft\Windows\Start Menu\Programs`)), name+".lnk"),
		filepath.Join(knownFolder(windows.FOLDERID_Desktop, filepath.Join(os.Getenv("USERPROFILE"), "Desktop")), name+".lnk")
}

const shortcutDesc = "Quantity take-off from drawings"

func makeShortcuts(dir string, ii InstallInfo) error {
	exe := filepath.Join(dir, exeName)
	start, desktop := shortcutPaths(ii.Scope)
	// a desktop shortcut that is there already (an update) stays wanted
	hadDesktop := shortcutPointsAt(desktop, exe)
	return withCOM(func() error {
		var first error
		if err := makeShortcut(start, exe, dir, exe, shortcutDesc); err != nil {
			first = err
		}
		if ii.Desktop || hadDesktop {
			if err := makeShortcut(desktop, exe, dir, exe, shortcutDesc); err != nil && first == nil {
				first = err
			}
		} else {
			removeShortcutTo(desktop, dir)
		}
		return first
	})
}

// removeShortcutTo removes a shortcut of ours (named Goldline Takeoff.lnk) only when it points at
// dir\Goldline Takeoff.exe - a shortcut of the same name to another copy (a portable one on D:, or
// "C:\Apps\Goldline Takeoff 2") stays.
func removeShortcutTo(lnk, dir string) {
	if shortcutPointsAt(lnk, filepath.Join(filepath.Clean(dir), exeName)) {
		_ = os.Remove(lnk)
	}
}

// shortcutPointsAt: the .lnk's target is exactly exe (read with the Shell's own IShellLink)
func shortcutPointsAt(lnk, exe string) bool {
	if !fileExists(lnk) {
		return false
	}
	target := ""
	_ = withCOM(func() error {
		sl, err := coCreate(&clsidShellLink, &iidShellLinkW)
		if err != nil {
			return err
		}
		defer comRelease(sl)
		pf, err := comQI(sl, &iidPersistFile)
		if err != nil {
			return err
		}
		defer comRelease(pf)
		p, _ := windows.UTF16PtrFromString(lnk)
		if hr := comCall(pf, 5, uintptr(unsafe.Pointer(p)), 0); int32(hr) < 0 { // Load (STGM_READ)
			return fmt.Errorf("load %08x", uint32(hr))
		}
		buf := make([]uint16, windows.MAX_LONG_PATH)
		if hr := comCall(sl, 3, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)), 0, 0x4 /*SLGP_RAWPATH*/); int32(hr) < 0 { // GetPath
			return fmt.Errorf("getpath %08x", uint32(hr))
		}
		target = windows.UTF16ToString(buf)
		return nil
	})
	if target == "" {
		return false
	}
	return strings.EqualFold(filepath.Clean(target), filepath.Clean(exe))
}

func removeShortcuts(scope, dir string) {
	start, desktop := shortcutPaths(scope)
	removeShortcutTo(start, dir)
	removeShortcutTo(desktop, dir)
}

// pickFolder: the standard Windows folder picker. "" when cancelled.
func pickFolder(owner uintptr, title, start string) string {
	d, err := coCreate(&clsidFileOpenDialog, &iidFileOpenDialog)
	if err != nil {
		logf("folder picker: %v", err)
		return ""
	}
	defer comRelease(d)
	var opts uint32
	comCall(d, 10, uintptr(unsafe.Pointer(&opts)))                              // GetOptions
	comCall(d, 9, uintptr(opts|0x20 /*PICKFOLDERS*/ |0x40 /*FORCEFILESYSTEM*/)) // SetOptions
	t, _ := windows.UTF16PtrFromString(title)
	comCall(d, 17, uintptr(unsafe.Pointer(t))) // SetTitle
	if start != "" {
		for p := start; p != "" && p != filepath.Dir(p); p = filepath.Dir(p) {
			if fileExists(p) {
				sp, _ := windows.UTF16PtrFromString(p)
				var item uintptr
				hr, _, _ := procSHCreateItemFromParsingName.Call(uintptr(unsafe.Pointer(sp)), 0, uintptr(unsafe.Pointer(&iidShellItem)), uintptr(unsafe.Pointer(&item)))
				if int32(hr) >= 0 && item != 0 {
					comCall(d, 12, item) // SetFolder
					comRelease(item)
				}
				break
			}
		}
	}
	if hr := comCall(d, 3, owner); int32(hr) < 0 { // Show (cancelled: 0x800704C7)
		return ""
	}
	var item uintptr
	if hr := comCall(d, 20, uintptr(unsafe.Pointer(&item))); int32(hr) < 0 || item == 0 { // GetResult
		return ""
	}
	defer comRelease(item)
	var name *uint16
	if hr := comCall(item, 5, 0x80058000 /*SIGDN_FILESYSPATH*/, uintptr(unsafe.Pointer(&name))); int32(hr) < 0 || name == nil {
		return ""
	}
	defer procCoTaskMemFree.Call(uintptr(unsafe.Pointer(name)))
	return windows.UTF16PtrToString(name)
}

// ---------------------------------------------------------------- registry

const (
	uninstallKey = `Software\Microsoft\Windows\CurrentVersion\Uninstall\GoldlineTakeoff`
	appPathsKey  = `Software\Microsoft\Windows\CurrentVersion\App Paths\Goldline Takeoff.exe`
)

func rootFor(scope string) registry.Key {
	if scope == "machine" {
		return registry.LOCAL_MACHINE
	}
	return registry.CURRENT_USER
}

func setStr(root registry.Key, path, name, val string) error {
	k, _, err := registry.CreateKey(root, path, registry.SET_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetStringValue(name, val)
}

func setDword(root registry.Key, path, name string, val uint32) error {
	k, _, err := registry.CreateKey(root, path, registry.SET_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetDWordValue(name, val)
}

func deleteTree(root registry.Key, path string) {
	k, err := registry.OpenKey(root, path, registry.ENUMERATE_SUB_KEYS|registry.WOW64_64KEY)
	if err == nil {
		subs, _ := k.ReadSubKeyNames(-1)
		k.Close()
		for _, s := range subs {
			deleteTree(root, path+`\`+s)
		}
	}
	_ = registry.DeleteKey(root, path)
}

func getStr(root registry.Key, path, name string) string {
	k, err := registry.OpenKey(root, path, registry.QUERY_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return ""
	}
	defer k.Close()
	v, _, _ := k.GetStringValue(name)
	return v
}

func registerApp(dir string, ii InstallInfo) error {
	root := rootFor(ii.Scope)
	exe := filepath.Join(dir, exeName)
	un := filepath.Join(dir, uninstallName)
	var errs []string
	add := func(err error) {
		if err != nil {
			errs = append(errs, err.Error())
		}
	}
	// Installed apps (Settings > Apps) with a working Uninstall button
	add(setStr(root, uninstallKey, "DisplayName", displayName))
	add(setStr(root, uninstallKey, "DisplayVersion", ii.Version))
	add(setStr(root, uninstallKey, "Publisher", "Goldline"))
	add(setStr(root, uninstallKey, "DisplayIcon", `"`+exe+`",0`))
	add(setStr(root, uninstallKey, "InstallLocation", dir))
	add(setStr(root, uninstallKey, "UninstallString", `"`+un+`" --uninstall`))
	add(setStr(root, uninstallKey, "QuietUninstallString", `"`+un+`" --uninstall --silent`))
	add(setStr(root, uninstallKey, "InstallDate", time.Now().Format("20060102")))
	add(setDword(root, uninstallKey, "NoModify", 1))
	add(setDword(root, uninstallKey, "NoRepair", 1))
	add(setDword(root, uninstallKey, "EstimatedSize", dirSizeKB(dir)))
	// "Goldline Takeoff" works in the Run box
	add(setStr(root, appPathsKey, "", exe))
	add(setStr(root, appPathsKey, "Path", dir))
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}

func unregisterApp(dir, scope string) {
	root := rootFor(scope)
	if strings.EqualFold(filepath.Clean(getStr(root, uninstallKey, "InstallLocation")), filepath.Clean(dir)) {
		deleteTree(root, uninstallKey)
	}
	if strings.EqualFold(getStr(root, appPathsKey, ""), filepath.Join(dir, exeName)) {
		deleteTree(root, appPathsKey)
	}
}

// registeredDir: dir is where Windows has Goldline Takeoff registered (Installed apps) for that kind of
// install - for everyone in HKLM (only administrators can write it), for one person in their HKCU.
// The elevated copy removes no other folder, however much it looks like an install.
func registeredDir(scope, dir string) bool {
	r := getStr(rootFor(scope), uninstallKey, "InstallLocation")
	return r != "" && strings.EqualFold(filepath.Clean(r), filepath.Clean(dir))
}

// findInstalled: an existing install (this user's first, then for everyone).
func findInstalled() (string, *InstallInfo) {
	for _, root := range []registry.Key{registry.CURRENT_USER, registry.LOCAL_MACHINE} {
		dir := getStr(root, uninstallKey, "InstallLocation")
		if dir == "" || !looksInstalled(dir) {
			continue
		}
		ii, err := readInstall(dir)
		if err != nil {
			continue
		}
		return dir, ii
	}
	return "", nil
}
