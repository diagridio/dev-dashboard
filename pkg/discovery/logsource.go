package discovery

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	logFormatPlain = "plain"
	logFormatDCP   = "dcp"
)

// dcpSessionDir extracts the Aspire DCP session directory from a dcp process
// command line by reading its `--kubeconfig <dir>/kubeconfig` flag. The session
// directory is the parent of the kubeconfig file. Returns ("", false) when the
// flag is absent or has no value.
//
// cmd comes from gopsutil's Cmdline, which (on darwin via `ps -o command`) joins
// argv with single spaces and no quoting, so a path containing spaces is
// indistinguishable from separate arguments. We therefore take the flag value up
// to the next ` --` flag boundary (or end of string) rather than the next space,
// so paths like "/Users/First Last/..." survive. Residual limitation: a path
// that itself contains " --" is still truncated at that point.
func dcpSessionDir(cmd string) (string, bool) {
	const flag = "--kubeconfig"
	idx := strings.Index(cmd, flag)
	// Require a token boundary before the flag so e.g. "--not--kubeconfig" doesn't match.
	for idx > 0 && cmd[idx-1] != ' ' {
		next := strings.Index(cmd[idx+1:], flag)
		if next < 0 {
			return "", false
		}
		idx += 1 + next
	}
	if idx < 0 {
		return "", false
	}
	rest := cmd[idx+len(flag):]
	switch {
	case strings.HasPrefix(rest, "="):
		rest = rest[1:]
	case strings.HasPrefix(rest, " "):
		rest = strings.TrimLeft(rest, " ")
	default:
		// e.g. "--kubeconfig-other" or flag at end of string with no value.
		return "", false
	}
	if end := strings.Index(rest, " --"); end >= 0 {
		rest = rest[:end]
	}
	value := strings.TrimRight(rest, " ")
	if value == "" || strings.HasPrefix(value, "--") {
		return "", false
	}
	return filepath.Dir(value), true
}

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
		// The "-dapr-cli-" infix is a DCP naming convention observed empirically (not a stable public API).
		if appBase == "" || !strings.HasPrefix(execName, appBase+"-") || strings.Contains(execName, "-dapr-cli-") {
			continue
		}
		// Require an exact base match: the suffix after "<appBase>-" must be a single
		// opaque token with no dash (e.g. "order-zfzg"), so "order-worker-abcd"
		// (remainder "worker-abcd" contains a dash) does not mis-match app "order".
		remainder := execName[len(appBase)+1:]
		if strings.Contains(remainder, "-") {
			continue
		}
		appPath = filepath.Join(sessionDir, r.guid+"_out")
		break
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
