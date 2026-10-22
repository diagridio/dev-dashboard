//go:build unit

package cmd

import (
	"errors"
	"net"
	"os"
	"syscall"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestListenErrorExplainsAPortInUse(t *testing.T) {
	taken, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer taken.Close()
	_, err = net.Listen("tcp", taken.Addr().String())
	require.Error(t, err)

	got := listenError(err, "127.0.0.1:9090", 9090, "http://127.0.0.1:9090/")
	require.Equal(t, `port 9090 is already in use (127.0.0.1:9090).
  - Is the Diagrid Dapr Dev Dashboard already running elsewhere, for example in another terminal?
    If so, open http://127.0.0.1:9090/ or stop that instance first.
  - If not, another program is using the port. Start the dashboard on a different port:
    diagrid-dev-dashboard --port 9091`, got.Error())
	require.ErrorIs(t, got, err, "the original error stays wrapped")
}

func TestListenErrorRecognisesTheWindowsErrno(t *testing.T) {
	const wsaeaddrinuse = syscall.Errno(10048)
	err := &net.OpError{Op: "listen", Net: "tcp", Err: os.NewSyscallError("bind", wsaeaddrinuse)}
	require.Contains(t, listenError(err, "127.0.0.1:9090", 9090, "http://127.0.0.1:9090/").Error(), "port 9090 is already in use")
}

func TestListenErrorLeavesOtherErrorsAlone(t *testing.T) {
	other := errors.New("listen tcp: lookup nowhere: no such host")
	got := listenError(other, "nowhere:9090", 9090, "http://nowhere:9090/")
	require.EqualError(t, got, "listen on nowhere:9090: listen tcp: lookup nowhere: no such host")
	require.ErrorIs(t, got, other)
}
