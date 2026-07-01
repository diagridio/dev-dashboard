# Aspire + standalone `dapr run` logs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Logs page show `daprd` and `app` logs for .NET Aspire-hosted apps and for standalone `dapr run` (no `-f` template), in addition to the already-working `dapr run -f` case.

**Architecture:** Add a log-source resolution step in the discovery layer that runs when the sidecar's `/v1.0/metadata` reports no log paths. For Aspire apps it locates the DCP session dir (from the app-port listener's `--kubeconfig` flag) and maps the `{guid}_out` capture files to daprd/app by parsing the `resource-executable-*.log` companion files. For standalone runs it inspects each process's stdout (fd 1) via `lsof` and uses it only if it is a regular file. The SSE log handler normalizes DCP-captured lines (strips the seq/timestamp prefix and ANSI codes) before streaming.

**Tech Stack:** Go 1.26 (backend), gopsutil (existing, for port→process), `lsof` (fd resolution), chi router, React/TypeScript (frontend). Tests use the `unit` build tag; run with `go test -tags unit -race ./...`.

## Global Constraints

- Go module: `github.com/diagridio/dev-dashboard`; Go version floor `1.26.4`.
- Unit tests use the `//go:build unit` tag (first line of the test file). Run via `go test -tags unit -race ./pkg/...`.
- Existing test helper `fakeResolver` (in `pkg/discovery/appproc_test.go`) implements `appProcResolver` — reuse it, do not redefine it.
- New JSON fields on `Instance` MUST use `omitempty` so existing golden JSON fixtures are unaffected.
- Log-source resolution runs only when a metadata-reported path is empty; never override a metadata path.
- Feature requires the dashboard to run on the host (same filesystem + process namespace as the dapr/Aspire processes) — this matches existing discovery behavior; do not attempt container-remote access.

---

### Task 1: Add log-format fields + DCP session-dir parsing

**Files:**
- Modify: `pkg/discovery/types.go:14-40` (add two fields to `Instance`)
- Create: `pkg/discovery/logsource.go`
- Create: `pkg/discovery/logsource_test.go`

**Interfaces:**
- Produces: `Instance.AppLogFormat string`, `Instance.DaprdLogFormat string` (values `""`/`"plain"`/`"dcp"`); `dcpSessionDir(cmd string) (string, bool)`; constants `logFormatPlain = "plain"`, `logFormatDCP = "dcp"`.

- [ ] **Step 1: Add the format fields to `Instance`**

In `pkg/discovery/types.go`, inside the `Instance` struct, immediately after the `DaprdLogPath` field (line 31), add:

```go
	AppLogFormat    string         `json:"appLogFormat,omitempty"`   // "" / "plain" / "dcp"
	DaprdLogFormat  string         `json:"daprdLogFormat,omitempty"` // "" / "plain" / "dcp"
```

- [ ] **Step 2: Write the failing test for `dcpSessionDir`**

Create `pkg/discovery/logsource_test.go`:

```go
//go:build unit

package discovery

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestDcpSessionDir(t *testing.T) {
	t.Run("space-separated flag", func(t *testing.T) {
		cmd := "/x/.nuget/packages/aspire.hosting.orchestration.osx-arm64/13.4.6/tools/dcp run-controllers --kubeconfig /var/folders/4c/T/aspire-dcpZOY2Ea/kubeconfig --monitor 82529"
		dir, ok := dcpSessionDir(cmd)
		require.True(t, ok)
		require.Equal(t, "/var/folders/4c/T/aspire-dcpZOY2Ea", dir)
	})

	t.Run("equals form", func(t *testing.T) {
		dir, ok := dcpSessionDir("dcp run-controllers --kubeconfig=/tmp/aspire-dcpABC/kubeconfig")
		require.True(t, ok)
		require.Equal(t, "/tmp/aspire-dcpABC", dir)
	})

	t.Run("no kubeconfig flag", func(t *testing.T) {
		_, ok := dcpSessionDir("daprd --app-id x")
		require.False(t, ok)
	})
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `go test -tags unit ./pkg/discovery/ -run TestDcpSessionDir -v`
Expected: FAIL — `undefined: dcpSessionDir`.

- [ ] **Step 4: Implement `dcpSessionDir` and constants**

Create `pkg/discovery/logsource.go`:

```go
package discovery

import (
	"path/filepath"
	"strings"
)

const (
	logFormatPlain = "plain"
	logFormatDCP   = "dcp"
)

// dcpSessionDir extracts the Aspire DCP session directory from a dcp process
// command line by reading its `--kubeconfig <dir>/kubeconfig` flag. The session
// directory is the parent of the kubeconfig file. Returns ("", false) when the
// flag is absent.
func dcpSessionDir(cmd string) (string, bool) {
	fields := strings.Fields(cmd)
	for i, f := range fields {
		switch {
		case f == "--kubeconfig" && i+1 < len(fields):
			return filepath.Dir(fields[i+1]), true
		case strings.HasPrefix(f, "--kubeconfig="):
			return filepath.Dir(strings.TrimPrefix(f, "--kubeconfig=")), true
		}
	}
	return "", false
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `go test -tags unit ./pkg/discovery/ -run TestDcpSessionDir -v`
Expected: PASS (all three subtests).

- [ ] **Step 6: Commit**

```bash
git add pkg/discovery/types.go pkg/discovery/logsource.go pkg/discovery/logsource_test.go
git commit -m "feat(discovery): add log-format fields and DCP session-dir parsing"
```

---

### Task 2: Map DCP capture files to daprd/app logs

**Files:**
- Modify: `pkg/discovery/logsource.go`
- Modify: `pkg/discovery/logsource_test.go`

**Interfaces:**
- Consumes: `logFormatDCP` (Task 1).
- Produces: `resolveDCPLogs(sessionDir, appID string) (daprdPath, appPath string)`.

Background — inside a DCP session dir, each resource has:
- `resource-executable-<guid>.log` — text lines; the "Starting process..." line ends with a JSON object like `{"Executable": "/pr-digest-dapr-cli-yuhagtzr", "Cmd": "/usr/local/bin/dapr", "Args": ["run","--app-id","pr-digest",...]}`.
- `<guid>_out` — the captured stdout for that resource.

The daprd log is the `_out` of the resource whose `Cmd` is `dapr`/`daprd` and whose `Args` contain `run` and `--app-id <appID>`. The app log is the `_out` of the sibling executable resource sharing the base name (the daprd resource name with the trailing `-dapr-cli-<suffix>` removed).

- [ ] **Step 1: Write the failing test for `resolveDCPLogs`**

Add to `pkg/discovery/logsource_test.go`:

```go
func TestResolveDCPLogs(t *testing.T) {
	dir := t.TempDir()
	writeFile := func(name, content string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600))
	}

	// daprd sidecar resource (guid AAA) — app-id "pr-digest", resource name "pr-digest-dapr-cli-yuha".
	writeFile("resource-executable-AAA.log",
		`2026-06-30T21:51:26Z	info	ExecutableReconciler	Starting process...	{"Executable": "/pr-digest-dapr-cli-yuha", "Cmd": "/usr/local/bin/dapr", "Args": ["run","--app-id","pr-digest","--app-port","5090"]}`+"\n")
	writeFile("AAA_out", "daprd log line\n")

	// app resource (guid BBB) — same base "pr-digest", a dotnet process.
	writeFile("resource-executable-BBB.log",
		`2026-06-30T21:51:30Z	info	ExecutableReconciler	Starting process...	{"Executable": "/pr-digest-zfzg", "Cmd": "/opt/homebrew/bin/dotnet", "Args": ["run","--project","App.csproj"]}`+"\n")
	writeFile("BBB_out", "app log line\n")

	// unrelated container resource (must be ignored — not resource-executable-*).
	writeFile("resource-container-CCC.log", "irrelevant\n")

	daprdPath, appPath := resolveDCPLogs(dir, "pr-digest")
	require.Equal(t, filepath.Join(dir, "AAA_out"), daprdPath)
	require.Equal(t, filepath.Join(dir, "BBB_out"), appPath)
}

func TestResolveDCPLogs_AppIdDiffersFromResourceName(t *testing.T) {
	dir := t.TempDir()
	writeFile := func(name, content string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600))
	}
	// Resource name "myapi" but Dapr app-id "different-id".
	writeFile("resource-executable-AAA.log",
		`x	info	r	Starting process...	{"Executable": "/myapi-dapr-cli-xx", "Cmd": "/usr/local/bin/dapr", "Args": ["run","--app-id","different-id"]}`+"\n")
	writeFile("AAA_out", "d\n")
	writeFile("resource-executable-BBB.log",
		`x	info	r	Starting process...	{"Executable": "/myapi-yy", "Cmd": "/usr/bin/node", "Args": ["server.js"]}`+"\n")
	writeFile("BBB_out", "a\n")

	daprdPath, appPath := resolveDCPLogs(dir, "different-id")
	require.Equal(t, filepath.Join(dir, "AAA_out"), daprdPath)
	require.Equal(t, filepath.Join(dir, "BBB_out"), appPath)
}
```

Add `"os"` and `"path/filepath"` to the test file's imports.

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test -tags unit ./pkg/discovery/ -run TestResolveDCPLogs -v`
Expected: FAIL — `undefined: resolveDCPLogs`.

- [ ] **Step 3: Implement `resolveDCPLogs` and helpers**

Append to `pkg/discovery/logsource.go` (and extend the import block to include `encoding/json`, `os`):

```go
// dcpResourceInfo is the subset of the JSON object DCP writes on the
// "Starting process..." line of a resource-executable-<guid>.log file.
type dcpResourceInfo struct {
	Executable string   `json:"Executable"`
	Cmd        string   `json:"Cmd"`
	Args       []string `json:"Args"`
}

// dcpResource pairs a resource's guid (from its log filename) with its parsed info.
type dcpResource struct {
	guid string
	info dcpResourceInfo
}

// resolveDCPLogs finds the daprd and app stdout capture files (<guid>_out) that
// Aspire's DCP writes inside sessionDir for the app with the given Dapr app-id.
// Either return value is "" when no matching resource is found.
func resolveDCPLogs(sessionDir, appID string) (daprdPath, appPath string) {
	entries, err := os.ReadDir(sessionDir)
	if err != nil {
		return "", ""
	}
	var resources []dcpResource
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, "resource-executable-") || !strings.HasSuffix(name, ".log") {
			continue
		}
		guid := strings.TrimSuffix(strings.TrimPrefix(name, "resource-executable-"), ".log")
		info, ok := parseDCPResourceLog(filepath.Join(sessionDir, name))
		if !ok {
			continue
		}
		resources = append(resources, dcpResource{guid: guid, info: info})
	}

	// daprd: the dapr/daprd resource whose args carry `run --app-id <appID>`.
	var daprdRes *dcpResource
	for i := range resources {
		r := &resources[i]
		base := filepath.Base(r.info.Cmd)
		if (base == "dapr" || base == "daprd") && argsHaveAppID(r.info.Args, appID) {
			daprdRes = r
			daprdPath = filepath.Join(sessionDir, r.guid+"_out")
			break
		}
	}
	if daprdRes == nil {
		return daprdPath, ""
	}

	// app: the sibling executable sharing the base name (daprd resource name minus
	// the trailing "-dapr-cli-<suffix>"), that is not itself a dapr process.
	appBase := dcpAppBaseName(daprdRes.info.Executable)
	for i := range resources {
		r := &resources[i]
		if r.guid == daprdRes.guid {
			continue
		}
		cmdBase := filepath.Base(r.info.Cmd)
		if cmdBase == "dapr" || cmdBase == "daprd" {
			continue
		}
		execName := strings.TrimPrefix(r.info.Executable, "/")
		if appBase != "" && strings.HasPrefix(execName, appBase+"-") && !strings.Contains(execName, "-dapr-cli-") {
			appPath = filepath.Join(sessionDir, r.guid+"_out")
			break
		}
	}
	return daprdPath, appPath
}

// parseDCPResourceLog reads a resource-executable-<guid>.log file and returns the
// resource info from its "Starting process..." line (the last one wins, so a
// restarted resource reflects its latest command).
func parseDCPResourceLog(path string) (dcpResourceInfo, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return dcpResourceInfo{}, false
	}
	var found dcpResourceInfo
	ok := false
	for _, line := range strings.Split(string(data), "\n") {
		idx := strings.Index(line, "{")
		if idx < 0 {
			continue
		}
		var info dcpResourceInfo
		if err := json.Unmarshal([]byte(line[idx:]), &info); err != nil {
			continue
		}
		if info.Cmd != "" {
			found = info
			ok = true
		}
	}
	return found, ok
}

// argsHaveAppID reports whether args contains the pair `--app-id <appID>`.
func argsHaveAppID(args []string, appID string) bool {
	for i, a := range args {
		if a == "--app-id" && i+1 < len(args) && args[i+1] == appID {
			return true
		}
	}
	return false
}

// dcpAppBaseName derives the app resource base name from a Dapr sidecar resource
// name by removing the leading "/" and the trailing "-dapr-cli-<suffix>".
// e.g. "/pr-digest-dapr-cli-yuha" -> "pr-digest".
func dcpAppBaseName(sidecarExecutable string) string {
	n := strings.TrimPrefix(sidecarExecutable, "/")
	if i := strings.Index(n, "-dapr-cli-"); i >= 0 {
		return n[:i]
	}
	return n
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test -tags unit ./pkg/discovery/ -run TestResolveDCPLogs -v`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add pkg/discovery/logsource.go pkg/discovery/logsource_test.go
git commit -m "feat(discovery): map DCP capture files to daprd/app logs"
```

---

### Task 3: Resolve standalone-run logs via `lsof`

**Files:**
- Modify: `pkg/discovery/logsource.go`
- Modify: `pkg/discovery/logsource_test.go`

**Interfaces:**
- Produces: `parseLsofStdout(out []byte) string`; `lsofStdoutFile(pid int) string`.

- [ ] **Step 1: Write the failing test for `parseLsofStdout`**

Add to `pkg/discovery/logsource_test.go`:

```go
func TestParseLsofStdout(t *testing.T) {
	t.Run("regular file", func(t *testing.T) {
		out := []byte("p58324\nf1\ntREG\nn/private/tmp/lsoftest.out\n")
		require.Equal(t, "/private/tmp/lsoftest.out", parseLsofStdout(out))
	})
	t.Run("pipe -> empty", func(t *testing.T) {
		out := []byte("p82640\nf1\ntPIPE\nn->0x4652e99aa6990ec3\n")
		require.Equal(t, "", parseLsofStdout(out))
	})
	t.Run("tty -> empty", func(t *testing.T) {
		out := []byte("p61604\nf1\ntCHR\nn/dev/ttys014\n")
		require.Equal(t, "", parseLsofStdout(out))
	})
	t.Run("empty input -> empty", func(t *testing.T) {
		require.Equal(t, "", parseLsofStdout(nil))
	})
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test -tags unit ./pkg/discovery/ -run TestParseLsofStdout -v`
Expected: FAIL — `undefined: parseLsofStdout`.

- [ ] **Step 3: Implement `parseLsofStdout` and `lsofStdoutFile`**

Append to `pkg/discovery/logsource.go` (extend the import block to include `os/exec` and `strconv`):

```go
// parseLsofStdout extracts the file path from `lsof -F ftn` output when the
// descriptor is a regular file (type "REG"). Returns "" for pipes, ttys ("CHR"),
// or unparseable output. lsof -F emits one field per line prefixed by a type
// character: 't' = descriptor type, 'n' = name.
func parseLsofStdout(out []byte) string {
	var typ string
	for _, line := range strings.Split(string(out), "\n") {
		if len(line) == 0 {
			continue
		}
		switch line[0] {
		case 't':
			typ = line[1:]
		case 'n':
			if typ == "REG" {
				return line[1:]
			}
		}
	}
	return ""
}

// lsofStdoutFile returns the filesystem path backing pid's stdout (fd 1) when it
// is a regular file, else "". It shells out to lsof, which is available on macOS
// and Linux (gopsutil's OpenFiles is not implemented on darwin).
func lsofStdoutFile(pid int) string {
	if pid <= 0 {
		return ""
	}
	out, err := exec.Command("lsof", "-p", strconv.Itoa(pid), "-a", "-d", "1", "-F", "ftn").Output()
	if err != nil {
		return ""
	}
	return parseLsofStdout(out)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test -tags unit ./pkg/discovery/ -run TestParseLsofStdout -v`
Expected: PASS (all four subtests).

- [ ] **Step 5: Commit**

```bash
git add pkg/discovery/logsource.go pkg/discovery/logsource_test.go
git commit -m "feat(discovery): resolve standalone-run stdout log via lsof"
```

---

### Task 4: Wire resolution into the discovery service

**Files:**
- Modify: `pkg/discovery/service.go:39-47` (struct + `New`), `:118-124` (enrich)
- Modify: `pkg/discovery/logsource_test.go`

**Interfaces:**
- Consumes: `resolveDCPLogs`, `dcpSessionDir`, `lsofStdoutFile`, `logFormatDCP`, `logFormatPlain`, `appProcResolver.CommandForPort`.
- Produces: `service.stdoutFile func(pid int) string` field; `(*service).resolveLogSources(*Instance)`.

- [ ] **Step 1: Add the `stdoutFile` seam to the service struct and `New`**

In `pkg/discovery/service.go`, change the struct (lines 39-43) to:

```go
type service struct {
	scan       Scanner
	client     *http.Client
	appProc    appProcResolver
	stdoutFile func(pid int) string
}
```

And change `New` (lines 45-47) to:

```go
func New(scan Scanner, client *http.Client) Service {
	return &service{scan: scan, client: client, appProc: gopsutilResolver{}, stdoutFile: lsofStdoutFile}
}
```

- [ ] **Step 2: Call `resolveLogSources` from `enrich`**

In `pkg/discovery/service.go`, in `enrich`, replace the existing block (lines 119-124):

```go
	if md.AppLogPath != "" {
		in.AppLogPath = md.AppLogPath
	}
	if md.DaprdLogPath != "" {
		in.DaprdLogPath = md.DaprdLogPath
	}
```

with:

```go
	if md.AppLogPath != "" {
		in.AppLogPath, in.AppLogFormat = md.AppLogPath, logFormatPlain
	}
	if md.DaprdLogPath != "" {
		in.DaprdLogPath, in.DaprdLogFormat = md.DaprdLogPath, logFormatPlain
	}
	s.resolveLogSources(&in)
```

- [ ] **Step 3: Implement `resolveLogSources`**

Add this method to `pkg/discovery/service.go` (e.g. immediately after `enrich`):

```go
// resolveLogSources fills in AppLogPath/DaprdLogPath (and their formats) when the
// sidecar's metadata reported none. Aspire apps get their logs from the DCP
// session dir; standalone `dapr run` gets them from the process's stdout when it
// is a regular file (i.e. redirected to a file rather than a terminal).
func (s *service) resolveLogSources(in *Instance) {
	if in.DaprdLogPath != "" && in.AppLogPath != "" {
		return
	}

	// Aspire: locate the DCP session dir from the app-port listener command.
	if in.IsAspire && s.appProc != nil && in.AppPort != 0 {
		if cmd, ok := s.appProc.CommandForPort(in.AppPort); ok {
			if dir, ok := dcpSessionDir(cmd); ok {
				daprdPath, appPath := resolveDCPLogs(dir, in.AppID)
				if in.DaprdLogPath == "" && daprdPath != "" {
					in.DaprdLogPath, in.DaprdLogFormat = daprdPath, logFormatDCP
				}
				if in.AppLogPath == "" && appPath != "" {
					in.AppLogPath, in.AppLogFormat = appPath, logFormatDCP
				}
			}
		}
	}

	// Standalone dapr run: stdout is tailable only if redirected to a regular file.
	if s.stdoutFile == nil {
		return
	}
	if in.DaprdLogPath == "" && in.DaprdPID != 0 {
		if p := s.stdoutFile(in.DaprdPID); p != "" {
			in.DaprdLogPath, in.DaprdLogFormat = p, logFormatPlain
		}
	}
	if in.AppLogPath == "" && in.AppPID != 0 {
		if p := s.stdoutFile(in.AppPID); p != "" {
			in.AppLogPath, in.AppLogFormat = p, logFormatPlain
		}
	}
}
```

- [ ] **Step 4: Write the failing test for `resolveLogSources`**

Add to `pkg/discovery/logsource_test.go`:

```go
func TestResolveLogSources_Aspire(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "resource-executable-AAA.log"),
		[]byte(`x	info	r	Starting process...	{"Executable":"/pr-digest-dapr-cli-yuha","Cmd":"/usr/local/bin/dapr","Args":["run","--app-id","pr-digest"]}`+"\n"), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "AAA_out"), []byte("d\n"), 0o600))

	dcpCmd := "/x/tools/dcp run-controllers --kubeconfig " + filepath.Join(dir, "kubeconfig")
	s := &service{appProc: fakeResolver{cmd: dcpCmd, ok: true}}
	in := Instance{AppID: "pr-digest", IsAspire: true, AppPort: 5090}
	s.resolveLogSources(&in)

	require.Equal(t, filepath.Join(dir, "AAA_out"), in.DaprdLogPath)
	require.Equal(t, logFormatDCP, in.DaprdLogFormat)
}

func TestResolveLogSources_StandaloneRegularFile(t *testing.T) {
	s := &service{stdoutFile: func(pid int) string {
		if pid == 111 {
			return "/tmp/app.out"
		}
		return ""
	}}
	in := Instance{AppID: "x", DaprdPID: 111}
	s.resolveLogSources(&in)

	require.Equal(t, "/tmp/app.out", in.DaprdLogPath)
	require.Equal(t, logFormatPlain, in.DaprdLogFormat)
}

func TestResolveLogSources_StandaloneTTYLeavesEmpty(t *testing.T) {
	s := &service{stdoutFile: func(int) string { return "" }}
	in := Instance{AppID: "x", DaprdPID: 111}
	s.resolveLogSources(&in)

	require.Equal(t, "", in.DaprdLogPath)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `go test -tags unit ./pkg/discovery/ -run TestResolveLogSources -v`
Expected: PASS (all three tests). (Implementation from Steps 1-3 is already in place.)

- [ ] **Step 6: Run the full discovery package to check for regressions**

Run: `go test -tags unit -race ./pkg/discovery/`
Expected: `ok` — existing golden/service tests still pass (new fields use `omitempty`).

- [ ] **Step 7: Commit**

```bash
git add pkg/discovery/service.go pkg/discovery/logsource_test.go
git commit -m "feat(discovery): resolve Aspire/standalone log sources in enrich"
```

---

### Task 5: Normalize DCP lines in the SSE log handler

**Files:**
- Modify: `pkg/server/logs.go`
- Create: `pkg/server/logs_test.go`

**Interfaces:**
- Consumes: `Instance.DaprdLogFormat`, `Instance.AppLogFormat`.
- Produces: `normalizeLine(line, format string) string`.

- [ ] **Step 1: Write the failing test for `normalizeLine`**

Create `pkg/server/logs_test.go`:

```go
//go:build unit

package server

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestNormalizeLine(t *testing.T) {
	t.Run("dcp daprd line -> standard daprd format", func(t *testing.T) {
		in := `3 2026-06-30T19:51:27.797Z time="2026..." level=info msg="hi" app_id=pr-digest`
		want := `time="2026..." level=info msg="hi" app_id=pr-digest`
		require.Equal(t, want, normalizeLine(in, "dcp"))
	})
	t.Run("dcp app line -> ansi stripped", func(t *testing.T) {
		in := "1 2026-06-30T19:51:31.768Z \x1b[33mwarn\x1b[39m: Dapr.Workflow"
		require.Equal(t, "warn: Dapr.Workflow", normalizeLine(in, "dcp"))
	})
	t.Run("plain strips ansi only, keeps content", func(t *testing.T) {
		require.Equal(t, "level=info msg=x", normalizeLine("level=info msg=x", "plain"))
		require.Equal(t, "hello", normalizeLine("\x1b[31mhello\x1b[0m", "plain"))
	})
	t.Run("empty format treated as plain", func(t *testing.T) {
		require.Equal(t, "abc", normalizeLine("abc", ""))
	})
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test -tags unit ./pkg/server/ -run TestNormalizeLine -v`
Expected: FAIL — `undefined: normalizeLine`.

- [ ] **Step 3: Implement `normalizeLine`**

In `pkg/server/logs.go`, add `"regexp"` to the import block, and add these package-level vars and function (e.g. above `logsHandler`):

```go
var (
	ansiRE      = regexp.MustCompile(`\x1b\[[0-9;]*m`)
	dcpPrefixRE = regexp.MustCompile(`^\d+\s+\S+Z\s+`)
)

// normalizeLine cleans a captured log line for display. For DCP-captured lines
// (format "dcp") it strips the leading "<seq> <RFC3339-UTC> " prefix that Aspire's
// orchestrator prepends. For all formats it strips ANSI color escape codes.
func normalizeLine(line, format string) string {
	if format == "dcp" {
		line = dcpPrefixRE.ReplaceAllString(line, "")
	}
	return ansiRE.ReplaceAllString(line, "")
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test -tags unit ./pkg/server/ -run TestNormalizeLine -v`
Expected: PASS (all subtests).

- [ ] **Step 5: Apply normalization in the stream loop**

In `pkg/server/logs.go`, `logsHandler`: after `source`/`path` are chosen (after line 33, before the `if path == ""` check), capture the format for the chosen source:

```go
		format := in.DaprdLogFormat
		if source == "app" {
			format = in.AppLogFormat
		}
```

Then change the SSE write (line 63) from:

```go
				_, _ = fmt.Fprintf(w, "data: %s\n\n", line)
```

to:

```go
				_, _ = fmt.Fprintf(w, "data: %s\n\n", normalizeLine(line, format))
```

- [ ] **Step 6: Build and run the server package tests**

Run: `go build ./... && go test -tags unit -race ./pkg/server/`
Expected: build succeeds; `ok`.

- [ ] **Step 7: Commit**

```bash
git add pkg/server/logs.go pkg/server/logs_test.go
git commit -m "feat(server): normalize DCP-captured log lines in SSE stream"
```

---

### Task 6: Correct the frontend "no log file" copy

**Files:**
- Modify: `web/src/pages/Logs.tsx:361-366`

**Interfaces:**
- Consumes: nothing new (backend now populates `appLogPath`/`daprdLogPath`; `hasPath` already keys off them).

- [ ] **Step 1: Update the empty-state message**

In `web/src/pages/Logs.tsx`, replace the block at lines 361-366:

```tsx
      {appId && !isLoading && app && !hasPath && (
        <div className="card">
          No log file — this app was started with <code className="mono">dapr run</code> without{' '}
          <code className="mono">-f</code>
        </div>
      )}
```

with:

```tsx
      {appId && !isLoading && app && !hasPath && (
        <div className="card">
          No captured log file — this app streams its logs to the terminal. Redirect{' '}
          <code className="mono">dapr run</code> output to a file, or use a{' '}
          <code className="mono">-f</code> run template, to view logs here.
        </div>
      )}
```

- [ ] **Step 2: Build the frontend to verify it compiles**

Run: `cd web && npm install && npm run build`
Expected: build succeeds with no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/Logs.tsx
git commit -m "fix(web): accurate empty-state copy on the Logs page"
```

---

### Task 7: End-to-end verification against a live app

**Files:** none (manual verification; no code changes).

This task has no automated test — it verifies the feature against real processes. Requires the dashboard running on the host and at least one dapr/Aspire app running.

- [ ] **Step 1: Run the full test suite**

Run: `make test-go`
Expected: all Go packages report `ok`.

- [ ] **Step 2: Start the dashboard and verify an Aspire app**

Start the dashboard (per the repo README) with an Aspire app running (e.g. the `PrDigest` sample: `aspire run` in that project). In the dashboard:
- Open the Logs page, select the Aspire app.
- Set source to `daprd only`: confirm Dapr runtime lines stream and are level-colored (no `<seq> <timestamp>` prefix, no raw ANSI codes).
- Set source to `app only`: confirm the app's own log lines stream and are readable (ANSI stripped).

Expected: both sources show live, clean logs.

- [ ] **Step 3: Verify a redirected standalone `dapr run`**

In a terminal: `dapr run --app-id verifytest --dapr-http-port 3597 -- sleep 300 > /tmp/verifytest.out 2>&1 &`
In the dashboard Logs page, select `verifytest`, source `daprd only`.
Expected: daprd startup lines appear (resolved via the FD/`lsof` path).
Cleanup: `pkill -f "app-id verifytest"`.

- [ ] **Step 4: Verify no regression for `dapr run -f`**

If a `dapr run -f <template>` app is available, confirm its logs still stream as before.
Expected: unchanged behavior.

- [ ] **Step 5: Commit (docs/notes only, if any)**

No code change expected. If verification surfaced issues, file them as follow-up tasks rather than expanding this plan.

---

## Self-Review

**Spec coverage:**
- Layered resolution (metadata → DCP → FD): Tasks 2, 3, 4. ✅
- DCP session dir from `--kubeconfig`: Task 1. ✅
- daprd/app mapping incl. app-id ≠ resource-name: Task 2 (both tests). ✅
- Standalone via lsof, regular-file only: Task 3 + Task 4. ✅
- `Instance` format fields (`omitempty`): Task 1. ✅
- Backend normalization (dcp prefix + ANSI): Task 5. ✅
- Frontend copy: Task 6. ✅
- Testing (unit + manual verification): Tasks 1-5 unit, Task 7 manual. ✅
- Constraints (host access, ephemeral session dir): honored — resolution runs per enrich (no caching), and reuses existing host-scanning resolvers.

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✅

**Type consistency:** `resolveDCPLogs(sessionDir, appID) (daprdPath, appPath string)`, `dcpSessionDir(cmd) (string, bool)`, `parseLsofStdout([]byte) string`, `lsofStdoutFile(int) string`, `normalizeLine(string, string) string`, `service.stdoutFile func(int) string`, and format constants `logFormatPlain`/`logFormatDCP` are used identically across Tasks 1-5. ✅
