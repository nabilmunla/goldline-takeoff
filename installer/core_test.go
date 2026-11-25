//go:build !windows

package main

import (
	"archive/tar"
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/klauspost/compress/zstd"
)

// fakeSetup writes an "exe" with a payload holding files (path -> content).
func fakeSetup(t *testing.T, dir, ver string, files map[string]string) string {
	t.Helper()
	var tb bytes.Buffer
	tw := tar.NewWriter(&tb)
	var total int64
	for name, body := range files {
		_ = tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg})
		_, _ = tw.Write([]byte(body))
		total += int64(len(body))
	}
	tw.Close()
	var zb bytes.Buffer
	zw, _ := zstd.NewWriter(&zb)
	_, _ = zw.Write(tb.Bytes())
	zw.Close()
	sum := sha256.Sum256(zb.Bytes())
	meta, _ := json.Marshal(Meta{Version: ver, Runtime: "44.5.1", Total: total, Files: len(files), SHA256: hex.EncodeToString(sum[:])})
	exe := []byte("MZ-this-is-the-program-part")
	var out bytes.Buffer
	out.Write(exe)
	out.Write(zb.Bytes())
	out.Write(meta)
	n := make([]byte, 8)
	binary.LittleEndian.PutUint64(n, uint64(len(meta)))
	out.Write(n)
	binary.LittleEndian.PutUint64(n, uint64(zb.Len()))
	out.Write(n)
	out.WriteString(magic)
	p := filepath.Join(dir, "setup-"+ver+".exe")
	if err := os.WriteFile(p, out.Bytes(), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

// appFiles: what make-payload's resources-app zip holds (versioned layout) + the runtime
func appFiles(ver string) map[string]string {
	v := "resources/app/versions/" + ver + "/"
	return map[string]string{
		exeName:                      "electron",
		"locales/en-US.pak":          "pak",
		"resources/app/boot.cjs":     "const BOOT_REV = 2; // starter",
		"resources/app/package.json": `{"productName":"Goldline Takeoff","version":"` + ver + `","main":"boot.cjs"}`,
		"resources/app/current.json": `{"version":"` + ver + `","previous":null,"bad":[]}`,
		v + "package.json":           `{"version":"` + ver + `","main":"electron/main.cjs"}`,
		v + "electron/main.cjs":      "main " + ver,
		v + "electron/preload.cjs":   "preload",
		v + "electron/boot.cjs":      "const BOOT_REV = 2;",
		v + "dist/index.html":        "<html>" + ver,
	}
}

func read(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func setupTest(t *testing.T) string {
	root := t.TempDir()
	testRoot = root
	logPath = filepath.Join(root, "setup.log")
	testCalls = nil
	testRegistry = map[string]string{}
	testElevated, testPayload = nil, nil
	return root
}

func nop(float64, string) {}

func currentOf(t *testing.T, dir string) (string, string) {
	t.Helper()
	var c struct {
		Version  string  `json:"version"`
		Previous *string `json:"previous"`
	}
	if err := readJSON(filepath.Join(dir, "resources", "app", "current.json"), &c); err != nil {
		t.Fatal(err)
	}
	prev := ""
	if c.Previous != nil {
		prev = *c.Previous
	}
	return c.Version, prev
}

func TestInstallReinstallUpdateUninstall(t *testing.T) {
	root := setupTest(t)
	s1 := fakeSetup(t, root, "0.12.4", appFiles("0.12.4"))
	p, err := openPayload(s1)
	if err != nil || !p.present || p.Meta.Version != "0.12.4" {
		t.Fatalf("payload: %v %+v", err, p)
	}
	dir := filepath.Join(root, "Programs", appName)
	var last float64
	err = doInstall(p, Options{Scope: "user", Dir: dir, Desktop: true, DataRoot: `\\srv\tenders\Goldline Takeoff`}, func(pct float64, _ string) { last = pct })
	if err != nil {
		t.Fatal(err)
	}
	if last != 1 {
		t.Errorf("progress ended at %v", last)
	}
	if read(t, filepath.Join(dir, "resources/app/versions/0.12.4/dist/index.html")) != "<html>0.12.4" {
		t.Error("files not extracted")
	}
	if v, prev := currentOf(t, dir); v != "0.12.4" || prev != "" {
		t.Errorf("current.json: %s / %s", v, prev)
	}
	// the uninstaller is the program part only, without the app
	if read(t, filepath.Join(dir, uninstallName)) != "MZ-this-is-the-program-part" {
		t.Error("the uninstaller should be the exe part without the payload")
	}
	if hp, _ := openPayload(filepath.Join(dir, uninstallName)); hp.present {
		t.Error("the uninstaller must not hold the app")
	}
	var d Defaults
	if readJSON(filepath.Join(dir, "defaults.json"), &d); d.DataRoot != `\\srv\tenders\Goldline Takeoff` {
		t.Errorf("defaults.json: %+v", d)
	}
	ii, _ := readInstall(dir)
	if ii == nil || ii.Version != "0.12.4" || ii.Scope != "user" || !ii.Desktop || ii.Runtime != "44.5.1" {
		t.Errorf("install.json: %+v", ii)
	}

	// the app updated itself to 0.12.5 since (what electron/updater.cjs leaves): a version folder,
	// current.json pointing at it, a newer starter
	upd := filepath.Join(dir, "resources", "app")
	for f, body := range appFiles("0.12.5") {
		if strings.HasPrefix(f, "resources/app/versions/") {
			os.MkdirAll(filepath.Dir(filepath.Join(dir, f)), 0o755)
			os.WriteFile(filepath.Join(dir, f), []byte(body), 0o644)
		}
	}
	os.WriteFile(filepath.Join(upd, "current.json"), []byte(`{"version":"0.12.5","previous":"0.12.4","bad":[]}`), 0o644)
	os.WriteFile(filepath.Join(upd, "boot.cjs"), []byte("const BOOT_REV = 3; // newer starter"), 0o644)
	if v := installedVersion(dir); v != "0.12.5" {
		t.Fatalf("installed version %q", v)
	}

	// the 0.12.4 setup again: refused (it would take 0.12.5 away)
	err = doInstall(p, Options{Scope: "user", Dir: dir}, nop)
	if !errors.Is(err, errNewer) {
		t.Fatalf("an older setup over a newer app must be refused: %v", err)
	}
	if v, _ := currentOf(t, dir); v != "0.12.5" {
		t.Error("the refused install changed the app")
	}

	// a 0.13.0 setup (new runtime): replaces the folder, keeps 0.12.5 as the way back and the newer
	// starter, keeps the shared folder already set
	s2 := fakeSetup(t, root, "0.13.0", appFiles("0.13.0"))
	p2, _ := openPayload(s2)
	if err := doInstall(p2, Options{Scope: "user", Dir: dir, Desktop: true}, nop); err != nil {
		t.Fatal(err)
	}
	if v, prev := currentOf(t, dir); v != "0.13.0" || prev != "0.12.5" {
		t.Errorf("after the setup: current %s previous %s", v, prev)
	}
	if !startableVersion(upd, "0.12.5") || startableVersion(upd, "0.12.4") {
		t.Error("the version that ran before stays (and only that one)")
	}
	if !strings.Contains(read(t, filepath.Join(upd, "boot.cjs")), "BOOT_REV = 3") {
		t.Error("the newer starter was replaced by an older one")
	}
	if readJSON(filepath.Join(dir, "defaults.json"), &d); d.DataRoot != `\\srv\tenders\Goldline Takeoff` {
		t.Errorf("the shared folder set before was lost: %+v", d)
	}
	if left, _ := filepath.Glob(globEscape(dir) + swapTag + "*"); len(left) > 0 {
		t.Errorf("left behind: %v", left)
	}
	// the same setup again (repair): fine, no "previous" of its own version
	if err := doInstall(p2, Options{Scope: "user", Dir: dir, Desktop: true}, nop); err != nil {
		t.Fatal(err)
	}
	if v, prev := currentOf(t, dir); v != "0.13.0" || prev != "" {
		t.Errorf("reinstall: current %s previous %q", v, prev)
	}

	// open: refused, nothing changed (after waiting for it to end - shortened here)
	appGoneWait = 1200 * time.Millisecond
	defer func() { appGoneWait = 30 * time.Second }()
	os.WriteFile(filepath.Join(dir, exeName+".running"), nil, 0o644)
	t0 := time.Now()
	if err := doInstall(p2, Options{Scope: "user", Dir: dir}, nop); !errors.Is(err, errRunning) {
		t.Errorf("install while open: %v", err)
	}
	if time.Since(t0) < time.Second {
		t.Errorf("install while open: refused without waiting for the app to end (%v)", time.Since(t0))
	}
	if err := doUninstall(dir, nop); !errors.Is(err, errRunning) {
		t.Errorf("uninstall while open: %v", err)
	}
	os.Remove(filepath.Join(dir, exeName+".running"))

	// closed a moment ago, its last process still ending (0.16.0, PDF Editor 0.8.7's race): the setup
	// waits for it instead of saying "Goldline Takeoff is open"
	os.WriteFile(filepath.Join(dir, exeName+".running"), nil, 0o644)
	go func() { time.Sleep(600 * time.Millisecond); os.Remove(filepath.Join(dir, exeName+".running")) }()
	if err := doInstall(p2, Options{Scope: "user", Dir: dir}, nop); err != nil {
		t.Errorf("install just after the app closed: %v", err)
	}

	// uninstall removes the folder
	if err := doUninstall(dir, nop); err != nil {
		t.Fatal(err)
	}
	if fileExists(dir) {
		t.Error("folder still there")
	}
}

func TestEveryoneInstallsLikeTheRest(t *testing.T) {
	root := setupTest(t)
	p, _ := openPayload(fakeSetup(t, root, "0.12.4", appFiles("0.12.4")))
	// (for everyone only inside Program Files - the stand-in's is <root>\machine)
	dir := filepath.Join(programFilesDir(), appName)
	if err := doInstall(p, Options{Scope: "machine", Dir: dir}, nop); err != nil {
		t.Fatal(err)
	}
	if ii, _ := readInstall(dir); ii == nil || ii.Scope != "machine" {
		t.Errorf("install.json: %+v", ii)
	}
}

func TestNeverDeletesOtherFolders(t *testing.T) {
	root := setupTest(t)
	docs := filepath.Join(root, "Documents")
	os.MkdirAll(docs, 0o755)
	os.WriteFile(filepath.Join(docs, "tender.xlsx"), []byte("x"), 0o644)
	if err := doUninstall(docs, nop); err == nil {
		t.Error("uninstall must refuse a folder that isn't an install")
	}
	p, _ := openPayload(fakeSetup(t, root, "0.12.4", appFiles("0.12.4")))
	if err := doInstall(p, Options{Scope: "user", Dir: docs}, nop); err == nil {
		t.Error("install must refuse a folder with other files")
	}
	if read(t, filepath.Join(docs, "tender.xlsx")) != "x" {
		t.Error("the person's file was touched")
	}
	if msg := checkDir("user", docs); msg == "" {
		t.Error("checkDir should warn about a folder with other files")
	}
	if msg := checkDir("user", "relative\\path"); msg == "" {
		t.Error("checkDir should want a full path")
	}
	if msg := checkDir("user", `\\server\share\Goldline Takeoff`); msg == "" {
		t.Error("checkDir should refuse a network folder")
	}
	// 0.23.2 (DeepSeek #6): a drive letter mapped to a share is a network folder too
	net := filepath.Join(testRoot, "netdrive", "Goldline Takeoff")
	if msg := checkDir("user", net); !strings.Contains(msg, "network") {
		t.Errorf("checkDir should refuse a mapped network drive, said %q", msg)
	}
	if looksInstalled(filepath.VolumeName(root) + string(os.PathSeparator)) {
		t.Error("a drive root is never an install")
	}
}

func TestSafeRelAndVersions(t *testing.T) {
	for _, bad := range []string{"../x", "a/../../x", "/etc/passwd", "C:/Windows/x"} {
		if _, err := safeRel(bad); err == nil {
			t.Errorf("%s should be refused", bad)
		}
	}
	if r, _ := safeRel("./resources/app/x.js"); r != filepath.FromSlash("resources/app/x.js") {
		t.Errorf("got %s", r)
	}
	less := [][2]string{{"0.3.9", "0.3.10"}, {"0.12.4", "0.12.5"}, {"0.9", "1.0.0"}, {"1.2.3", "1.10.0"}, {"0.13.0-rc1", "0.13.0"}, {"0.13.0-rc1", "0.13.0-rc2"}}
	for _, c := range less {
		if cmpVersion(c[0], c[1]) != -1 || cmpVersion(c[1], c[0]) != 1 {
			t.Errorf("%s < %s", c[0], c[1])
		}
	}
	if cmpVersion("0.12.4", "0.12.4") != 0 {
		t.Error("equal")
	}
}

func TestDamagedSetup(t *testing.T) {
	root := setupTest(t)
	s := fakeSetup(t, root, "0.12.4", appFiles("0.12.4"))
	b, _ := os.ReadFile(s)
	// cut a chunk out of the middle of the payload
	cut := append(append([]byte{}, b[:40]...), b[60:]...)
	os.WriteFile(s, cut, 0o755)
	p, err := openPayload(s)
	dir := filepath.Join(root, "Programs", appName)
	if err == nil && p.present {
		if err := doInstall(p, Options{Scope: "user", Dir: dir}, nop); err == nil {
			t.Error("install from a damaged setup should fail")
		}
		if fileExists(dir) {
			t.Error("a failed install must leave nothing behind")
		}
	}
	if left, _ := filepath.Glob(globEscape(dir) + swapTag + "*"); len(left) > 0 {
		t.Errorf("left behind: %v", left)
	}
	// a payload without the app's version folder (built wrong): refused, nothing left
	files := appFiles("0.12.4")
	delete(files, "resources/app/versions/0.12.4/electron/main.cjs")
	p2, _ := openPayload(fakeSetup(t, root, "0.12.4", files))
	if err := doInstall(p2, Options{Scope: "user", Dir: dir}, nop); err == nil || fileExists(dir) {
		t.Errorf("an incomplete app must not be installed: %v", err)
	}
}

func TestReplaceKeepsOldOnFailure(t *testing.T) {
	root := setupTest(t)
	dir := filepath.Join(root, "app")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "a"), []byte("old"), 0o644)
	err := replaceDir(dir, func(tmp, old string) error { os.MkdirAll(tmp, 0o755); return os.ErrInvalid })
	if err == nil || read(t, filepath.Join(dir, "a")) != "old" {
		t.Error("a failed fill must keep the old folder")
	}
	err = replaceDir(dir, func(tmp, old string) error {
		if old != dir {
			t.Errorf("fill was not told the old folder: %q", old)
		}
		os.MkdirAll(tmp, 0o755)
		return os.WriteFile(filepath.Join(tmp, "b"), []byte("new"), 0o644)
	})
	if err != nil || read(t, filepath.Join(dir, "b")) != "new" || fileExists(filepath.Join(dir, "a")) {
		t.Errorf("replace: %v", err)
	}
}

// a minimal PE header: e_lfanew at 0x3c -> "PE\0\0", COFF header, PE32+ optional header with the
// certificate table entry (data directory 4)
func peHeader() ([]byte, int) {
	h := make([]byte, 0x200)
	h[0], h[1] = 'M', 'Z'
	binary.LittleEndian.PutUint32(h[0x3c:], 0x80)
	copy(h[0x80:], "PE\x00\x00")
	opt := 0x80 + 4 + 20
	binary.LittleEndian.PutUint16(h[opt:], 0x20b)
	return h, opt + 112 + 4*8
}

func TestSignedSetupStillFindsItsPayload(t *testing.T) {
	root := setupTest(t)
	plain := fakeSetup(t, root, "1.0.0", appFiles("1.0.0"))
	body, _ := os.ReadFile(plain)
	hdr, at := peHeader()
	exe := append(append([]byte{}, hdr...), body...)
	for len(exe)%8 != 0 {
		exe = append(exe, 0)
	}
	cert := bytes.Repeat([]byte{0xA5}, 1500)
	binary.LittleEndian.PutUint32(exe[at:], uint32(len(exe)))
	binary.LittleEndian.PutUint32(exe[at+4:], uint32(len(cert)))
	exe = append(exe, cert...)
	signed := filepath.Join(root, "signed.exe")
	os.WriteFile(signed, exe, 0o755)
	p, err := openPayload(signed)
	if err != nil || !p.present || p.Meta.Version != "1.0.0" {
		t.Fatalf("signed setup: payload not found (%v, %+v)", err, p)
	}
	dir := filepath.Join(root, "inst")
	if err := doInstall(p, Options{Scope: "user", Dir: dir}, nop); err != nil {
		t.Fatal(err)
	}
	h, _ := os.ReadFile(filepath.Join(dir, uninstallName))
	if binary.LittleEndian.Uint64(h[at:]) != 0 {
		t.Error("the uninstaller copy still points at a signature it doesn't have")
	}
	if q, _ := openPayload(filepath.Join(dir, uninstallName)); q == nil || q.present {
		t.Error("the uninstaller copy must have no payload")
	}
}

func TestSwapLeavesNeighboursAlone(t *testing.T) {
	root := setupTest(t)
	dir := filepath.Join(root, "Work")
	for _, n := range []string{"Work.old", "Work.new"} {
		os.MkdirAll(filepath.Join(root, n), 0o755)
		os.WriteFile(filepath.Join(root, n, "mine.txt"), []byte("keep"), 0o644)
	}
	p, _ := openPayload(fakeSetup(t, root, "1.0.0", appFiles("1.0.0")))
	if err := doInstall(p, Options{Scope: "user", Dir: dir}, nop); err != nil {
		t.Fatal(err)
	}
	if err := doInstall(p, Options{Scope: "user", Dir: dir}, nop); err != nil {
		t.Fatal(err)
	}
	if err := doUninstall(dir, nop); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"Work.old", "Work.new"} {
		if read(t, filepath.Join(root, n, "mine.txt")) != "keep" {
			t.Errorf("%s was touched", n)
		}
	}
}

func TestInstallFilesAreInBeforeTheSwap(t *testing.T) {
	root := setupTest(t)
	dir := filepath.Join(root, "inst")
	p, _ := openPayload(fakeSetup(t, root, "1.0.0", appFiles("1.0.0")))
	// the swap is the last step of the fill: watch what the new folder holds when it appears
	var seen []string
	if err := doInstall(p, Options{Scope: "user", Dir: dir, DataRoot: `\\server\share`}, func(pct float64, stage string) {
		if pct >= 0.92 && seen == nil {
			for _, f := range []string{"install.json", "defaults.json", uninstallName, "resources/app/current.json"} {
				if fileExists(filepath.Join(dir, filepath.FromSlash(f))) {
					seen = append(seen, f)
				}
			}
		}
	}); err != nil {
		t.Fatal(err)
	}
	if len(seen) != 4 {
		t.Errorf("when the folder appeared it held only %v", seen)
	}
}

func TestOlderHandMadeCopyIsReplaced(t *testing.T) {
	root := setupTest(t)
	// a portable copy of 0.12.3 (versioned layout, no install.json) in the per-user folder
	old := filepath.Join(root, "user", appName)
	for f, body := range appFiles("0.12.3") {
		os.MkdirAll(filepath.Dir(filepath.Join(old, f)), 0o755)
		os.WriteFile(filepath.Join(old, f), []byte(body), 0o644)
	}
	os.WriteFile(filepath.Join(old, "defaults.json"), []byte("\ufeff"+`{"dataRoot":"S:\\Projects\\Test Land"}`), 0o644)
	if v := olderCopy(old); v != "0.12.3" {
		t.Fatalf("older copy not recognised: %q", v)
	}
	if msg := checkDir("user", old); msg != "" {
		t.Fatalf("checkDir refused the older copy: %s", msg)
	}
	st := installState(&Payload{Meta: Meta{Version: "0.12.4"}, present: true}, filepath.Join(root, "Downloads", "setup.exe"))
	if st.Existing == nil || st.Existing.Version != "0.12.3" || !st.Existing.Older || st.Opts.Dir != old || st.Opts.DataRoot != `S:\Projects\Test Land` {
		t.Fatalf("the hand-made copy is offered for the update: %+v %+v", st.Existing, st.Opts)
	}
	p, _ := openPayload(fakeSetup(t, root, "0.12.4", appFiles("0.12.4")))
	if err := doInstall(p, st.Opts, nop); err != nil {
		t.Fatal(err)
	}
	if !looksInstalled(old) {
		t.Error("the older copy was not replaced by an install")
	}
	if v, prev := currentOf(t, old); v != "0.12.4" || prev != "0.12.3" {
		t.Errorf("current %s previous %s", v, prev)
	}
	// anything that only looks a bit like it is still refused
	other := filepath.Join(root, "Tools")
	os.MkdirAll(filepath.Join(other, "resources", "app"), 0o755)
	os.WriteFile(filepath.Join(other, exeName), []byte("x"), 0o755)
	os.WriteFile(filepath.Join(other, "resources", "app", "package.json"), []byte(`{"productName":"Something else","main":"main.js"}`), 0o644)
	if olderCopy(other) != "" || checkDir("user", other) == "" {
		t.Error("a different program's folder must not count as an older copy")
	}
	if err := doInstall(p, Options{Scope: "user", Dir: other}, nop); err == nil {
		t.Error("installing over a different program's folder must be refused")
	}
}

func TestDataRootFromTheReleasesFolder(t *testing.T) {
	root := setupTest(t)
	rel := filepath.Join(root, "share", "Goldline Takeoff", "_releases")
	os.MkdirAll(rel, 0o755)
	self := filepath.Join(rel, "Goldline Takeoff Setup 0.12.4.exe")
	if d := detectDataRoot(self); d != "" {
		t.Errorf("no latest.json: no shared folder (%q)", d)
	}
	os.WriteFile(filepath.Join(rel, "latest.json"), []byte("{}"), 0o644)
	if d := detectDataRoot(self); d != filepath.Join(root, "share", "Goldline Takeoff") {
		t.Errorf("shared folder %q", d)
	}
	if d := detectDataRoot(filepath.Join(root, "Downloads", "setup.exe")); d != "" {
		t.Errorf("anywhere else: none (%q)", d)
	}
	if checkData(filepath.Join(root, "nope")) == "" || checkData(filepath.Join(root, "share")) != "" || checkData("") != "" {
		t.Error("checkData")
	}
}

func TestUserDataKeptWithUnsentChanges(t *testing.T) {
	root := setupTest(t)
	data := userDataDirs()[0]
	ob := filepath.Join(data, "data", "profile-default", "outbox", "proj_abc")
	os.MkdirAll(ob, 0o755)
	os.WriteFile(filepath.Join(data, "data", "profile-default", "settings.json"), []byte("{}"), 0o644)
	os.WriteFile(filepath.Join(ob, "PC1~w.log"), []byte(""), 0o644)
	if pendingChanges(data) != 0 {
		t.Error("an empty outbox file is nothing waiting")
	}
	os.WriteFile(filepath.Join(ob, "PC1~w.log"), []byte(`{"s":"1"}`+"\n"), 0o644)
	if kept := removeUserData(); kept != 1 || !fileExists(filepath.Join(data, "data", "profile-default", "settings.json")) {
		t.Errorf("data with unsent changes must stay (kept %d)", kept)
	}
	os.WriteFile(filepath.Join(ob, "PC1~w.log"), []byte(""), 0o644)
	if kept := removeUserData(); kept != 0 || fileExists(data) {
		t.Error("data without unsent changes is removed when asked")
	}
	_ = root
}

func TestUninstallMovesItsOwnProgramOut(t *testing.T) {
	root := setupTest(t)
	p, _ := openPayload(fakeSetup(t, root, "0.12.4", appFiles("0.12.4")))
	dir := filepath.Join(root, "inst")
	if err := doInstall(p, Options{Scope: "user", Dir: dir}, nop); err != nil {
		t.Fatal(err)
	}
	before, _ := filepath.Glob(filepath.Join(os.TempDir(), "Goldline Takeoff Uninstall *.exe"))
	if err := doUninstall(dir, nop); err != nil || fileExists(dir) {
		t.Fatalf("uninstall: %v", err)
	}
	after, _ := filepath.Glob(filepath.Join(os.TempDir(), "Goldline Takeoff Uninstall *.exe"))
	if len(after) != len(before)+1 {
		t.Errorf("the uninstaller was not moved to the temp folder (%d -> %d)", len(before), len(after))
	}
	for _, f := range after {
		os.Remove(f)
	}
}

func TestInterruptedSwapNeverLosesTheApp(t *testing.T) {
	root := setupTest(t)
	p, _ := openPayload(fakeSetup(t, root, "0.12.4", appFiles("0.12.4")))
	dir := filepath.Join(root, "Programs", appName)
	if err := doInstall(p, Options{Scope: "user", Dir: dir, DataRoot: `\\srv\x`}, nop); err != nil {
		t.Fatal(err)
	}
	// the app updated itself to 0.12.6, then a later run stopped between the two renames of a swap:
	// the install folder is missing, the app is in <dir>.gtsetup-old-*, a half-filled new one beside it
	for f, body := range appFiles("0.12.6") {
		if strings.HasPrefix(f, "resources/app/versions/") {
			os.MkdirAll(filepath.Dir(filepath.Join(dir, f)), 0o755)
			os.WriteFile(filepath.Join(dir, f), []byte(body), 0o644)
		}
	}
	os.WriteFile(filepath.Join(dir, "resources", "app", "current.json"), []byte(`{"version":"0.12.6","previous":"0.12.4","bad":[]}`), 0o644)
	os.Rename(dir, dir+swapTag+"old-abc")
	os.MkdirAll(dir+swapTag+"new-abd", 0o755)
	// the older setup runs again: the app is put back first, then the newer version is seen - refused
	if err := doInstall(p, Options{Scope: "user", Dir: dir}, nop); !errors.Is(err, errNewer) {
		t.Fatalf("expected the newer app to be found again: %v", err)
	}
	if v, _ := currentOf(t, dir); v != "0.12.6" {
		t.Errorf("the app was not put back: %s", v)
	}
	if left, _ := filepath.Glob(globEscape(dir) + swapTag + "*"); len(left) > 0 {
		t.Errorf("left behind: %v", left)
	}
	var d Defaults
	if readJSON(filepath.Join(dir, "defaults.json"), &d); d.DataRoot != `\\srv\x` {
		t.Error("the shared folder was lost")
	}
}

func TestLooseJSONAndVersionOrder(t *testing.T) {
	root := setupTest(t)
	f := filepath.Join(root, "current.json")
	// PowerShell 5 Out-File: UTF-16 LE with a BOM
	txt := `{"version":"0.12.4","previous":"0.12.3"}`
	b := []byte{0xff, 0xfe}
	for _, r := range txt {
		b = append(b, byte(r), 0)
	}
	os.WriteFile(f, b, 0o644)
	var c struct{ Version, Previous string }
	if err := readJSON(f, &c); err != nil || c.Version != "0.12.4" || c.Previous != "0.12.3" {
		t.Errorf("UTF-16: %v %+v", err, c)
	}
	// UTF-8 with a byte-order mark
	os.WriteFile(f, append([]byte{0xef, 0xbb, 0xbf}, txt...), 0o644)
	c.Version = ""
	if err := readJSON(f, &c); err != nil || c.Version != "0.12.4" {
		t.Errorf("UTF-8 BOM: %v %+v", err, c)
	}
	for _, x := range [][2]string{{"0.13.0-rc9", "0.13.0-rc10"}, {"0.13.0-beta2", "0.13.0-rc1"}, {"1.0.0-rc.2", "1.0.0-rc.11"}} {
		if cmpVersion(x[0], x[1]) != -1 || cmpVersion(x[1], x[0]) != 1 {
			t.Errorf("%s < %s", x[0], x[1])
		}
	}
}

func TestOneFolderCopyKeepsItsWayBack(t *testing.T) {
	root := setupTest(t)
	old := filepath.Join(root, "user", appName)
	files := map[string]string{
		exeName:                              "electron",
		"resources/app/package.json":         `{"productName":"Goldline Takeoff","version":"0.11.0","main":"electron/main.cjs"}`,
		"resources/app/electron/main.cjs":    "main 0.11",
		"resources/app/electron/preload.cjs": "preload",
		"resources/app/dist/index.html":      "<html>0.11",
		"resources/app/dist/assets/a.js":     "js",
		"resources/app/defaults.json":        `{"dataRoot":"S:\\Tenders"}`,
	}
	for f, body := range files {
		os.MkdirAll(filepath.Dir(filepath.Join(old, f)), 0o755)
		os.WriteFile(filepath.Join(old, f), []byte(body), 0o644)
	}
	if v := olderCopy(old); v != "0.11.0" {
		t.Fatalf("older copy %q", v)
	}
	p, _ := openPayload(fakeSetup(t, root, "0.12.4", appFiles("0.12.4")))
	if err := doInstall(p, Options{Scope: "user", Dir: old}, nop); err != nil {
		t.Fatal(err)
	}
	if v, prev := currentOf(t, old); v != "0.12.4" || prev != "0.11.0" {
		t.Errorf("current %s previous %s", v, prev)
	}
	if !startableVersion(filepath.Join(old, "resources", "app"), "0.11.0") || read(t, filepath.Join(old, "resources/app/versions/0.11.0/dist/assets/a.js")) != "js" {
		t.Error("the one-folder app is not kept as a version folder")
	}
	var d Defaults
	if readJSON(filepath.Join(old, "resources", "app", "defaults.json"), &d); d.DataRoot != `S:\Tenders` {
		t.Errorf("the shared folder in resources\\app\\defaults.json (where the app reads it too) was lost: %+v", d)
	}
}

func TestAnInstallMissingItsExeCanBeRepairedOrRemoved(t *testing.T) {
	root := setupTest(t)
	p, _ := openPayload(fakeSetup(t, root, "0.12.4", appFiles("0.12.4")))
	dir := filepath.Join(root, "inst")
	if err := doInstall(p, Options{Scope: "user", Dir: dir}, nop); err != nil {
		t.Fatal(err)
	}
	os.Remove(filepath.Join(dir, exeName)) // quarantined by an antivirus
	if !looksInstalled(dir) || checkDir("user", dir) != "" {
		t.Fatal("an install without its exe is still ours")
	}
	if err := doInstall(p, Options{Scope: "user", Dir: dir}, nop); err != nil || !fileExists(filepath.Join(dir, exeName)) {
		t.Fatalf("repair: %v", err)
	}
	os.Remove(filepath.Join(dir, exeName))
	if err := doUninstall(dir, nop); err != nil || fileExists(dir) {
		t.Errorf("remove: %v", err)
	}
	// install.json alone (anyone could write one) is not enough
	other := filepath.Join(root, "Documents")
	os.MkdirAll(other, 0o755)
	os.WriteFile(filepath.Join(other, "install.json"), []byte(`{"scope":"user"}`), 0o644)
	os.WriteFile(filepath.Join(other, "plan.xlsx"), []byte("x"), 0o644)
	if looksInstalled(other) || doUninstall(other, nop) == nil || !fileExists(filepath.Join(other, "plan.xlsx")) {
		t.Error("a folder with just an install.json must not count as an install")
	}
}

func TestOnlyTheDataFolderHoldsUnsentChanges(t *testing.T) {
	setupTest(t)
	data := userDataDirs()[0]
	// the store of downloaded copies (app\) sits next to data\: a .log there is not a queue of changes
	os.MkdirAll(filepath.Join(data, "app", "profile-x", "outbox", "p"), 0o755)
	os.WriteFile(filepath.Join(data, "app", "profile-x", "outbox", "p", "PC~w.log"), []byte("x\n"), 0o644)
	if n := pendingChanges(data); n != 0 {
		t.Errorf("something outside data\\ counted: %d", n)
	}
	// a queue already taken over by the app (renamed *.log.moved) is not waiting either
	ob := filepath.Join(data, "data", "profile-default", "outbox", "p")
	os.MkdirAll(ob, 0o755)
	os.WriteFile(filepath.Join(ob, "PC~w.log.moved"), []byte("x\n"), 0o644)
	if n := pendingChanges(data); n != 0 {
		t.Errorf("a taken-over queue counted: %d", n)
	}
	os.WriteFile(filepath.Join(ob, "PC~w.log"), []byte("x\n"), 0o644)
	if n := pendingChanges(data); n != 1 {
		t.Errorf("a waiting queue: %d", n)
	}
}

func TestReviewB(t *testing.T) {
	root := setupTest(t)
	p, _ := openPayload(fakeSetup(t, root, "0.12.4", appFiles("0.12.4")))
	// a byte changed in the payload: refused before anything changes
	b, _ := os.ReadFile(p.Path)
	bad := append([]byte{}, b...)
	bad[p.Off+p.Len/2] ^= 0xff
	bp := filepath.Join(root, "bad.exe")
	os.WriteFile(bp, bad, 0o755)
	q, err := openPayload(bp)
	dir := filepath.Join(root, "inst")
	if err == nil && q.present {
		if err := doInstall(q, Options{Scope: "user", Dir: dir}, nop); err == nil || !strings.Contains(err.Error(), "damaged") || fileExists(dir) {
			t.Errorf("a damaged payload: %v", err)
		}
	}

	// a two-letter folder is an install like any other (C:\GE itself: tests/wine-setup.sh)
	short := filepath.Join(root, "GE")
	if err := doInstall(p, Options{Scope: "user", Dir: short}, nop); err != nil {
		t.Fatal(err)
	}
	if !looksInstalled(short) || checkDir("user", short) != "" {
		t.Error("a short install folder is not recognised")
	}
	if err := doInstall(p, Options{Scope: "user", Dir: short}, nop); err != nil {
		t.Errorf("install again in a short folder: %v", err)
	}

	// a folder that merely has the two file names is not an install
	fake := filepath.Join(root, "Fake")
	os.MkdirAll(fake, 0o755)
	os.WriteFile(filepath.Join(fake, exeName), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(fake, "install.json"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(fake, "report.xlsx"), []byte("keep"), 0o644)
	if looksInstalled(fake) || doUninstall(fake, nop) == nil || doInstall(p, Options{Scope: "user", Dir: fake}, nop) == nil || read(t, filepath.Join(fake, "report.xlsx")) != "keep" {
		t.Error("a look-alike folder was treated as an install")
	}

	// a hand-written defaults.json (single backslashes, an extra setting) stays as it was
	os.WriteFile(filepath.Join(short, "defaults.json"), []byte(`{"dataRoot": "S:\Projects\Takeoff", "note": "IT"}`), 0o644)
	if err := doInstall(p, Options{Scope: "user", Dir: short}, nop); err != nil {
		t.Fatal(err)
	}
	if got := read(t, filepath.Join(short, "defaults.json")); got != `{"dataRoot": "S:\Projects\Takeoff", "note": "IT"}` {
		t.Errorf("defaults.json changed: %s", got)
	}
	// a new shared folder given: the other settings stay
	if err := doInstall(p, Options{Scope: "user", Dir: short, DataRoot: `\\srv\new`}, nop); err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if readJSON(filepath.Join(short, "defaults.json"), &m); m["dataRoot"] != `\\srv\new` || m["note"] != "IT" {
		t.Errorf("defaults after --data: %v", m)
	}

	// over an install for everyone, a run asking for "just me" keeps it for everyone
	every := filepath.Join(programFilesDir(), "Tools", appName)
	if err := doInstall(p, Options{Scope: "machine", Dir: every}, nop); err != nil {
		t.Fatal(err)
	}
	if err := doInstall(p, Options{Scope: "user", Dir: every}, nop); err != nil {
		t.Fatal(err)
	}
	if ii, _ := readInstall(every); ii.Scope != "machine" {
		t.Errorf("scope changed to %s", ii.Scope)
	}

	// someone's own folder named like ours is left alone
	mine := short + swapTag + "backup"
	os.MkdirAll(mine, 0o755)
	if err := doInstall(p, Options{Scope: "user", Dir: short}, nop); err != nil || !fileExists(mine) {
		t.Errorf("a person's %s was removed: %v", mine, err)
	}
	// ...by the uninstaller neither (it removes only what an interrupted run of ours left)
	ours := short + swapTag + "old-k2x9"
	os.MkdirAll(ours, 0o755)
	if err := doUninstall(short, nop); err != nil || fileExists(short) || fileExists(ours) || !fileExists(mine) {
		t.Errorf("uninstall: %v; ours left %v, the person's kept %v", err, fileExists(ours), fileExists(mine))
	}
}

func TestPreviousIsTheVersionThatRuns(t *testing.T) {
	root := setupTest(t)
	p, _ := openPayload(fakeSetup(t, root, "0.12.4", appFiles("0.12.4")))
	dir := filepath.Join(root, "inst")
	if err := doInstall(p, Options{Scope: "user", Dir: dir}, nop); err != nil {
		t.Fatal(err)
	}
	app := filepath.Join(dir, "resources", "app")
	os.RemoveAll(filepath.Join(app, "versions", "0.12.4"))
	for _, v := range []string{"0.12.1", "0.12.3", "0.12.9"} {
		for f, body := range appFiles(v) {
			if strings.HasPrefix(f, "resources/app/versions/") {
				os.MkdirAll(filepath.Dir(filepath.Join(dir, f)), 0o755)
				os.WriteFile(filepath.Join(dir, f), []byte(body), 0o644)
			}
		}
	}
	// this PC went back from 0.12.9; 0.12.3 never started properly; 0.12.1 is what runs
	os.WriteFile(filepath.Join(app, "current.json"), []byte(`{"version":"0.12.9","previous":"0.12.3","bad":["0.12.9"]}`), 0o644)
	os.WriteFile(filepath.Join(app, "boot-state.json"), []byte(`{"0.12.3":{"starts":3},"0.12.1":{"starts":9,"ok":true}}`), 0o644)
	if v := readAppState(dir).Current; v != "0.12.1" {
		t.Fatalf("the version that runs: %s", v)
	}
	if err := doInstall(p, Options{Scope: "user", Dir: dir}, nop); err != nil {
		t.Fatalf("0.12.9 is one this PC went back from: not a newer app to protect (%v)", err)
	}
	if v, prev := currentOf(t, dir); v != "0.12.4" || prev != "0.12.1" {
		t.Errorf("current %s previous %s", v, prev)
	}
}

// BH-019 (0.15): the elevated copy does only the job the setup wrote - a job file changed after it was
// written (it is in the person's %TEMP% while Windows asks for admin rights) is refused - and even an
// unchanged job is checked again there: install only into a folder the window would accept,
// uninstall only the folder Windows has Goldline Takeoff registered in.
func TestAdminStepDoesOnlyTheJobItWasGiven(t *testing.T) {
	root := setupTest(t)
	p, err := openPayload(fakeSetup(t, root, "0.15.0", appFiles("0.15.0")))
	if err != nil {
		t.Fatal(err)
	}
	asked := defaultDir("machine")
	jf := filepath.Join(root, "tmp", "gtsetup-job-1.json")
	os.MkdirAll(filepath.Dir(jf), 0o755)
	refused := func(what string, code int) {
		t.Helper()
		var res jobResult
		if code != 2 || readJSON(jf+".result", &res) != nil || res.OK || res.Err == "" {
			t.Errorf("%s: exit %d, result %+v - should be refused with a reason", what, code, res)
		}
		os.Remove(jf + ".result")
	}
	sum, err := writeJob(jf, Job{Kind: "install", Opts: Options{Scope: "machine", Dir: asked}})
	if err != nil {
		t.Fatal(err)
	}
	// a folder someone wants gone: their data plus the two files that make it look like an install
	victim := filepath.Join(root, "SomeoneElses", "Folder")
	os.MkdirAll(filepath.Join(victim, "resources", "app"), 0o755)
	os.WriteFile(filepath.Join(victim, "important.xlsx"), []byte("data"), 0o644)
	os.WriteFile(filepath.Join(victim, "install.json"), []byte(`{"scope":"machine","version":"1.0.0"}`), 0o644)
	os.WriteFile(filepath.Join(victim, "resources", "app", "package.json"), []byte(`{"productName":"Goldline Takeoff"}`), 0o644)
	// ...swapped while Windows asks for admin rights
	writeJSON(jf, Job{Kind: "uninstall", Dir: victim})
	refused("a swapped job file", runWorker(p, jf, sum))
	// one byte more (same job, other bytes): refused too - the fingerprint is of the exact file
	b, _ := json.MarshalIndent(Job{Kind: "install", Opts: Options{Scope: "machine", Dir: asked}}, "", "  ")
	os.WriteFile(jf, append(b, ' '), 0o644)
	refused("a job file with a byte added", runWorker(p, jf, sum))
	// no fingerprint at all: refused
	sum, _ = writeJob(jf, Job{Kind: "install", Opts: Options{Scope: "machine", Dir: asked}})
	refused("no --job-sha", runWorker(p, jf, ""))
	if !fileExists(filepath.Join(victim, "important.xlsx")) || fileExists(asked) {
		t.Fatal("a refused job changed something")
	}
	// the genuine job runs
	if code := runWorker(p, jf, sum); code != 0 || !fileExists(filepath.Join(asked, "install.json")) {
		t.Fatalf("the genuine job: exit %d", code)
	}

	// with a correct fingerprint (any program can start the setup with admin rights and a job of its
	// own - Windows asks the person, who may say yes) the request is still checked:
	// uninstall: only the registered folder - not a look-alike
	sum, _ = writeJob(jf, Job{Kind: "uninstall", Dir: victim})
	refused("uninstall of a folder that isn't registered", runWorker(p, jf, sum))
	if !fileExists(filepath.Join(victim, "important.xlsx")) {
		t.Fatal("the look-alike folder was touched")
	}
	// ...nor one registered only for the other kind of install than its install.json says
	testRegistry["user"] = victim
	sum, _ = writeJob(jf, Job{Kind: "uninstall", Dir: victim})
	refused("uninstall of a folder registered for the other scope", runWorker(p, jf, sum))
	delete(testRegistry, "user")
	// install: what the window refuses is refused here as well
	wd, _ := os.Getwd()
	os.Chdir(root)
	defer os.Chdir(wd)
	for _, o := range []Options{
		{Scope: "machine", Dir: "relative-dir"},                                      // not a full path
		{Scope: "machine", Dir: filepath.Join(root, "Elsewhere", appName)},           // for everyone outside Program Files
		{Scope: "machine", Dir: ""},                                                  // no folder: the admin account's default
		{Scope: "everyone", Dir: filepath.Join(programFilesDir(), "X", appName)},     // no such kind of install
		{Scope: "user", Dir: filepath.Join(root, strings.Repeat("d", 160), appName)}, // too long
	} {
		sum, _ = writeJob(jf, Job{Kind: "install", Opts: o})
		refused(fmt.Sprintf("install %+v", o), runWorker(p, jf, sum))
	}
	if fileExists(filepath.Join(root, "relative-dir")) || fileExists(filepath.Join(root, "Elsewhere")) || fileExists(filepath.Join(programFilesDir(), "X")) {
		t.Fatal("a refused install wrote something")
	}
	sum, _ = writeJob(jf, Job{Kind: "update-everything", Dir: asked})
	refused("an unknown job", runWorker(p, jf, sum))

	// the registered install is removed
	if testRegistry["machine"] != filepath.Clean(asked) {
		t.Fatalf("the install wasn't registered: %v", testRegistry)
	}
	sum, _ = writeJob(jf, Job{Kind: "uninstall", Dir: asked})
	if code := runWorker(p, jf, sum); code != 0 || fileExists(asked) {
		t.Fatalf("uninstall of the registered folder: exit %d", code)
	}

	// the whole hand-over as the window does it (runAs -> job file + fingerprint -> worker): a silent
	// "--all-users" without --dir gets its folder filled in by the person's side, never left to the
	// admin account's own default
	testPayload = p
	if err := runAs(p, Job{Kind: "install", Opts: Options{Scope: "machine"}}, true, nop); err != nil {
		t.Fatal(err)
	}
	if len(testElevated) != 1 || testElevated[0].Opts.Dir != asked || !fileExists(filepath.Join(asked, "install.json")) {
		t.Fatalf("handed to the elevated copy: %+v", testElevated)
	}
	if err := runAs(nil, Job{Kind: "uninstall", Dir: asked}, true, nop); err != nil || fileExists(asked) {
		t.Fatalf("uninstall through the hand-over: %v", err)
	}
	if err := runAs(nil, Job{Kind: "uninstall", Dir: victim}, true, nop); err == nil || !strings.Contains(err.Error(), "nothing was removed") || !fileExists(filepath.Join(victim, "important.xlsx")) {
		t.Fatalf("uninstall of the look-alike through the hand-over: %v", err)
	}
}

// BH-022 (0.15) and the folder for everyone: the install folder's path is at most 150 characters
// (an install already there stays updatable), and an install for everyone goes only inside Program
// Files - elsewhere other users of the PC could change the app's files.
func TestInstallFolderRules(t *testing.T) {
	root := setupTest(t)
	p, _ := openPayload(fakeSetup(t, root, "0.15.0", appFiles("0.15.0")))
	at := func(n int) string { // a folder path of exactly n characters
		base := filepath.Join(root, "a")
		return base + strings.Repeat("b", n-len(base))
	}
	if msg := checkDir("user", at(150)); msg != "" {
		t.Errorf("150 characters: %s", msg)
	}
	if msg := checkDir("user", at(151)); !strings.Contains(msg, "too long (151 characters)") || !strings.Contains(msg, "at most 150") {
		t.Errorf("151 characters: %q", msg)
	}
	// counted in characters as Windows counts them, not in bytes (Arabic, Cyrillic names)
	cyr := filepath.Join(root, strings.Repeat("ж", 100))
	if msg := checkDir("user", cyr); msg != "" {
		t.Errorf("%d characters in Cyrillic (%d bytes): %s", len([]rune(cyr)), len(cyr), msg)
	}
	// an install already at a long path (an older setup put it there) can still be updated in place
	long := at(170)
	if err := doInstall(p, Options{Scope: "user", Dir: long}, nop); err != nil {
		t.Fatal(err)
	}
	if msg := checkDir("user", long); msg != "" {
		t.Errorf("an existing install at a long path: %s", msg)
	}

	pf := programFilesDir()
	for _, ok := range []string{defaultDir("machine"), filepath.Join(pf, "Tools", appName), strings.ToUpper(pf[:len(pf)-3]) + pf[len(pf)-3:] + string(os.PathSeparator) + appName} {
		if msg := checkDir("machine", ok); msg != "" {
			t.Errorf("for everyone in %s: %s", ok, msg)
		}
	}
	for _, bad := range []string{filepath.Join(root, "Apps", appName), pf, pf + "X" + string(os.PathSeparator) + appName, filepath.Join(pf, "..", "Apps", appName)} {
		if msg := checkDir("machine", bad); !strings.Contains(msg, "inside "+pf) {
			t.Errorf("for everyone in %s: %q", bad, msg)
		}
	}
	// just for one person any folder of theirs is fine
	if msg := checkDir("user", filepath.Join(root, "Apps", appName)); msg != "" {
		t.Errorf("just me in Apps: %s", msg)
	}
	// doInstall itself refuses too, before anything is written
	apps := filepath.Join(root, "Apps", appName)
	if err := doInstall(p, Options{Scope: "machine", Dir: apps}, nop); err == nil || fileExists(apps) {
		t.Fatalf("for everyone outside Program Files: %v", err)
	}
	// an install for everyone an older setup put outside Program Files: not updated in place - it says
	// to remove it and install again (also when asked as "just me": the install's own scope counts)
	if err := doInstall(p, Options{Scope: "user", Dir: apps}, nop); err != nil {
		t.Fatal(err)
	}
	ii, _ := readInstall(apps)
	ii.Scope = "machine"
	writeJSON(filepath.Join(apps, "install.json"), ii)
	os.WriteFile(filepath.Join(apps, "mark.txt"), []byte("old"), 0o644)
	for _, sc := range []string{"machine", "user"} {
		err := doInstall(p, Options{Scope: sc, Dir: apps}, nop)
		if err == nil || !strings.Contains(err.Error(), "Remove it") || !fileExists(filepath.Join(apps, "mark.txt")) {
			t.Errorf("asked as %s over an install for everyone outside Program Files: %v", sc, err)
		}
	}
	if msg := checkDir("machine", apps); !strings.Contains(msg, "Remove it") {
		t.Errorf("checkDir: %q", msg)
	}
	// ...and it can still be removed
	if err := doUninstall(apps, nop); err != nil || fileExists(apps) {
		t.Errorf("removing it: %v", err)
	}
}
