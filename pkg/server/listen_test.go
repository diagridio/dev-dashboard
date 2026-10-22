//go:build unit

package server

import (
	"context"
	"io"
	"net"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestListenFailsWhenAddressInUse(t *testing.T) {
	taken, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer taken.Close()

	err = New(taken.Addr().String(), Options{}).Listen()
	require.Error(t, err)
}

func TestStartServesOnTheListenedAddress(t *testing.T) {
	srv := New("127.0.0.1:0", Options{})
	require.NoError(t, srv.Listen())
	errCh := make(chan error, 1)
	go func() { errCh <- srv.Start() }()

	resp, err := http.Get("http://" + srv.Addr() + "/")
	require.NoError(t, err)
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()

	require.NoError(t, srv.Shutdown(context.Background()))
	require.NoError(t, <-errCh)
}
