//go:build unit

package actors

import (
	"errors"
	"testing"
)

func TestVersionGate(t *testing.T) {
	tests := []struct {
		version string
		f       Feature
		want    string // empty means nil error
	}{
		{"1.16.3", FeatureReminderList, "requires Dapr 1.17+"},
		{"1.17.0", FeatureReminderList, ""},
		{"1.18.11", FeatureTimerList, "requires Dapr 1.19+"},
		{"1.19.2", FeatureTimerList, ""},
		{"", FeatureTimerList, ""},
		{"edge", FeatureTimerList, ""},
		{"1.19.0-rc.1", FeatureTimerList, ""},
	}
	for _, tc := range tests {
		err := Supports(tc.version, tc.f)
		if tc.want == "" {
			if err != nil {
				t.Errorf("Supports(%q, %v) = %v, want nil", tc.version, tc.f, err)
			}
			continue
		}
		if err == nil || err.Error() != tc.want {
			t.Errorf("Supports(%q, %v) = %v, want %q", tc.version, tc.f, err, tc.want)
			continue
		}
		if !errors.Is(err, ErrUnsupportedVersion) {
			t.Errorf("Supports(%q, %v) does not wrap ErrUnsupportedVersion", tc.version, tc.f)
		}
	}
}
