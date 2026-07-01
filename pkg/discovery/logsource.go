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
