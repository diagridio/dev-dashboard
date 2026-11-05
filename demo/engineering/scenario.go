// Command engineering is the Go app of the Enterprise diagnostics demo. It runs
// the DiagnosticSweep workflows the dashboard's Workflows page showcases.
package main

import "fmt"

// Outcome is what a sweep's subsystem check ends up doing.
type Outcome string

const (
	Complete     Outcome = "Complete"
	Fail         Outcome = "Fail"
	AwaitSignOff Outcome = "AwaitSignOff"
)

// SignOffEvent is the external event sweep-005 waits for and never receives.
const SignOffEvent = "ChiefEngineerSignOff"

// Subsystems are the child checks every sweep fans out to.
var Subsystems = []string{"warp-core", "shields", "deflector", "life-support"}

// Sweep describes one seeded DiagnosticSweep instance.
type Sweep struct {
	ID           string  `json:"id"`
	Outcome      Outcome `json:"outcome"`
	Subsystem    string  `json:"subsystem,omitempty"` // the subsystem the outcome applies to
	Message      string  `json:"message,omitempty"`   // failure message for Fail
	EventName    string  `json:"eventName,omitempty"` // event awaited for AwaitSignOff
	LargePayload bool    `json:"largePayload,omitempty"`
}

// Scenario returns the six seeded sweeps in a stable order.
func Scenario() []Sweep {
	return []Sweep{
		{ID: "sweep-001", Outcome: Complete},
		{ID: "sweep-002", Outcome: Fail, Subsystem: "deflector", Message: "plasma conduit rupture in deck 7"},
		{ID: "sweep-003", Outcome: Complete},
		{ID: "sweep-004", Outcome: Complete},
		{ID: "sweep-005", Outcome: AwaitSignOff, Subsystem: "warp-core", EventName: SignOffEvent},
		{ID: "sweep-006", Outcome: Complete, LargePayload: true},
	}
}

// ChildID is the instance ID of a sweep's subsystem check.
func ChildID(sweepID, subsystem string) string {
	return fmt.Sprintf("%s-%s", sweepID, subsystem)
}
