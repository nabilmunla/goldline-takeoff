//go:build !windows

// Stand-ins so the core can be built and tested on Linux. The real thing is Windows only.
package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const (
	mbInfo  = 0x40
	mbWarn  = 0x30
	mbError = 0x10
	mbYesNo = 0x04
	idYes   = 6
)

var testRoot = os.Getenv("GT_SETUP_TEST_ROOT")

// what the Linux stand-ins were asked to do (tests read it)
var testCalls []string

func messageBox(text string, flags uint32) int { logf("messagebox: %s", text); return idYes }
func isElevated() bool                         { return false }
func exeLocked(p string) bool                  { return fileExists(p + ".running") }
func launch(path string, args ...string) error { return exec.Command(path, args...).Start() }
func launchApp(path string) error              { return launch(path) }
func defaultDir(scope string) string           { return filepath.Join(testRoot, scope, appName) }
func programFilesDir() string                  { return filepath.Join(testRoot, "machine") }
func singleInstance(silent bool) bool          { return true }
func toUNC(p string) string                    { return p }

// (tests: a folder under <test root>/netdrive stands in for a mapped network drive)
func onNetwork(p string) bool {
	return strings.HasPrefix(p, `\\`) || (testRoot != "" && strings.HasPrefix(p, filepath.Join(testRoot, "netdrive")))
}
func userDataDirs() []string                   { return []string{filepath.Join(testRoot, "localappdata", appName)} }
func makeShortcuts(dir string, ii InstallInfo) error {
	testCalls = append(testCalls, "shortcuts "+dir)
	return nil
}
func removeShortcuts(scope, dir string) { testCalls = append(testCalls, "unshortcuts "+dir) }

// testRegistry: the stand-in for Windows' Installed apps entries (scope -> InstallLocation)
var testRegistry = map[string]string{}

func registerApp(dir string, ii InstallInfo) error {
	testCalls = append(testCalls, "register "+dir)
	testRegistry[ii.Scope] = filepath.Clean(dir)
	return nil
}
func unregisterApp(dir, scope string) {
	testCalls = append(testCalls, "unregister "+dir)
	if testRegistry[scope] == filepath.Clean(dir) {
		delete(testRegistry, scope)
	}
}
func registeredDir(scope, dir string) bool {
	r, ok := testRegistry[scope]
	return ok && r == filepath.Clean(dir)
}
func findInstalled() (string, *InstallInfo) { return "", nil }

// runElevated (stand-in): the hand-over to the elevated copy as on Windows - the job file and its
// fingerprint, the worker's checks, its result file - with the worker run here (testPayload).
var (
	testPayload  *Payload
	testElevated []Job
)

func runElevated(j Job, prog progressFn) error {
	testElevated = append(testElevated, j)
	jf := filepath.Join(testRoot, "tmp", "gtsetup-job-test.json")
	_ = os.MkdirAll(filepath.Dir(jf), 0o755)
	sum, err := writeJob(jf, j)
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(jf); _ = os.Remove(jf + ".progress"); _ = os.Remove(jf + ".result") }()
	runWorker(testPayload, jf, sum)
	var res jobResult
	if err := readJSON(jf+".result", &res); err != nil {
		return errors.New("the installer with admin rights stopped without finishing")
	}
	if !res.OK {
		return errors.New(res.Err)
	}
	return nil
}
func installUI(p *Payload, st UIState) int { logf("installUI %+v", st); return 0 }
func uninstallUI(dir, scope string) int    { logf("uninstallUI %s", dir); return 0 }
