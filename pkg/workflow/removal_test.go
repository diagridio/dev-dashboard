//go:build unit

package workflow

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestSelectMechanism(t *testing.T) {
	cases := []struct {
		name    string
		status  Status
		healthy bool
		force   bool
		want    Mechanism
	}{
		{"completed healthy", StatusCompleted, true, false, MechPurge},
		{"failed healthy", StatusFailed, true, false, MechPurge},
		{"terminated healthy", StatusTerminated, true, false, MechPurge},
		{"running healthy", StatusRunning, true, false, MechTerminateThenPurge},
		{"suspended healthy", StatusSuspended, true, false, MechTerminateThenPurge},
		{"pending healthy", StatusPending, true, false, MechTerminateThenPurge},
		{"running no sidecar", StatusRunning, false, false, MechForce},
		{"completed forced", StatusCompleted, true, true, MechForce},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			require.Equal(t, c.want, SelectMechanism(c.status, c.healthy, c.force))
		})
	}
}
