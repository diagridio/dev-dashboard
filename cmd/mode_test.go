//go:build unit

package cmd

import "testing"

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
		{name: "env aspire", flag: "", env: map[string]string{"DEVDASHBOARD_MODE": "aspire"}, want: ModeAspire},
		{name: "flag wins over env", flag: "aspire", env: map[string]string{"DEVDASHBOARD_MODE": "bogus"}, want: ModeAspire},
		{name: "unknown flag value errors", flag: "compose", wantErr: true},
		{name: "unknown env value errors", env: map[string]string{"DEVDASHBOARD_MODE": "dapr"}, wantErr: true},
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
