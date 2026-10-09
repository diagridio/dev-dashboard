package cmd

import (
	"errors"
	"fmt"
	"syscall"
)

// wsaeaddrinuse is Windows' "address already in use" (WSAEADDRINUSE), which
// syscall.EADDRINUSE does not match there.
const wsaeaddrinuse = syscall.Errno(10048)

func isAddrInUse(err error) bool {
	return errors.Is(err, syscall.EADDRINUSE) || errors.Is(err, wsaeaddrinuse)
}

// portInUseError explains what to do when the dashboard's port is taken. It
// most often means another dashboard is running, so that comes first.
type portInUseError struct {
	port int
	addr string
	url  string
	err  error
}

func (e *portInUseError) Error() string {
	return fmt.Sprintf(`port %d is already in use (%s).
  - Is the Diagrid Dapr Dev Dashboard already running elsewhere, for example in another terminal?
    If so, open %s or stop that instance first.
  - If not, another program is using the port. Start the dashboard on a different port:
    diagrid-dev-dashboard --port %d`, e.port, e.addr, e.url, e.port+1)
}

func (e *portInUseError) Unwrap() error { return e.err }

// listenError describes a failure to bind the dashboard's address.
func listenError(err error, addr string, port int, url string) error {
	if isAddrInUse(err) {
		return &portInUseError{port: port, addr: addr, url: url, err: err}
	}
	return fmt.Errorf("listen on %s: %w", addr, err)
}
