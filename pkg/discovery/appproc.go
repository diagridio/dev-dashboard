package discovery

import (
	"strings"

	gnet "github.com/shirou/gopsutil/net"
	gproc "github.com/shirou/gopsutil/process"
)

// appProcResolver resolves the full command line of the local process listening
// on a TCP port. It isolates the OS-level lookup so it can be faked in tests.
type appProcResolver interface {
	CommandForPort(port int) (string, bool)
}

// isAspireProxy reports whether cmd is the .NET Aspire Developer Control Plane
// (DCP) proxy. Aspire fronts every app process with this proxy, so when daprd's
// --app-port points at it, the app is Aspire-managed (and .NET-hosted).
func isAspireProxy(cmd string) bool {
	c := strings.ToLower(cmd)
	return strings.Contains(c, "aspire.hosting.orchestration") ||
		(strings.Contains(c, "dcp") && strings.Contains(c, "run-controllers"))
}

// appRuntime determines an app's runtime. It first tries InferRuntime on the
// daprd-reported command; if that is "unknown" (e.g. the app was launched
// outside dapr-run, as with .NET Aspire, so daprd carries no app command) it
// falls back to inspecting the process listening on the app port.
func appRuntime(command string, appPort int, r appProcResolver) string {
	rt := InferRuntime(command)
	if rt != "unknown" || appPort == 0 || r == nil {
		return rt
	}
	cmd, ok := r.CommandForPort(appPort)
	if !ok {
		return rt
	}
	if rt2 := InferRuntime(cmd); rt2 != "unknown" {
		return rt2
	}
	// .NET Aspire fronts apps with the DCP proxy, so the app-port listener is
	// dcp, not the app itself. Treat that as a .NET (Aspire-hosted) app.
	if isAspireProxy(cmd) {
		return "dotnet"
	}
	return rt
}

// gopsutilResolver is the default appProcResolver, backed by gopsutil.
//
// NOTE (verify on macOS): net.Connections may require elevated privileges on
// some platforms. On failure CommandForPort returns ("", false), so the runtime
// simply stays "unknown" — never worse than before this fallback existed.
type gopsutilResolver struct{}

func (gopsutilResolver) CommandForPort(port int) (string, bool) {
	conns, err := gnet.Connections("inet")
	if err != nil {
		return "", false
	}
	for _, c := range conns {
		if c.Status == "LISTEN" && int(c.Laddr.Port) == port && c.Pid != 0 {
			p, err := gproc.NewProcess(c.Pid)
			if err != nil {
				continue
			}
			cmd, err := p.Cmdline()
			if err != nil || cmd == "" {
				continue
			}
			return cmd, true
		}
	}
	return "", false
}
