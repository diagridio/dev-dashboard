//go:build unit

package cmd

import (
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestResolveMode(t *testing.T) {
	env := func(vals map[string]string) func(string) string {
		return func(k string) string { return vals[k] }
	}
	tests := []struct {
		name    string
		flag    string
		env     map[string]string
		want    Mode
		wantErr bool
	}{
		{name: "unset everywhere is default", flag: "", env: nil, want: ModeDefault},
		{name: "flag aspire", flag: "aspire", env: nil, want: ModeAspire},
		{name: "flag dapr-run", flag: "dapr-run", env: nil, want: ModeDaprRun},
		{name: "flag compose", flag: "compose", env: nil, want: ModeCompose},
		{name: "flag test-containers", flag: "test-containers", env: nil, want: ModeTestcontainers},
		{name: "env aspire", flag: "", env: map[string]string{"DEVDASHBOARD_MODE": "aspire"}, want: ModeAspire},
		{name: "env compose", flag: "", env: map[string]string{"DEVDASHBOARD_MODE": "compose"}, want: ModeCompose},
		{name: "flag wins over env", flag: "aspire", env: map[string]string{"DEVDASHBOARD_MODE": "bogus"}, want: ModeAspire},
		{name: "unknown flag value errors", flag: "dapr", wantErr: true},
		{name: "unknown env value errors", env: map[string]string{"DEVDASHBOARD_MODE": "docker"}, wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := resolveMode(tc.flag, env(tc.env))
			if tc.wantErr {
				if err == nil {
					t.Fatalf("want error, got %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
}

func TestContainerPosture(t *testing.T) {
	withContract := func(k string) string {
		if k == "DEVDASHBOARD_APP_COUNT" {
			return "2"
		}
		return ""
	}
	none := func(string) string { return "" }
	if !containerPosture(ModeAspire, withContract) {
		t.Fatal("aspire + contract must be container posture")
	}
	if containerPosture(ModeAspire, none) {
		t.Fatal("aspire without the contract must stay host posture")
	}
	if containerPosture(ModeCompose, withContract) {
		t.Fatal("non-aspire modes are never container posture")
	}
	if containerPosture(ModeDefault, withContract) {
		t.Fatal("mode-unset is never container posture")
	}
}

func TestListenAddr(t *testing.T) {
	tests := []struct {
		bind string
		port int
		want string
	}{
		{"127.0.0.1", 9090, "127.0.0.1:9090"},
		{"::", 8080, "[::]:8080"},
		{"0.0.0.0", 8080, "0.0.0.0:8080"},
	}
	for _, tc := range tests {
		if got := listenAddr(tc.bind, tc.port); got != tc.want {
			t.Fatalf("listenAddr(%q,%d)=%q want %q", tc.bind, tc.port, got, tc.want)
		}
	}
}

func TestResolveServeSettings(t *testing.T) {
	noneChanged := func(string) bool { return false }
	tests := []struct {
		name       string
		container  bool
		changed    func(string) bool
		port       int
		bind       string
		stateStore string
		namespace  string
		env        map[string]string
		want       serveSettings
	}{
		{
			name:    "default mode keeps host defaults",
			changed: noneChanged, port: 9090, bind: "127.0.0.1",
			want: serveSettings{Port: 9090, Bind: "127.0.0.1", Namespace: "default"},
		},
		{
			name:      "aspire mode defaults to 8080 on 0.0.0.0",
			container: true, changed: noneChanged, port: 9090, bind: "127.0.0.1",
			want: serveSettings{Port: 8080, Bind: "0.0.0.0", Namespace: "default"},
		},
		{
			name:      "env overrides aspire defaults",
			container: true, changed: noneChanged, port: 9090, bind: "127.0.0.1",
			env: map[string]string{
				"DEVDASHBOARD_PORT":            "9999",
				"DEVDASHBOARD_BIND":            "127.0.0.1",
				"DEVDASHBOARD_STATESTORE_FILE": "/app/components/state.yaml",
				"DEVDASHBOARD_NAMESPACE":       "team-a",
			},
			want: serveSettings{Port: 9999, Bind: "127.0.0.1", StateStore: "/app/components/state.yaml",
				Namespace: "team-a", ResourcesPaths: []string{"/app/components"}},
		},
		{
			name:      "changed flag beats env",
			container: true, changed: func(f string) bool { return f == "port" }, port: 7000, bind: "127.0.0.1",
			env:  map[string]string{"DEVDASHBOARD_PORT": "9999"},
			want: serveSettings{Port: 7000, Bind: "0.0.0.0", Namespace: "default"},
		},
		{
			name:      "explicit resources path splits on list separator",
			container: true, changed: noneChanged, port: 9090, bind: "127.0.0.1",
			env: map[string]string{
				"DEVDASHBOARD_RESOURCES_PATH": "/mnt/a" + string(os.PathListSeparator) + "/mnt/b",
			},
			want: serveSettings{Port: 8080, Bind: "0.0.0.0", Namespace: "default",
				ResourcesPaths: []string{"/mnt/a", "/mnt/b"}},
		},
		{
			name:      "allowed hosts split on comma, trimmed",
			container: true, changed: noneChanged, port: 9090, bind: "127.0.0.1",
			env: map[string]string{
				"DEVDASHBOARD_ALLOWED_HOSTS": "a.example, b.example",
			},
			want: serveSettings{Port: 8080, Bind: "0.0.0.0", Namespace: "default",
				AllowedHosts: []string{"a.example", "b.example"}},
		},
		{
			name:    "changed bind flag beats env",
			changed: func(f string) bool { return f == "bind" },
			port:    9090, bind: "10.0.0.5",
			env:  map[string]string{"DEVDASHBOARD_BIND": "192.168.1.1"},
			want: serveSettings{Port: 9090, Bind: "10.0.0.5", Namespace: "default"},
		},
		{
			name:    "changed namespace flag beats env",
			changed: func(f string) bool { return f == "namespace" },
			port:    9090, bind: "127.0.0.1", namespace: "team-x",
			env:  map[string]string{"DEVDASHBOARD_NAMESPACE": "env-ns"},
			want: serveSettings{Port: 9090, Bind: "127.0.0.1", Namespace: "team-x"},
		},
		{
			name:    "non-empty statestore flag beats env",
			changed: noneChanged,
			port:    9090, bind: "127.0.0.1", stateStore: "/flag/state.yaml",
			env:  map[string]string{"DEVDASHBOARD_STATESTORE_FILE": "/env/state.yaml"},
			want: serveSettings{Port: 9090, Bind: "127.0.0.1", StateStore: "/flag/state.yaml", Namespace: "default"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			getenv := func(k string) string { return tc.env[k] }
			ns := tc.namespace
			if ns == "" {
				ns = "default"
			}
			got, err := resolveServeSettings(tc.container, tc.changed, tc.port, tc.bind, tc.stateStore, ns, getenv)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %+v want %+v", got, tc.want)
			}
		})
	}
	t.Run("bad DEVDASHBOARD_PORT errors", func(t *testing.T) {
		_, err := resolveServeSettings(true, noneChanged, 9090, "127.0.0.1", "", "default",
			func(k string) string {
				if k == "DEVDASHBOARD_PORT" {
					return "not-a-port"
				}
				return ""
			})
		if err == nil || !strings.Contains(err.Error(), "DEVDASHBOARD_PORT") {
			t.Fatalf("want error naming DEVDASHBOARD_PORT, got %v", err)
		}
	})
}
