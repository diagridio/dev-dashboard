package discovery

import (
	"net"
	"net/url"
	"strconv"
)

// contractAppProbeAddr is where the dashboard can reach a contract app's port
// from inside the compose network. daprd's channel address is how the
// sidecar reaches the app: a loopback (or empty) address means they share a
// network namespace, so the app answers on the namespace owner's name, which
// is the host of the sidecar's base URL. Any other channel address is a
// service name the dashboard can resolve too. "" when the app has no port.
func contractAppProbeAddr(baseURL, channel string, port int) string {
	if port <= 0 {
		return ""
	}
	host := channel
	switch channel {
	case "", "127.0.0.1", "localhost", "::1":
		u, err := url.Parse(baseURL)
		if err != nil || u.Hostname() == "" {
			return ""
		}
		host = u.Hostname()
	}
	return net.JoinHostPort(host, strconv.Itoa(port))
}

// contractAppStatus derives a contract app's status from what the sidecar
// network can observe: a TCP probe of its app port, else a connected
// workflow worker. Without either signal it returns "" (unknown) rather than
// implying the app is up — a worker-only app that exited looks the same as
// an app that never connects to its sidecar.
func (s *service) contractAppStatus(baseURL string, md Metadata) string {
	if addr := contractAppProbeAddr(baseURL, md.AppChannelAddress, md.AppPort); addr != "" && s.addrOpen != nil {
		if s.addrOpen(addr) {
			return StatusRunning
		}
		return StatusStopped
	}
	if md.WorkflowWorkers > 0 {
		return StatusRunning
	}
	return ""
}
