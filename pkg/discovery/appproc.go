package discovery

import (
	"fmt"
	"net"
	"strings"
	"time"

	gnet "github.com/shirou/gopsutil/net"
	gproc "github.com/shirou/gopsutil/process"
)

// appProcResolver resolves the local process listening on a TCP port. It
// isolates the OS-level lookup so it can be faked in tests.
type appProcResolver interface {
	CommandForPort(port int) (string, bool)
	// PIDForPort returns the PID of the port's LISTEN process.
	PIDForPort(port int) (int, bool)
}

// isAspireProxy reports whether cmd is the .NET Aspire Developer Control Plane
// (DCP) proxy. Aspire fronts every app process with this proxy, so when daprd's
// --app-port points at it, the app is Aspire-managed (and .NET-hosted).
func isAspireProxy(cmd string) bool {
	c := strings.ToLower(cmd)
	return strings.Contains(c, "aspire.hosting.orchestration") ||
		(strings.Contains(c, "dcp") && strings.Contains(c, "run-controllers"))
}

// appRuntime determines an app's runtime and whether it is Aspire-managed. It
// first tries InferRuntime on the daprd-reported command; if that is "unknown"
// (e.g. the app was launched outside dapr-run, as with .NET Aspire, so daprd
// carries no app command) it falls back to inspecting the process listening on
// the app port. isAspire is true only when that listener is the Aspire DCP proxy.
func appRuntime(command string, appPort int, r appProcResolver) (runtime string, isAspire bool) {
	rt := InferRuntime(command)
	if rt != "unknown" || appPort == 0 || r == nil {
		return rt, false
	}
	cmd, ok := r.CommandForPort(appPort)
	if !ok {
		return rt, false
	}
	if rt2 := InferRuntime(cmd); rt2 != "unknown" {
		return rt2, false
	}
	// .NET Aspire fronts apps with the DCP proxy, so the app-port listener is
	// dcp, not the app itself. Treat that as a .NET (Aspire-hosted) app.
	if isAspireProxy(cmd) {
		return "dotnet", true
	}
	return rt, false
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

func (gopsutilResolver) PIDForPort(port int) (int, bool) {
	conns, err := gnet.Connections("inet")
	if err != nil {
		return 0, false
	}
	for _, c := range conns {
		if c.Status == "LISTEN" && int(c.Laddr.Port) == port && c.Pid != 0 {
			return int(c.Pid), true
		}
	}
	return 0, false
}

// gopsutilProcStart resolves a process's start time from its PID.
func gopsutilProcStart(pid int) (time.Time, bool) {
	p, err := gproc.NewProcess(int32(pid))
	if err != nil {
		return time.Time{}, false
	}
	ms, err := p.CreateTime() // milliseconds since epoch
	if err != nil || ms <= 0 {
		return time.Time{}, false
	}
	return time.UnixMilli(ms), true
}

// gopsutilPidAlive reports whether pid exists in the process table.
func gopsutilPidAlive(pid int) bool {
	ok, err := gproc.PidExists(int32(pid))
	return err == nil && ok
}

// tcpPortOpen probes a loopback TCP port; a refused dial fails immediately,
// so the timeout only bites for half-open ports (absent on loopback).
func tcpPortOpen(port int) bool {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 200*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}
