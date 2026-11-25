// Goldline Takeoff Setup - the parts that don't depend on Windows: the payload inside the setup file,
// replacing the app folder safely, keeping the version before, reading what is installed.
//
// What it installs (one folder):
//
//	Goldline Takeoff.exe, Electron's files      the runtime (changes only with a new setup)
//	resources\app\boot.cjs, package.json        the starter: starts versions\<current>
//	resources\app\current.json                  which version, and the one before
//	resources\app\versions\<version>\           the app itself
//	defaults.json                               the shared folder offered on first start
//	install.json                                what this setup did (scope, choices)
//	Uninstall Goldline Takeoff.exe              this program without the app in it: removes the app
//
// Updates are NOT done by this program: the app downloads a new version from GitHub into the person's
// own store itself and starts it (electron/updater.cjs, starter.cjs). No second program runs for an
// update; this setup is only needed for a first install, a new Electron runtime, and removing the app.
package main

import (
	"archive/tar"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/klauspost/compress/zstd"
)

const (
	appName       = "Goldline Takeoff" // the install folder, files, registry keys
	displayName   = "Goldline Takeoff" // what people see: shortcuts, Installed apps, windows
	exeName       = "Goldline Takeoff.exe"
	uninstallName = "Uninstall Goldline Takeoff.exe"
	magic         = "GTKSETUP"
	// our own names next to the install folder while it is replaced (a person's "X.old" is never touched)
	swapTag = ".gtsetup-"
)

// version of this setup build (-ldflags "-X main.version=...")
var version = "0.0.0"

// Meta describes the payload appended to the setup file.
type Meta struct {
	Version string `json:"version"`
	Runtime string `json:"runtime"`
	Total   int64  `json:"total"` // bytes of all files
	Files   int    `json:"files"`
	SHA256  string `json:"sha256"` // of the payload: a damaged setup is refused before anything changes
}

// InstallInfo is install.json in the app folder.
type InstallInfo struct {
	Scope     string `json:"scope"` // "user" | "machine"
	Version   string `json:"version"`
	Runtime   string `json:"runtime"`
	Desktop   bool   `json:"desktop"`
	Installed string `json:"installed"`
}

// Defaults is defaults.json next to the exe: the shared folder the app offers on its first start
// (the app reads it; each person can still choose another in the app).
type Defaults struct {
	DataRoot string `json:"dataRoot"`
}

// Payload is the compressed app inside the setup file. The layout at the end of the file:
// [exe][payload][meta json][8: meta len][8: payload len][8: magic]
type Payload struct {
	Path    string
	ExeLen  int64
	Off     int64
	Len     int64
	Meta    Meta
	present bool
}

func openPayload(self string) (*Payload, error) {
	f, err := os.Open(self)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	p := &Payload{Path: self, ExeLen: st.Size()}
	end := payloadEnd(f, st.Size())
	if end < 24 {
		return p, nil
	}
	tail := make([]byte, 24)
	if _, err := f.ReadAt(tail, end-24); err != nil {
		return nil, err
	}
	if string(tail[16:]) != magic {
		return p, nil // the uninstaller copy: no payload
	}
	ml := int64(binary.LittleEndian.Uint64(tail[0:8]))
	pl := int64(binary.LittleEndian.Uint64(tail[8:16]))
	metaOff := end - 24 - ml
	if ml <= 0 || ml > 1<<20 || pl <= 0 || metaOff-pl < 0 {
		return nil, errors.New("the setup file is damaged (bad trailer) - get it again")
	}
	mb := make([]byte, ml)
	if _, err := f.ReadAt(mb, metaOff); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(mb, &p.Meta); err != nil {
		return nil, fmt.Errorf("the setup file is damaged (meta): %w", err)
	}
	if !versionRe.MatchString(p.Meta.Version) {
		return nil, fmt.Errorf("the setup file is damaged (version %q)", p.Meta.Version)
	}
	p.Off = metaOff - pl
	p.Len = pl
	p.ExeLen = p.Off
	p.present = true
	return p, nil
}

var versionRe = regexp.MustCompile(`^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$`)

// payloadEnd is where the trailer ends: the end of the file - or, when the setup was code-signed
// after it was built, where the signature (appended at the end, after up to 7 bytes of padding)
// starts. Without this a signed setup found no payload and acted as the uninstaller.
func payloadEnd(f *os.File, size int64) int64 {
	off, n := securityDir(f)
	if off <= 0 || n <= 0 || int64(off)+int64(n) > size {
		return size
	}
	b := make([]byte, 8)
	for pad := int64(0); pad < 8; pad++ {
		e := int64(off) - pad
		if e < 24 {
			break
		}
		if _, err := f.ReadAt(b, e-8); err == nil && string(b) == magic {
			return e
		}
	}
	return size
}

// securityDir reads the PE header's certificate table entry (file offset, size; 0 if none)
// and where that entry is in the file.
func securityDir(f io.ReaderAt) (uint32, uint32) {
	off, n, _ := securityDirAt(f)
	return off, n
}
func securityDirAt(f io.ReaderAt) (uint32, uint32, int64) {
	h := make([]byte, 4)
	if _, err := f.ReadAt(h, 0x3c); err != nil {
		return 0, 0, 0
	}
	pe := int64(binary.LittleEndian.Uint32(h))
	sig := make([]byte, 4)
	if _, err := f.ReadAt(sig, pe); err != nil || string(sig) != "PE\x00\x00" {
		return 0, 0, 0
	}
	opt := pe + 4 + 20
	m := make([]byte, 2)
	if _, err := f.ReadAt(m, opt); err != nil {
		return 0, 0, 0
	}
	var dirs int64
	switch binary.LittleEndian.Uint16(m) {
	case 0x20b: // PE32+
		dirs = opt + 112
	case 0x10b:
		dirs = opt + 96
	default:
		return 0, 0, 0
	}
	at := dirs + 4*8 // entry 4: the certificate table
	e := make([]byte, 8)
	if _, err := f.ReadAt(e, at); err != nil {
		return 0, 0, 0
	}
	return binary.LittleEndian.Uint32(e[0:4]), binary.LittleEndian.Uint32(e[4:8]), at
}

// Verify reads the whole payload and checks its fingerprint (a byte changed anywhere in a copy of the
// setup would otherwise install a damaged app).
func (p *Payload) Verify(prog func(done, total int64)) error {
	if p.Meta.SHA256 == "" {
		return errors.New("the setup file is damaged (no fingerprint) - get it again")
	}
	f, err := os.Open(p.Path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	r := io.NewSectionReader(f, p.Off, p.Len)
	buf := make([]byte, 4<<20)
	var done int64
	for {
		n, err := r.Read(buf)
		if n > 0 {
			h.Write(buf[:n])
			done += int64(n)
			if prog != nil {
				prog(done, p.Len)
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("can't read the setup file: %w", err)
		}
	}
	if !strings.EqualFold(hex.EncodeToString(h.Sum(nil)), p.Meta.SHA256) {
		return errors.New("the setup file is damaged (its contents don't match its fingerprint) - get it again")
	}
	return nil
}

// Extract unpacks the payload into dst (which must not exist yet).
func (p *Payload) Extract(dst string, prog func(done, total int64)) error {
	f, err := os.Open(p.Path)
	if err != nil {
		return err
	}
	defer f.Close()
	dec, err := zstd.NewReader(io.NewSectionReader(f, p.Off, p.Len), zstd.WithDecoderMaxWindow(1<<30), zstd.WithDecoderMaxMemory(1<<31))
	if err != nil {
		return err
	}
	defer dec.Close()
	return untar(dec, dst, p.Meta.Total, prog)
}

func untar(r io.Reader, dst string, total int64, prog func(done, total int64)) error {
	tr := tar.NewReader(r)
	var done int64
	last := time.Time{}
	buf := make([]byte, 1<<20)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("the setup file is damaged: %w", err)
		}
		name, err := safeRel(h.Name)
		if err != nil {
			return err
		}
		if name == "" {
			continue
		}
		out := filepath.Join(dst, name)
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(out, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
				return err
			}
			w, err := os.OpenFile(out, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
			if err != nil {
				return err
			}
			for {
				n, rerr := tr.Read(buf)
				if n > 0 {
					if _, werr := w.Write(buf[:n]); werr != nil {
						w.Close()
						return werr
					}
					done += int64(n)
					if prog != nil && time.Since(last) > 80*time.Millisecond {
						prog(done, total)
						last = time.Now()
					}
				}
				if rerr == io.EOF {
					break
				}
				if rerr != nil {
					w.Close()
					return fmt.Errorf("the setup file is damaged: %w", rerr)
				}
			}
			if err := w.Close(); err != nil {
				return err
			}
		}
	}
	if prog != nil {
		prog(total, total)
	}
	return nil
}

// safeRel keeps archive paths inside the target folder.
func safeRel(name string) (string, error) {
	n := strings.TrimPrefix(strings.ReplaceAll(name, "\\", "/"), "./")
	n = strings.TrimSuffix(n, "/")
	if n == "" || n == "." {
		return "", nil
	}
	if strings.HasPrefix(n, "/") || strings.Contains(n, ":") {
		return "", fmt.Errorf("bad path in package: %s", name)
	}
	for _, part := range strings.Split(n, "/") {
		if part == ".." {
			return "", fmt.Errorf("bad path in package: %s", name)
		}
	}
	return filepath.FromSlash(n), nil
}

// copyExePart writes the setup program without its payload: the uninstaller kept in the app folder.
func (p *Payload) copyExePart(dst string) error {
	f, err := os.Open(p.Path)
	if err != nil {
		return err
	}
	defer f.Close()
	tmp := dst + ".tmp"
	w, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(w, io.NewSectionReader(f, 0, p.ExeLen)); err != nil {
		w.Close()
		os.Remove(tmp)
		return err
	}
	// a signed setup: its header points at a signature this copy doesn't have - cleared (the
	// copy is simply unsigned, not "damaged")
	if off, n, at := securityDirAt(f); at > 0 && (off != 0 || n != 0) && int64(off) >= p.ExeLen {
		if _, err := w.WriteAt(make([]byte, 8), at); err != nil {
			w.Close()
			os.Remove(tmp)
			return err
		}
	}
	if err := w.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	os.Remove(dst)
	return os.Rename(tmp, dst)
}

// retry runs f until it works or the time is up (Explorer, antivirus or the closing app can
// hold files for a moment).
func retry(d time.Duration, f func() error) error {
	end := time.Now().Add(d)
	wait := 100 * time.Millisecond
	for {
		err := f()
		if err == nil || time.Now().After(end) {
			return err
		}
		time.Sleep(wait)
		if wait < time.Second {
			wait *= 2
		}
	}
}

// replaceDir fills a new copy of dir next to it, then swaps it in. The old copy is put back if
// the swap fails, so a failed install never leaves a half-written app behind.
// fill gets the new folder and the old one ("" when there is none) to take things over from.
func replaceDir(dir string, fill func(tmp, old string) error) error {
	tag := strconv.FormatInt(time.Now().UnixNano()%1e9, 36)
	tmp := dir + swapTag + "new-" + tag
	recoverInterrupted(dir)
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		return err
	}
	oldDir := ""
	if fileExists(dir) {
		oldDir = dir
	}
	if err := fill(tmp, oldDir); err != nil {
		_ = os.RemoveAll(tmp)
		return err
	}
	if oldDir == "" {
		if err := retry(5*time.Second, func() error { return os.Rename(tmp, dir) }); err != nil {
			_ = os.RemoveAll(tmp)
			return err
		}
		return nil
	}
	old := dir + swapTag + "old-" + tag
	if err := retry(8*time.Second, func() error { return os.Rename(dir, old) }); err != nil {
		// something still holds a file in the old folder (an Explorer window, an antivirus):
		// nothing is changed - copying over it could stop halfway and leave old and new mixed
		logf("rename of the old folder failed: %v", err)
		_ = os.RemoveAll(tmp)
		return fmt.Errorf("a file in %s is in use (an Explorer window showing that folder, or an antivirus scan) - close it and try again; nothing was changed", dir)
	}
	if err := retry(5*time.Second, func() error { return os.Rename(tmp, dir) }); err != nil {
		// the old copy goes back where it was; if even that fails it stays next to it (the next run
		// of the setup puts it back - it is never deleted while the install folder is missing)
		if rerr := retry(8*time.Second, func() error { return os.Rename(old, dir) }); rerr != nil {
			logf("putting the old folder back failed: %v", rerr)
			return fmt.Errorf("the new version could not be put in place (%v), and the version you had is in %s - run the setup again to put it back", err, old)
		}
		_ = os.RemoveAll(tmp)
		return err
	}
	if err := os.RemoveAll(old); err != nil {
		logf("old folder left behind: %v", err)
	}
	return nil
}

// recoverInterrupted tidies what an interrupted run left next to dir (our own names only). When dir
// itself is missing and a copy of it was set aside (".gtsetup-old-*": stopped between the two renames
// of a swap), that copy is put back first - it may hold the only copy of the app.
func recoverInterrupted(dir string) {
	left := ourLeftovers(dir)
	if len(left) == 0 {
		return
	}
	if !fileExists(dir) {
		newest, at := "", time.Time{}
		for _, l := range left {
			if fi, err := os.Stat(l); err == nil && fi.IsDir() && strings.HasPrefix(filepath.Base(l), filepath.Base(dir)+swapTag+"old-") && fi.ModTime().After(at) {
				newest, at = l, fi.ModTime()
			}
		}
		if newest != "" {
			if err := os.Rename(newest, dir); err == nil {
				logf("put back %s (left by an interrupted run)", newest)
			} else {
				logf("could not put back %s: %v", newest, err)
				return // nothing is deleted while the app's only copy may be in there
			}
		}
	}
	for _, l := range ourLeftovers(dir) {
		_ = os.RemoveAll(l)
	}
}

// ourLeftovers: what this setup leaves next to dir while working - <dir>.gtsetup-new-<tag>,
// -old-<tag>, -trash-<tag>.exe - and nothing else (a person's "Goldline Takeoff.gtsetup-backup" stays).
func ourLeftovers(dir string) []string {
	all, _ := filepath.Glob(globEscape(dir) + swapTag + "*")
	base := filepath.Base(dir) + swapTag
	var out []string
	for _, l := range all {
		if ourLeftoverRe.MatchString(strings.TrimPrefix(filepath.Base(l), base)) {
			out = append(out, l)
		}
	}
	return out
}

var ourLeftoverRe = regexp.MustCompile(`^(new|old)-[0-9a-z]{1,13}$|^trash-[0-9a-z]{1,13}\.exe$`)

// globEscape: a folder name used literally in a pattern ([, *, ? are pattern characters).
func globEscape(s string) string {
	return strings.NewReplacer("[", "[[]", "*", "[*]", "?", "[?]").Replace(s)
}

func copyFile(src, dst string) error {
	r, err := os.Open(src)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	w, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(w, r); err != nil {
		w.Close()
		return err
	}
	return w.Close()
}

func copyTree(src, dst string) error {
	return filepath.Walk(src, func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		out := filepath.Join(dst, rel)
		if fi.IsDir() {
			return os.MkdirAll(out, 0o755)
		}
		return retry(3*time.Second, func() error { return copyFile(p, out) })
	})
}

// readJSON reads JSON written by the app, this setup or by hand (a byte-order mark is fine).
func readJSON(p string, v any) error {
	b, err := os.ReadFile(p)
	if err != nil {
		return err
	}
	return json.Unmarshal(looseText(b), v)
}

// looseText: text written by the app or by hand - a UTF-8 byte-order mark, or UTF-16 (PowerShell 5's
// Out-File) - as UTF-8 (the same rules as boot.cjs / the updater's parseLoose).
func looseText(b []byte) []byte {
	u16 := func(b []byte, big bool) []byte {
		n := len(b) / 2
		r := make([]uint16, n)
		for i := 0; i < n; i++ {
			if big {
				r[i] = uint16(b[2*i])<<8 | uint16(b[2*i+1])
			} else {
				r[i] = uint16(b[2*i]) | uint16(b[2*i+1])<<8
			}
		}
		return []byte(string(utf16.Decode(r)))
	}
	switch {
	case len(b) >= 2 && b[0] == 0xff && b[1] == 0xfe:
		return u16(b[2:], false)
	case len(b) >= 2 && b[0] == 0xfe && b[1] == 0xff:
		return u16(b[2:], true)
	case len(b) >= 2 && b[1] == 0 && b[0] != 0:
		return u16(b, false)
	}
	return []byte(strings.TrimPrefix(string(b), "\uFEFF"))
}

// readLooseJSON: like readJSON, and for a file written by hand single backslashes in a Windows path
// ("S:\Tenders") are taken as meant (as the app reads defaults.json).
func readLooseJSON(p string, v any) error {
	b, err := os.ReadFile(p)
	if err != nil {
		return err
	}
	t := looseText(b)
	if err := json.Unmarshal(t, v); err == nil {
		return nil
	}
	return json.Unmarshal(lonelyBackslash.ReplaceAll(t, []byte(`\\$1`)), v)
}

// a backslash not starting a JSON escape (Go's regexp has no look-ahead: the next character is kept)
var lonelyBackslash = regexp.MustCompile(`\\([^\\"/bfnrtu])`)

func writeJSON(p string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func readInstall(dir string) (*InstallInfo, error) {
	var ii InstallInfo
	if err := readJSON(filepath.Join(dir, "install.json"), &ii); err != nil {
		return nil, err
	}
	return &ii, nil
}

// cmpVersion: -1, 0, 1. "0.12.10" > "0.12.9"; "0.13.0-rc1" < "0.13.0" (as the app's updater).
func cmpVersion(a, b string) int {
	split := func(v string) ([]int, string) {
		v = strings.TrimSpace(v)
		pre := ""
		if i := strings.Index(v, "-"); i >= 0 {
			v, pre = v[:i], v[i+1:]
		}
		var nums []int
		for _, x := range strings.Split(v, ".") {
			n, _ := strconv.Atoi(x)
			nums = append(nums, n)
		}
		return nums, pre
	}
	an, ap := split(a)
	bn, bp := split(b)
	for i := 0; i < len(an) || i < len(bn); i++ {
		var x, y int
		if i < len(an) {
			x = an[i]
		}
		if i < len(bn) {
			y = bn[i]
		}
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	switch {
	case ap == bp:
		return 0
	case ap == "":
		return 1
	case bp == "":
		return -1
	}
	if c := naturalCmp(ap, bp); c != 0 {
		return c
	}
	if ap < bp {
		return -1
	}
	return 1
}

// naturalCmp compares text with numbers in it by their value: rc9 < rc10 (as the app's
// localeCompare(..., { numeric: true })). Letters are compared without case.
func naturalCmp(a, b string) int {
	chunks := func(s string) []string {
		var out []string
		for i := 0; i < len(s); {
			j := i
			digit := s[i] >= '0' && s[i] <= '9'
			for j < len(s) && (s[j] >= '0' && s[j] <= '9') == digit {
				j++
			}
			out = append(out, s[i:j])
			i = j
		}
		return out
	}
	ca, cb := chunks(a), chunks(b)
	for i := 0; i < len(ca) && i < len(cb); i++ {
		x, y := ca[i], cb[i]
		xd, yd := x[0] >= '0' && x[0] <= '9', y[0] >= '0' && y[0] <= '9'
		if xd && yd {
			nx, ny := strings.TrimLeft(x, "0"), strings.TrimLeft(y, "0")
			if len(nx) != len(ny) {
				if len(nx) < len(ny) {
					return -1
				}
				return 1
			}
			if nx != ny {
				if nx < ny {
					return -1
				}
				return 1
			}
			continue
		}
		lx, ly := strings.ToLower(x), strings.ToLower(y)
		if lx != ly {
			if lx < ly {
				return -1
			}
			return 1
		}
	}
	switch {
	case len(ca) < len(cb):
		return -1
	case len(ca) > len(cb):
		return 1
	}
	return 0
}

// appState is what is installed in an app folder: the version the starter runs (current.json, or
// the app's package.json in a one-folder copy) and the version folders that can start.
type appState struct {
	Current   string
	Previous  string
	Startable map[string]bool
}

// startableVersion: the files the starter needs to start versions\<v> (as boot.cjs checks).
func startableVersion(appDir, v string) bool {
	if !versionNameRe.MatchString(v) {
		return false
	}
	for _, f := range []string{"package.json", "electron/main.cjs", "electron/preload.cjs", "dist/index.html"} {
		if !fileExists(filepath.Join(appDir, "versions", v, filepath.FromSlash(f))) {
			return false
		}
	}
	return true
}

var (
	versionNameRe = regexp.MustCompile(`^[\w.-]+$`)
	bootRevRe     = regexp.MustCompile(`BOOT_REV\s*=\s*(\d+)`)
)

func readAppState(dir string) appState {
	appDir := filepath.Join(dir, "resources", "app")
	st := appState{Startable: map[string]bool{}}
	var installed []string
	if ents, err := os.ReadDir(filepath.Join(appDir, "versions")); err == nil {
		for _, e := range ents {
			if e.IsDir() && !strings.HasPrefix(e.Name(), ".") && startableVersion(appDir, e.Name()) {
				st.Startable[e.Name()] = true
				installed = append(installed, e.Name())
			}
		}
	}
	if len(installed) == 0 {
		// a one-folder copy (no starter yet): the app's own package.json
		var pkg struct {
			Version string `json:"version"`
			Main    string `json:"main"`
		}
		if readJSON(filepath.Join(appDir, "package.json"), &pkg) == nil && pkg.Main == "electron/main.cjs" {
			st.Current = pkg.Version
		}
		return st
	}
	// the version the starter (boot.cjs) actually runs: current.json's, unless this PC went back from
	// it ("bad") or it keeps failing to start (boot-state.json) - then the one before, then the newest
	// that can start
	var cur struct {
		Version  string   `json:"version"`
		Previous string   `json:"previous"`
		Bad      []string `json:"bad"`
	}
	_ = readJSON(filepath.Join(appDir, "current.json"), &cur)
	state := map[string]struct {
		Starts int    `json:"starts"`
		OK     bool   `json:"ok"`
		Failed string `json:"failed"`
	}{}
	_ = readJSON(filepath.Join(appDir, "boot-state.json"), &state)
	sort.Slice(installed, func(a, b int) bool { return cmpVersion(installed[a], installed[b]) > 0 })
	var order []string
	seen := map[string]bool{}
	for _, v := range append([]string{cur.Version, cur.Previous}, installed...) {
		if v != "" && st.Startable[v] && !seen[v] {
			seen[v] = true
			order = append(order, v)
		}
	}
	bad := map[string]bool{}
	for _, v := range cur.Bad {
		bad[v] = true
	}
	for _, v := range order {
		s := state[v]
		if !bad[v] && (s.OK || (s.Failed == "" && s.Starts < 3)) {
			st.Current = v
			break
		}
	}
	if st.Current == "" && len(order) > 0 {
		st.Current = order[0]
	}
	if st.Startable[cur.Previous] && cur.Previous != st.Current {
		st.Previous = cur.Previous
	}
	return st
}

// oneFolderVersion: a hand-made copy from before the versioned layout (resources\app holds the app
// itself: package.json main electron/main.cjs) - its version, else "".
func oneFolderVersion(dir string) string {
	appDir := filepath.Join(dir, "resources", "app")
	var pkg struct {
		Version string `json:"version"`
		Main    string `json:"main"`
	}
	if readJSON(filepath.Join(appDir, "package.json"), &pkg) != nil || pkg.Main != "electron/main.cjs" || !versionRe.MatchString(pkg.Version) {
		return ""
	}
	for _, f := range []string{"electron/main.cjs", "electron/preload.cjs", "dist/index.html"} {
		if !fileExists(filepath.Join(appDir, filepath.FromSlash(f))) {
			return ""
		}
	}
	return pkg.Version
}

// keepOneFolder copies a one-folder copy's app into versions\<v> of the new install (what the app's
// own first update does), so it stays as the way back. "" when it can't.
func keepOneFolder(old, newAppDir, setupVersion string) string {
	v := oneFolderVersion(old)
	if v == "" || cmpVersion(v, setupVersion) >= 0 {
		return ""
	}
	src := filepath.Join(old, "resources", "app")
	dst := filepath.Join(newAppDir, "versions", v)
	for _, d := range []string{"dist", "electron"} {
		if err := copyTree(filepath.Join(src, d), filepath.Join(dst, d)); err != nil {
			logf("keeping %s: %v", v, err)
			_ = os.RemoveAll(dst)
			return ""
		}
	}
	if err := copyFile(filepath.Join(src, "package.json"), filepath.Join(dst, "package.json")); err != nil || !startableVersion(newAppDir, v) {
		_ = os.RemoveAll(dst)
		return ""
	}
	return v
}

// keepVersions: the version folders of the old install that go into the new one, and what
// current.json then says. The setup's version becomes the current one; the version that was running
// stays as the way back ("Go back" in the app, and the starter's fallback when the new one can't
// start). A version folder of the same name as the setup's is the setup's (the setup's files win).
func keepVersions(old appState, setupVersion string) (keep []string, previous string) {
	if old.Current != "" && old.Current != setupVersion && old.Startable[old.Current] && cmpVersion(old.Current, setupVersion) < 0 {
		keep = append(keep, old.Current)
		previous = old.Current
	}
	return keep, previous
}

// writeCurrent writes resources\app\current.json the way the app's updater does.
func writeCurrent(appDir, v, previous string) error {
	type cur struct {
		Version  string   `json:"version"`
		Previous *string  `json:"previous"`
		Bad      []string `json:"bad"`
		At       int64    `json:"at"`
	}
	c := cur{Version: v, Bad: []string{}, At: time.Now().UnixMilli()}
	if previous != "" {
		c.Previous = &previous
	}
	return writeJSON(filepath.Join(appDir, "current.json"), c)
}

// dirSizeKB for the "Installed apps" list.
func dirSizeKB(dir string) uint32 {
	var n int64
	_ = filepath.Walk(dir, func(_ string, fi os.FileInfo, err error) error {
		if err == nil && !fi.IsDir() {
			n += fi.Size()
		}
		return nil
	})
	return uint32(n / 1024)
}

// pendingChanges: changes made on this PC that haven't reached the shared folder yet (the app's
// outbox: data\profile-*\outbox\...\*.log with something in them, under the app's folder for this
// person). Data that holds them is never removed.
func pendingChanges(appDataDir string) int {
	n := 0
	profiles, _ := filepath.Glob(filepath.Join(globEscape(appDataDir), "data", "profile-*"))
	for _, p := range profiles {
		_ = filepath.Walk(filepath.Join(p, "outbox"), func(f string, fi os.FileInfo, err error) error {
			if err == nil && !fi.IsDir() && strings.HasSuffix(strings.ToLower(f), ".log") && fi.Size() > 0 {
				n++
			}
			return nil
		})
	}
	return n
}

// localPlainPath: a path on a local drive (C:\...), not a network or device path, with no junction or
// link on the way (the elevated copy opens only such a path: the job file)
func localPlainPath(p string) error {
	if !filepath.IsAbs(p) || strings.HasPrefix(p, `\\`) || strings.HasPrefix(p, "//") {
		return fmt.Errorf("%s is not a path on this PC", p)
	}
	if vol := filepath.VolumeName(p); vol != "" && (len(vol) != 2 || vol[1] != ':') {
		return fmt.Errorf("%s is not a path on a local drive", p)
	}
	for q := filepath.Clean(p); ; q = filepath.Dir(q) {
		if fi, err := os.Lstat(q); err == nil && fi.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 {
			return fmt.Errorf("%s goes through a link (%s)", p, q)
		}
		if filepath.Dir(q) == q {
			return nil
		}
	}
}
