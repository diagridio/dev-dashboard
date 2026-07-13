//go:build unit

package discovery

import (
	"reflect"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestParseDaprdArgs(t *testing.T) {
	tests := []struct {
		name string
		argv []string
		want daprdArgs
		ok   bool
	}{
		{
			name: "saga compose style single-dash space-separated",
			argv: []string{"./daprd", "-app-id", "primes-go", "-app-channel-address", "primes-go",
				"-app-port", "8080", "-dapr-http-port", "3500", "-dapr-grpc-port", "50001",
				"-placement-host-address", "placement:50005",
				"-resources-path", "/components", "-config", "/dapr_config/config.yml",
				"-log-level", "info"},
			want: daprdArgs{AppID: "primes-go", AppChannelAddress: "primes-go",
				ResourcesPath: "/components", ConfigPath: "/dapr_config/config.yml",
				AppPort: 8080, HTTPPort: 3500, GRPCPort: 50001},
			ok: true,
		},
		{
			name: "double-dash equals forms with absolute binary path",
			argv: []string{"/daprd", "--app-id=orders", "--dapr-http-port=3501", "--components-path=/comps"},
			want: daprdArgs{AppID: "orders", ResourcesPath: "/comps", HTTPPort: 3501, GRPCPort: 50001},
			ok:   true,
		},
		{
			name: "defaults applied when port flags absent",
			argv: []string{"./daprd", "-app-id", "web"},
			want: daprdArgs{AppID: "web", HTTPPort: 3500, GRPCPort: 50001},
			ok:   true,
		},
		{
			name: "not daprd",
			argv: []string{"./placement", "-port", "50005"},
			ok:   false,
		},
		{
			name: "empty argv",
			argv: nil,
			ok:   false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := parseDaprdArgs(tt.argv)
			if ok != tt.ok {
				t.Fatalf("ok = %v, want %v", ok, tt.ok)
			}
			if ok && !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestParseDaprdArgs_AppProtocol(t *testing.T) {
	args, ok := parseDaprdArgs([]string{"./daprd", "--app-id", "a", "--app-protocol", "grpc"})
	require.True(t, ok)
	require.Equal(t, "grpc", args.AppProtocol)
}
