package workflow

type Mechanism string

const (
	MechTerminateThenPurge Mechanism = "terminate_then_purge"
	MechPurge              Mechanism = "purge"
	MechForce              Mechanism = "force"
)

// SelectMechanism chooses the removal path for one workflow (spec §7).
func SelectMechanism(status Status, sidecarHealthy, force bool) Mechanism {
	if force || !sidecarHealthy {
		return MechForce
	}
	if status.IsTerminal() {
		return MechPurge
	}
	return MechTerminateThenPurge
}
