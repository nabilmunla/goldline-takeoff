// Goldline Takeoff Setup: one file that installs Goldline Takeoff (for one person or for everyone on the
// PC). The copy it leaves in the app folder (without the app inside) only removes it again.
//
//	Goldline Takeoff Setup.exe                    install (window; plain prompts without WebView2)
//	  --silent [--all-users] [--dir D] [--no-desktop] [--data \\server\share\folder]
//	--uninstall [--dir D] [--silent]           (also: the uninstaller copy started with no options)
//
// Exit: 0 done, 1 failed, 2 nothing done (nothing to do, another setup already open, or a refused
// admin-step job), 3 the app is open, 4 a newer version is installed.
//
// Updates are done by the app itself (electron/updater.cjs): no option here applies one.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
)

// Options are the choices made in the window (or on the command line).
type Options struct {
	Scope    string `json:"scope"` // "user" | "machine"
	Dir      string `json:"dir"`
	Desktop  bool   `json:"desktop"`
	DataRoot string `json:"dataRoot"` // the shared Goldline Takeoff folder; "" = chosen in the app
}

var (
	errRunning = errors.New("Goldline Takeoff is open")
	errNewer   = errors.New("a newer version is installed")
)

type progressFn func(pct float64, stage string)

var (
	logMu   sync.Mutex
	logPath string
)

func initLog() {
	logPath = filepath.Join(os.TempDir(), "Goldline Takeoff Setup.log")
	if fi, err := os.Stat(logPath); err == nil && fi.Size() > 1<<20 {
		_ = os.Remove(logPath)
	}
}

func logf(format string, a ...any) {
	logMu.Lock()
	defer logMu.Unlock()
	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s [%d] %s\n", time.Now().Format("2006-01-02 15:04:05"), os.Getpid(), fmt.Sprintf(format, a...))
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

// how long install / uninstall wait for Goldline Takeoff to be gone before saying it is open (0.16.0,
// from PDF Editor 0.8.7): right after the window closes, its drawing engines (utility processes started
// from the same exe) can take a few seconds to end, and an antivirus may scan the exe as they do - a
// check made once at that moment said "Goldline Takeoff is open" to someone who had just closed it
var appGoneWait = 30 * time.Second

// stillOpen: the exe is still in use after waiting up to appGoneWait for it to be free (logged)
func stillOpen(exe string) bool {
	if !exeLocked(exe) {
		return false
	}
	logf("%s is in use: waiting up to %v for Goldline Takeoff to end", exe, appGoneWait)
	until := time.Now().Add(appGoneWait)
	for time.Now().Before(until) {
		time.Sleep(500 * time.Millisecond)
		if !exeLocked(exe) {
			logf("%s is free now", exe)
			return false
		}
	}
	logf("%s still in use after %v", exe, appGoneWait)
	return true
}

// plainUI: --plain - plain Windows prompts instead of the setup window (if that window misbehaves)
var plainUI bool

// canWrite: can this process create files in dir (made if missing)?
func canWrite(dir string) bool {
	probe := dir
	for !fileExists(probe) {
		parent := filepath.Dir(probe)
		if parent == probe {
			return false
		}
		probe = parent
	}
	f, err := os.CreateTemp(probe, ".gtsetup-write-test-*")
	if err != nil {
		return false
	}
	name := f.Name()
	f.Close()
	_ = os.Remove(name)
	return true
}

// isRootish: a drive or share root (C:\, \\server\share) - never an app folder
func isRootish(d string) bool {
	d = filepath.Clean(d)
	if filepath.Dir(d) == d {
		return true
	}
	vol := filepath.VolumeName(d)
	return vol != "" && strings.TrimRight(d[len(vol):], `\/`) == ""
}

// looksInstalled: never delete a folder that isn't a Goldline Takeoff install of this setup's: its
// install.json as the setup writes it, and the app's starter package (productName Goldline Takeoff).
// The exe may be gone (quarantined by an antivirus, a removal stopped halfway): the folder can still
// be repaired or removed.
func looksInstalled(dir string) bool {
	d := filepath.Clean(dir)
	if isRootish(d) {
		return false
	}
	var ii InstallInfo
	if readJSON(filepath.Join(d, "install.json"), &ii) != nil || (ii.Scope != "user" && ii.Scope != "machine") || !versionRe.MatchString(ii.Version) {
		return false
	}
	var pkg struct {
		ProductName string `json:"productName"`
	}
	return readJSON(filepath.Join(d, "resources", "app", "package.json"), &pkg) == nil && pkg.ProductName == appName
}

// olderCopy: a Goldline Takeoff folder made by hand (unzipped, before this setup existed) - the app is
// there, an install record isn't. Its version, or "" when the folder is anything else. Strict on
// purpose: only such a folder may be replaced like an install.
func olderCopy(dir string) string {
	d := filepath.Clean(dir)
	if isRootish(d) || fileExists(filepath.Join(d, "install.json")) || !fileExists(filepath.Join(d, exeName)) {
		return ""
	}
	var pk struct {
		ProductName string `json:"productName"`
		Main        string `json:"main"`
		Version     string `json:"version"`
	}
	if readJSON(filepath.Join(d, "resources", "app", "package.json"), &pk) != nil || pk.ProductName != appName || (pk.Main != "electron/main.cjs" && pk.Main != "boot.cjs") {
		return ""
	}
	if v := readAppState(d).Current; v != "" {
		return v
	}
	if pk.Version == "" {
		return "(older)"
	}
	return pk.Version
}

// installedVersion: what the app in dir runs now ("" if nothing of ours is there).
func installedVersion(dir string) string {
	if !looksInstalled(dir) && olderCopy(dir) == "" {
		return ""
	}
	return readAppState(dir).Current
}

func doInstall(p *Payload, o Options, prog progressFn) error {
	if !p.present {
		return errors.New("this copy of the setup has no app inside")
	}
	if o.Dir == "" {
		o.Dir = defaultDir(o.Scope)
	}
	o.Dir = filepath.Clean(o.Dir)
	o.DataRoot = strings.TrimSpace(o.DataRoot)
	// an interrupted run may have left the app set aside next to its folder: put back before anything
	// is decided about it
	recoverInterrupted(o.Dir)
	if ii, err := readInstall(o.Dir); err == nil && looksInstalled(o.Dir) && ii.Scope != o.Scope {
		logf("%s is installed for %s: kept so", o.Dir, ii.Scope)
		o.Scope = ii.Scope
	}
	// for everyone only inside Program Files - checked here too, after the scope is settled: the window
	// may ask "just me" for a folder that turns out to hold an install for everyone (see checkDir)
	if o.Scope == "machine" {
		if msg := everyoneDirMsg(o.Dir); msg != "" {
			logf("install for everyone in %s refused: outside %s", o.Dir, programFilesDir())
			return errors.New(msg)
		}
	}
	exe := filepath.Join(o.Dir, exeName)
	if fileExists(exe) && stillOpen(exe) {
		return errRunning
	}
	if fileExists(o.Dir) && !looksInstalled(o.Dir) && olderCopy(o.Dir) == "" {
		if entries, err := os.ReadDir(o.Dir); err != nil || len(entries) > 0 {
			return fmt.Errorf("%s already has other files in it - choose an empty or new folder", o.Dir)
		}
	}
	// never an older app over a newer one (the app updated itself since this setup was made):
	// the person would lose the newer version without being asked
	if cur := installedVersion(o.Dir); cur != "" && cmpVersion(cur, p.Meta.Version) > 0 {
		logf("install %s refused: %s is installed in %s", p.Meta.Version, cur, o.Dir)
		return fmt.Errorf("%w (%s)", errNewer, cur)
	}
	logf("install %s to %s (%s) desktop=%v data=%q", p.Meta.Version, o.Dir, o.Scope, o.Desktop, o.DataRoot)
	prog(0.01, "Checking the setup")
	if err := p.Verify(func(d, t int64) { prog(0.01+0.09*float64(d)/float64(max(t, 1)), "Checking the setup") }); err != nil {
		return err
	}
	prog(0.1, "Copying files")
	ii := InstallInfo{Scope: o.Scope, Version: p.Meta.Version, Runtime: p.Meta.Runtime, Desktop: o.Desktop, Installed: time.Now().Format(time.RFC3339)}
	// everything the folder needs goes into the new copy before it is swapped in: stopped
	// halfway (power cut, error), the old folder is still whole - or there is none yet
	oldDefaults := map[string]string{}
	err := replaceDir(o.Dir, func(tmp, old string) error {
		if err := p.Extract(tmp, func(d, t int64) {
			if t <= 0 {
				t = 1
			}
			prog(0.1+0.72*float64(d)/float64(t), "Copying files")
		}); err != nil {
			return err
		}
		prog(0.83, "Finishing")
		appDir := filepath.Join(tmp, "resources", "app")
		if !startableVersion(appDir, p.Meta.Version) {
			return errors.New("the setup file is damaged (the app inside is incomplete) - get it again")
		}
		previous := ""
		if old != "" {
			// the version that ran before stays as the way back
			keep, prev := keepVersions(readAppState(old), p.Meta.Version)
			for _, v := range keep {
				if err := copyTree(filepath.Join(old, "resources", "app", "versions", v), filepath.Join(appDir, "versions", v)); err != nil {
					logf("keeping version %s: %v", v, err)
					_ = os.RemoveAll(filepath.Join(appDir, "versions", v))
					prev = ""
				}
			}
			if prev == "" {
				// a copy made by hand before the versioned layout: its app becomes a version folder
				prev = keepOneFolder(old, appDir, p.Meta.Version)
			}
			previous = prev
			keepNewerStarter(filepath.Join(old, "resources", "app", "boot.cjs"), filepath.Join(appDir, "boot.cjs"))
			// the shared folder already set (by this setup or by hand) stays unless a new one is given
			// the shared folder already set (next to the exe, or - hand-made copies - in resources\app,
			// where the app reads it too) stays as it was written, extra settings and all, unless a new
			// folder is given
			for _, f := range []string{"defaults.json", filepath.Join("resources", "app", "defaults.json")} {
				if o.DataRoot == "" && fileExists(filepath.Join(old, f)) {
					if err := copyFile(filepath.Join(old, f), filepath.Join(tmp, f)); err != nil {
						logf("keeping %s: %v", f, err)
					}
				} else if o.DataRoot != "" && fileExists(filepath.Join(old, f)) {
					oldDefaults[f] = filepath.Join(old, f)
				}
			}
		}
		if err := writeCurrent(appDir, p.Meta.Version, previous); err != nil {
			return err
		}
		if err := p.copyExePart(filepath.Join(tmp, uninstallName)); err != nil {
			return fmt.Errorf("can't write the uninstaller: %w", err)
		}
		if err := writeJSON(filepath.Join(tmp, "install.json"), ii); err != nil {
			return err
		}
		if o.DataRoot != "" {
			// a new shared folder: the other settings in the old file stay
			d := map[string]any{}
			if f, ok := oldDefaults["defaults.json"]; ok {
				_ = readLooseJSON(f, &d)
			}
			d["dataRoot"] = o.DataRoot
			if err := writeJSON(filepath.Join(tmp, "defaults.json"), d); err != nil {
				return err
			}
		}
		// (installed for everyone, the folder stays as Program Files keeps it: only administrators may
		// change it. The app can't update itself there - it says so and points at the setup, which IT
		// runs. Letting every user write the app's code would let one user plant code that runs for the
		// next - admins included.)
		return nil
	})
	if err != nil {
		return err
	}
	prog(0.93, "Creating shortcuts")
	if err := makeShortcuts(o.Dir, ii); err != nil {
		logf("shortcuts: %v", err)
	}
	prog(0.97, "Registering with Windows")
	if err := registerApp(o.Dir, ii); err != nil {
		logf("register: %v", err)
	}
	prog(1, "Done")
	logf("installed")
	return nil
}

// keepNewerStarter: the app's updater may have put a newer starter (boot.cjs, BOOT_REV) in the old
// folder than the setup has: the newer one stays.
func keepNewerStarter(oldBoot, newBoot string) {
	rev := func(p string) int {
		b, err := os.ReadFile(p)
		if err != nil {
			return -1
		}
		m := bootRevRe.FindSubmatch(b)
		if m == nil {
			return 0
		}
		n := 0
		fmt.Sscanf(string(m[1]), "%d", &n)
		return n
	}
	if rev(oldBoot) > rev(newBoot) {
		if err := copyFile(oldBoot, newBoot); err != nil {
			logf("keeping the newer starter: %v", err)
		}
	}
}

func doUninstall(dir string, prog progressFn) error {
	dir = filepath.Clean(dir)
	if !looksInstalled(dir) {
		return fmt.Errorf("%s doesn't look like a Goldline Takeoff installation - nothing was removed", dir)
	}
	if stillOpen(filepath.Join(dir, exeName)) {
		return errRunning
	}
	ii, _ := readInstall(dir)
	scope := "user"
	if ii != nil && ii.Scope != "" {
		scope = ii.Scope
	}
	logf("uninstall %s (%s)", dir, scope)
	prog(0.1, "Removing shortcuts")
	removeShortcuts(scope, dir)
	prog(0.2, "Removing from Windows")
	unregisterApp(dir, scope)
	prog(0.3, "Removing files")
	// the uninstaller (often this very program) can't be deleted while it runs: it is moved out of the
	// folder first (Windows allows renaming a running program) - nothing is started from anywhere else
	moveUninstallerAside(dir)
	err := retry(10*time.Second, func() error { return os.RemoveAll(dir) })
	// what an interrupted install of ours left next to it (only our own names)
	// (someone's own "<dir>.gtsetup-backup" is not one of them)
	for _, l := range ourLeftovers(dir) {
		_ = os.RemoveAll(l)
	}
	if err != nil {
		return fmt.Errorf("some files couldn't be removed: %w", err)
	}
	prog(1, "Done")
	logf("uninstalled")
	return nil
}

// moveUninstallerAside: "Uninstall Goldline Takeoff.exe" out of dir - into the temp folder (the next
// setup run deletes it), or next to dir under our own name when the temp folder is on another drive.
func moveUninstallerAside(dir string) {
	p := filepath.Join(dir, uninstallName)
	if !fileExists(p) {
		return
	}
	tag := strconv.FormatInt(time.Now().UnixNano()%1e9, 36)
	for _, dst := range []string{
		filepath.Join(os.TempDir(), "Goldline Takeoff Uninstall "+tag+".exe"),
		dir + swapTag + "trash-" + tag + ".exe",
	} {
		if err := os.Rename(p, dst); err == nil {
			logf("uninstaller moved to %s", dst)
			return
		}
	}
	logf("the uninstaller could not be moved out of %s", dir)
}

// removeUserData: this person's Goldline Takeoff data on this PC (settings, logs, copies of drawings).
// Never while changes made here haven't reached the shared folder: they would be lost. Projects are
// on the shared folder and are never touched. Returns how many unsent changes kept the data.
func removeUserData() int {
	dirs := userDataDirs()
	n := 0
	for _, d := range dirs {
		n += pendingChanges(d)
	}
	if n > 0 {
		logf("user data kept: %d unsent change file(s)", n)
		return n
	}
	for _, d := range dirs {
		if d != "" && strings.EqualFold(filepath.Base(filepath.Clean(d)), appName) {
			_ = os.RemoveAll(d)
		}
	}
	return 0
}

// Job is work handed to an elevated copy of this program (installing / removing for everyone).
type Job struct {
	Kind string  `json:"kind"` // install | uninstall
	Opts Options `json:"opts"`
	Dir  string  `json:"dir"`
}

type jobResult struct {
	OK      bool   `json:"ok"`
	Err     string `json:"err"`
	Running bool   `json:"running"`
	Newer   bool   `json:"newer"`
}

func runJob(p *Payload, j Job, prog progressFn) error {
	switch j.Kind {
	case "install":
		return doInstall(p, j.Opts, prog)
	case "uninstall":
		return doUninstall(j.Dir, prog)
	}
	return fmt.Errorf("unknown job %q", j.Kind)
}

// writeJob writes the job for the elevated copy and returns the SHA-256 of exactly the bytes written.
// The job file is in the person's %TEMP%, which any program running as that person can change - also
// while Windows asks for admin rights. The fingerprint goes to the elevated copy on its command line,
// which those programs can't change, so a file changed in between is refused.
func writeJob(jf string, j Job) (string, error) {
	b, err := json.MarshalIndent(j, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(jf+".tmp", b, 0o644); err != nil {
		return "", err
	}
	if err := os.Rename(jf+".tmp", jf); err != nil {
		_ = os.Remove(jf + ".tmp")
		return "", err
	}
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:]), nil
}

// errJobChanged: the job file isn't the one the setup wrote
var errJobChanged = errors.New("the setup's instructions for the admin step were changed after it wrote them (by another program) - nothing was done")

// readJob is the elevated side's check of the job. The file is read once, its fingerprint compared
// with the one on the command line (want), and the very bytes checked are the ones used. Then the
// request itself is checked again the way the window checks it - with admin rights nothing is taken
// on trust, because any program can start this setup with admin rights and its own job (Windows still
// asks the person first):
//   - install: a folder the window would accept (checkDir: full path, on this PC, empty or an install
//     of ours, for everyone only inside Program Files, not too long);
//   - uninstall: only the folder Windows has Goldline Takeoff registered in (Installed apps) - not any
//     folder that merely looks like an install.
func readJob(jf, want string) (Job, error) {
	var j Job
	b, err := os.ReadFile(jf)
	if err != nil {
		return j, err
	}
	if want == "" {
		return j, errors.New("the admin step was started without the fingerprint of its instructions (--job-sha) - nothing was done")
	}
	s := sha256.Sum256(b)
	if !strings.EqualFold(hex.EncodeToString(s[:]), want) {
		return j, errJobChanged
	}
	if err := json.Unmarshal(b, &j); err != nil {
		return j, err
	}
	switch j.Kind {
	case "install":
		if j.Opts.Scope != "user" && j.Opts.Scope != "machine" {
			return j, fmt.Errorf("unknown kind of install %q - nothing was done", j.Opts.Scope)
		}
		// (the side that asks fills in the folder: an empty one would be the admin account's default)
		if j.Opts.Dir == "" {
			return j, errors.New("no folder given - nothing was done")
		}
		if msg := checkDir(j.Opts.Scope, j.Opts.Dir); msg != "" {
			return j, errors.New(msg)
		}
	case "uninstall":
		ii, err := readInstall(j.Dir)
		if err != nil || !looksInstalled(j.Dir) || !registeredDir(ii.Scope, j.Dir) {
			return j, fmt.Errorf("%s is not where Windows has Goldline Takeoff installed - nothing was removed", j.Dir)
		}
	default:
		return j, fmt.Errorf("unknown job %q", j.Kind)
	}
	return j, nil
}

// runWorker is the elevated side: does the job, reports progress and the result in files.
func runWorker(p *Payload, jobFile, jobSHA string) int {
	// the job file is the person's: only a plain local file is opened with admin rights
	if err := localPlainPath(jobFile); err != nil {
		logf("worker: job refused: %v", err)
		return 2
	}
	j, err := readJob(jobFile, jobSHA)
	if err != nil {
		logf("worker: job refused: %v", err)
		// the window gets the reason (it reads only this file)
		_ = writeJSON(jobFile+".result", jobResult{Err: err.Error()})
		return 2
	}
	progFile := jobFile + ".progress"
	err = runJob(p, j, func(pct float64, stage string) {
		_ = os.WriteFile(progFile, []byte(fmt.Sprintf("%.4f|%s", pct, stage)), 0o644)
	})
	res := jobResult{OK: err == nil}
	if err != nil {
		res.Err = err.Error()
		res.Running = errors.Is(err, errRunning)
		res.Newer = errors.Is(err, errNewer)
		logf("worker %s failed: %v", j.Kind, err)
	}
	_ = writeJSON(jobFile+".result", res)
	if err != nil {
		return 1
	}
	return 0
}

// runAs does the job here, or in an elevated copy when this process can't write there.
func runAs(p *Payload, j Job, elevate bool, prog progressFn) error {
	if !elevate || isElevated() {
		return runJob(p, j, prog)
	}
	// the folder is decided here, by the person's side: left empty, the elevated copy would take its
	// own account's default (another person's AppData when IT types an admin password) - and it
	// refuses an empty folder
	if j.Kind == "install" && j.Opts.Dir == "" {
		j.Opts.Dir = defaultDir(j.Opts.Scope)
	}
	return runElevated(j, prog)
}

func needsElevation(dir string, scope string) bool {
	if isElevated() {
		return false
	}
	return scope == "machine" || !canWrite(dir)
}

func main() {
	initLog()
	// not from the folder it was started in: Windows can't remove a folder that is any program's
	// current folder (the uninstaller started from the app folder, and the window's own helpers)
	_ = os.Chdir(os.TempDir())
	self, err := os.Executable()
	if err != nil {
		fatal("Can't find the setup program: " + err.Error())
	}
	p, err := openPayload(self)
	if err != nil {
		fatal(err.Error())
	}
	fs := flag.NewFlagSet("setup", flag.ContinueOnError)
	var (
		silent    = fs.Bool("silent", false, "")
		allUsers  = fs.Bool("all-users", false, "")
		dir       = fs.String("dir", "", "")
		noDesktop = fs.Bool("no-desktop", false, "")
		data      = fs.String("data", "", "")
		uninstall = fs.Bool("uninstall", false, "")
		worker    = fs.String("worker", "", "")
		jobSHA    = fs.String("job-sha", "", "")
		plain     = fs.Bool("plain", false, "")
	)
	fs.SetOutput(nopWriter{})
	if err := fs.Parse(os.Args[1:]); err != nil || fs.NArg() > 0 {
		if !p.present {
			// the uninstaller copy started with options it doesn't know: does nothing (never a silent uninstall)
			logf("unknown options %q: nothing to do", os.Args[1:])
			os.Exit(2)
		}
		fatal("Unknown option: " + strings.Join(os.Args[1:], " "))
	}
	plainUI = *plain
	logf("start %s %q payload=%v elevated=%v", version, os.Args[1:], p.present, isElevated())
	cleanTemp(self)
	switch {
	case *worker != "":
		// the open setup's own admin step: it doesn't wait for the one-setup lock below (that setup
		// holds it)
		os.Exit(runWorker(p, *worker, *jobSHA))
	case !p.present && !*uninstall && !looksInstalled(filepath.Dir(self)):
		// a setup file without its app part (cut short when copied, damaged, changed afterwards): it
		// says so and fails - it never turns into the uninstaller of whatever is installed
		logf("no payload, not in an install folder: the setup file is incomplete or damaged")
		if !*silent {
			messageBox("This setup file is incomplete or damaged (the app part is missing) - it may not have been copied completely. Get it again from where you got it.", mbWarn)
		}
		os.Exit(1)
	case !p.present && !*uninstall && len(os.Args) > 1:
		// the uninstaller copy started with options other than --uninstall: do nothing
		logf("no payload and no --uninstall: nothing to do")
		os.Exit(2)
	}
	// one setup at a time - installing or removing, window or silent: two at once would replace and
	// delete the same folder under each other. Another one open: it is brought forward, this one does
	// nothing (exit 2).
	if !singleInstance(*silent) {
		os.Exit(2)
	}
	switch {
	case *uninstall || !p.present:
		d := *dir
		if d == "" {
			d = filepath.Dir(self)
			// only the setup itself (setup.exe --uninstall) looks the install up; the uninstaller in an
			// app folder removes that folder's install and nothing else
			if p.present && !looksInstalled(d) {
				if found, _ := findInstalled(); found != "" {
					d = found
				}
			}
		}
		os.Exit(cmdUninstall(self, d, *silent))
	case *silent:
		o := Options{Scope: "user", Dir: *dir, Desktop: !*noDesktop, DataRoot: strings.TrimSpace(*data)}
		if *allUsers {
			o.Scope = "machine"
		}
		if o.DataRoot != "" && !filepath.IsAbs(o.DataRoot) && !strings.HasPrefix(o.DataRoot, `\\`) {
			logf("silent install: --data needs a full path (%q)", o.DataRoot)
			os.Exit(1)
		}
		if o.Dir == "" {
			if found, ii := findInstalled(); found != "" && ii != nil && ii.Scope == o.Scope {
				o.Dir = found
			}
		}
		// over an install: it stays what it is (for one person / for everyone)
		if ii, err := readInstall(orDefault(o.Dir, o.Scope)); err == nil && looksInstalled(orDefault(o.Dir, o.Scope)) && ii.Scope != o.Scope {
			logf("silent install: %s is installed for %s - kept so", orDefault(o.Dir, o.Scope), ii.Scope)
			o.Scope = ii.Scope
		}
		// the shared folder the setup was started from - for a new install; an install keeps its own
		// unless --data says otherwise
		if o.DataRoot == "" && !looksInstalled(orDefault(o.Dir, o.Scope)) {
			o.DataRoot = detectDataRoot(self)
		}
		if o.Dir != "" {
			if msg := checkDir(o.Scope, o.Dir); msg != "" {
				logf("silent install: %s", msg)
				os.Exit(1)
			}
		}
		err := runAs(p, Job{Kind: "install", Opts: o}, needsElevation(orDefault(o.Dir, o.Scope), o.Scope), func(float64, string) {})
		switch {
		case err == nil:
			os.Exit(0)
		case errors.Is(err, errNewer):
			logf("silent install: %v", err)
			os.Exit(4)
		case errors.Is(err, errRunning):
			logf("silent install: %v", err)
			os.Exit(3)
		}
		logf("silent install failed: %v", err)
		os.Exit(1)
	default:
		os.Exit(cmdInstall(p, self))
	}
}

type nopWriter struct{}

func (nopWriter) Write(b []byte) (int, error) { return len(b), nil }

// cleanTemp removes temporary uninstaller copies left by earlier runs (a program can't delete
// itself; the next run tidies up).
func cleanTemp(self string) {
	old, _ := filepath.Glob(filepath.Join(os.TempDir(), "Goldline Takeoff Uninstall *.exe"))
	for _, f := range old {
		if !strings.EqualFold(f, self) {
			if fi, err := os.Stat(f); err == nil && time.Since(fi.ModTime()) > time.Minute {
				_ = os.Remove(f)
			}
		}
	}
}

func orDefault(dir, scope string) string {
	if dir == "" {
		return defaultDir(scope)
	}
	return dir
}

// detectDataRoot: the setup started from the shared folder's releases (<shared folder>\_releases,
// where the app's updates are published)? Then that shared folder is the one offered to the app - as
// \\server\share\..., not a drive letter (a drive letter may differ from PC to PC).
func detectDataRoot(self string) string {
	d := filepath.Dir(self)
	if strings.EqualFold(filepath.Base(d), "_releases") && fileExists(filepath.Join(d, "latest.json")) {
		return toUNC(filepath.Dir(d))
	}
	return ""
}

// cmdUninstall removes the install in dir. It runs where it is (often from inside dir: it moves itself
// out of the folder before deleting it) - it never starts a copy of itself from the temp folder, which
// company antivirus may stop.
func cmdUninstall(self, dir string, silent bool) int {
	if !looksInstalled(dir) {
		if !silent {
			messageBox("Goldline Takeoff isn't installed here:\n"+dir, mbInfo)
		}
		return 2
	}
	ii, _ := readInstall(dir)
	scope := "user"
	if ii != nil && ii.Scope != "" {
		scope = ii.Scope
	}
	if silent {
		if err := runAs(nil, Job{Kind: "uninstall", Dir: dir}, needsElevation(dir, scope), func(float64, string) {}); err != nil {
			logf("silent uninstall failed: %v", err)
			if errors.Is(err, errRunning) {
				return 3
			}
			return 1
		}
		return 0
	}
	return uninstallUI(dir, scope)
}

func cmdInstall(p *Payload, self string) int {
	st := installState(p, self)
	return installUI(p, st)
}

// UIState is what the window starts with.
type UIState struct {
	Mode     string            `json:"mode"` // install | uninstall
	Version  string            `json:"version"`
	Existing *Existing         `json:"existing"`
	Dirs     map[string]string `json:"dirs"`
	DataRoot string            `json:"dataRoot"` // found by the setup (started from the shared folder)
	Opts     Options           `json:"opts"`
	Pending  int               `json:"pending"` // uninstall: unsent changes on this PC
}

type Existing struct {
	Version string `json:"version"`
	Dir     string `json:"dir"`
	Scope   string `json:"scope"`
	Newer   bool   `json:"newer"` // newer than this setup: not replaced
	Older   bool   `json:"older"` // a copy made by hand (no install record)
}

func installState(p *Payload, self string) UIState {
	st := UIState{Mode: "install", Version: p.Meta.Version, Dirs: map[string]string{"user": defaultDir("user"), "machine": defaultDir("machine")}}
	st.DataRoot = detectDataRoot(self)
	st.Opts = Options{Scope: "user", Dir: st.Dirs["user"], Desktop: true, DataRoot: st.DataRoot}
	existing := func(dir, scope string, older bool, desktop bool) {
		v := installedVersion(dir)
		var d Defaults
		for _, f := range []string{filepath.Join(dir, "defaults.json"), filepath.Join(dir, "resources", "app", "defaults.json")} {
			if readLooseJSON(f, &d) == nil && strings.TrimSpace(d.DataRoot) != "" {
				break
			}
		}
		st.Existing = &Existing{Version: v, Dir: dir, Scope: scope, Older: older, Newer: v != "" && cmpVersion(v, p.Meta.Version) > 0}
		st.Opts = Options{Scope: scope, Dir: dir, Desktop: desktop, DataRoot: strings.TrimSpace(d.DataRoot)}
		// the shared folder this install already has stays offered; the one the setup was started
		// from only when it has none
		if st.Opts.DataRoot == "" {
			st.Opts.DataRoot = st.DataRoot
		}
	}
	if dir, ii := findInstalled(); dir != "" && ii != nil {
		existing(dir, ii.Scope, false, ii.Desktop)
	} else {
		// no install of the setup's own, but a copy made by hand in a usual place: offered as the one to
		// update (same folder), so there aren't two copies side by side
		for _, sc := range []string{"machine", "user"} {
			if v := olderCopy(st.Dirs[sc]); v != "" {
				existing(st.Dirs[sc], sc, true, true)
				logf("older copy %s found in %s", v, st.Dirs[sc])
				break
			}
		}
	}
	return st
}

// checkDir: can the chosen folder be used? (message for the window)
func checkDir(scope, dir string) string {
	d := strings.TrimSpace(dir)
	if d == "" || !filepath.IsAbs(d) {
		return "Enter a full folder path, like C:\\Apps\\Goldline Takeoff."
	}
	if onNetwork(d) {
		return "Install on this PC, not on a network folder."
	}
	if filepath.Dir(filepath.Clean(d)) == filepath.Clean(d) {
		return "Choose a folder, not a whole drive."
	}
	ours := looksInstalled(d) || olderCopy(d) != ""
	// the app's own files go up to ~90 characters deeper (resources\app\versions\<v>\dist\assets\...),
	// its self-updates ~16 more; past Windows' 260-character limit programs (the app included) can
	// fail to open them. An install already there stays updatable where it is.
	if n := len(utf16.Encode([]rune(filepath.Clean(d)))); n > maxDirLen && !ours {
		return fmt.Sprintf("That folder path is too long (%d characters). Choose a shorter one, at most %d characters, like C:\\Apps\\Goldline Takeoff.", n, maxDirLen)
	}
	if scope == "machine" {
		if msg := everyoneDirMsg(d); msg != "" {
			return msg
		}
	}
	if fileExists(d) && !ours {
		if entries, err := os.ReadDir(d); err == nil && len(entries) > 0 {
			return "That folder has other files in it. Choose an empty or new one."
		}
	}
	if scope == "user" && !isElevated() && !canWrite(d) {
		return "That folder needs admin rights. Choose another, or install for everyone."
	}
	return ""
}

// maxDirLen: the longest install folder path (characters) - see checkDir
const maxDirLen = 150

// everyoneDirMsg: an install for everyone goes inside Program Files ("" = fine). Anywhere else the
// folder takes its permissions from the folder above it - on C:\ or D:\ every user of the PC may
// change files in new folders - so one user could replace the app's program or code and it would run
// for the next person who starts it, administrators included. Inside Program Files only
// administrators can change anything. (Just for one person, any folder of theirs is fine: only they
// run it.)
func everyoneDirMsg(dir string) string {
	pf := programFilesDir()
	if insideFolder(dir, pf) {
		return ""
	}
	d := filepath.Clean(strings.TrimSpace(dir))
	if looksInstalled(d) {
		// put there by an earlier setup (before 0.15): not updated in place
		return "Goldline Takeoff is installed for everyone in " + d + ", outside " + pf + ", where other people using this PC could change its files. Remove it (Settings > Apps), then run this setup again: for everyone it now goes into " + pf + "."
	}
	return "For everyone on this PC, choose a folder inside " + pf + " - only there are the app's files safe from changes by other people using this PC. Or install it just for you."
}

// insideFolder: d is a folder inside parent (not parent itself), with Windows' any-case comparison.
func insideFolder(d, parent string) bool {
	d, parent = filepath.Clean(strings.TrimSpace(d)), filepath.Clean(parent)
	if parent == "." || isRootish(parent) || len(d) <= len(parent)+1 {
		return false
	}
	return strings.EqualFold(d[:len(parent)], parent) && os.IsPathSeparator(d[len(parent)])
}

// checkData: a word on the shared folder chosen (for the window; "" = fine or empty).
func checkData(d string) string {
	d = strings.TrimSpace(d)
	if d == "" {
		return ""
	}
	if !filepath.IsAbs(d) && !strings.HasPrefix(d, `\\`) {
		return "Enter the full path of the shared folder, like \\\\server\\share\\Goldline Takeoff."
	}
	if !fileExists(d) {
		return "That folder can't be reached from this PC right now. It is used anyway: the app asks again if it still can't reach it."
	}
	return ""
}

func fatal(msg string) {
	logf("fatal: %s", msg)
	messageBox(msg, mbError)
	os.Exit(1)
}
