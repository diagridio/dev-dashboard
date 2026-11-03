package discovery

import (
	"path/filepath"
	"strings"

	gproc "github.com/shirou/gopsutil/v4/process"
)

// configFromArgs returns the Configuration file daprd was started with, from
// its --config flag. The Dapr CLI resolves a run template's configFilePath
// (relative to the template dir or the app's appDirPath) to an absolute path
// before launching daprd, but a plain `dapr run --config ./x.yaml` passes the
// path through, so a relative value is resolved against daprd's cwd.
// Returns "" when the flag is absent.
func configFromArgs(args []string, cwd string) string {
	var path string
	for i, a := range args {
		name, value, hasValue := strings.Cut(strings.TrimLeft(a, "-"), "=")
		if !strings.HasPrefix(a, "-") || name != "config" {
			continue
		}
		if !hasValue {
			if i+1 >= len(args) {
				break
			}
			value = args[i+1]
		}
		path = value
		break
	}
	if path == "" {
		return ""
	}
	if !filepath.IsAbs(path) && cwd != "" {
		path = filepath.Join(cwd, path)
	}
	return filepath.Clean(path)
}

// gopsutilDaprdConfig reads the --config path from a running daprd's command
// line. Returns "" when the process can't be inspected or has no --config.
func gopsutilDaprdConfig(pid int) string {
	if pid <= 0 {
		return ""
	}
	p, err := gproc.NewProcess(int32(pid))
	if err != nil {
		return ""
	}
	args, err := p.CmdlineSlice()
	if err != nil {
		return ""
	}
	cwd, _ := p.Cwd()
	return configFromArgs(args, cwd)
}
