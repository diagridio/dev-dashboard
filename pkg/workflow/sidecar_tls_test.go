//go:build unit

package workflow

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
)

// startTLSHub serves hub over TLS with httptest's certificate (valid for
// 127.0.0.1) and returns its address plus a root pool that trusts it.
func startTLSHub(t *testing.T, hub *fakeHub) (string, *x509.CertPool) {
	t.Helper()
	ts := httptest.NewUnstartedServer(http.NotFoundHandler())
	ts.StartTLS()
	cert := ts.TLS.Certificates[0]
	roots := ts.Client().Transport.(*http.Transport).TLSClientConfig.RootCAs
	ts.Close()

	lis, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	srv := grpc.NewServer(grpc.Creds(credentials.NewTLS(&tls.Config{Certificates: []tls.Certificate{cert}})))
	protos.RegisterTaskHubSidecarServiceServer(srv, hub)
	go func() { _ = srv.Serve(lis) }()
	t.Cleanup(srv.Stop)
	return lis.Addr().String(), roots
}

// A TLS-only sidecar (e.g. behind a TLS proxy) is read over TLS when the
// endpoint asks for it, and a plaintext connection to it fails (skipped).
func TestSidecarPool_TLSEndpoint(t *testing.T) {
	withShortSidecarTimeout(t)
	addr, roots := startTLSHub(t, completedHub("w1"))
	pool := NewSidecarPool()
	pool.tlsRoots = roots
	t.Cleanup(func() { _ = pool.Close() })

	res, err := pool.Service(endpoints(SidecarEndpoint{AppID: "secure", Addr: addr, TLS: true})).List(context.Background(), ListQuery{})
	require.NoError(t, err)
	require.Len(t, res.Items, 1)

	res, err = pool.Service(endpoints(SidecarEndpoint{AppID: "secure", Addr: addr})).List(context.Background(), ListQuery{})
	require.NoError(t, err)
	require.Empty(t, res.Items, "plaintext to a TLS sidecar must not succeed")
}

// TLS and plaintext connections to the same address are cached separately.
func TestSidecarPool_ConnForKeysByTLS(t *testing.T) {
	pool := NewSidecarPool()
	t.Cleanup(func() { _ = pool.Close() })
	plain, err := pool.ConnFor("127.0.0.1:1", false)
	require.NoError(t, err)
	secure, err := pool.ConnFor("127.0.0.1:1", true)
	require.NoError(t, err)
	require.NotSame(t, plain, secure)
	again, err := pool.ConnFor("127.0.0.1:1", true)
	require.NoError(t, err)
	require.Same(t, secure, again)
}
