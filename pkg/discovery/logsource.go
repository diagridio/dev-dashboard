package discovery

import (
	"encoding/json"
	"os"
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
