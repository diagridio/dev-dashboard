package cmd

import "github.com/diagridio/dev-dashboard/pkg/controlplane"

// sourceSet describes which discovery sources a host-posture mode enables.
// Filter modes set exactly one source; ModeDefault sets everything.
type sourceSet struct {
	Standalone     bool // host `dapr run` process scan
	Compose        bool // Docker Compose container discovery
	Testcontainers bool // Testcontainers container discovery
	AspireContract bool // env-contract scanner joins the merge (mode unset only)
	AspireFilter   bool // post-enrichment IsAspire filter (aspire host mode)
	NeedsRuntime   bool // startup fails when no container runtime is found
}

// sourcesFor maps a host-posture mode to its discovery sources. Container
// posture (aspire + env contract) never reaches this function — runServe
// branches to the env-contract scanner before consulting it.
func sourcesFor(mode Mode, contractPresent bool) sourceSet {
	switch mode {
	case ModeDaprRun:
		return sourceSet{Standalone: true}
	case ModeCompose:
		return sourceSet{Compose: true, NeedsRuntime: true}
	case ModeTestcontainers:
		return sourceSet{Testcontainers: true, NeedsRuntime: true}
	case ModeAspire:
		return sourceSet{Standalone: true, AspireFilter: true}
	default:
		return sourceSet{Standalone: true, Compose: true, Testcontainers: true, AspireContract: contractPresent}
	}
}

// cpSourcesFor maps a mode to the control-plane families the dashboard shows
// and manages. dapr-run and aspire sidecars use the `dapr init` containers;
// test-containers has no control-plane detection yet (deferred), so it gets
// the zero value — an honest empty list.
func cpSourcesFor(mode Mode) controlplane.Sources {
	switch mode {
	case ModeDaprRun, ModeAspire:
		return controlplane.Sources{Init: true}
	case ModeCompose:
		return controlplane.Sources{Compose: true}
	case ModeTestcontainers:
		return controlplane.Sources{}
	default:
		return controlplane.AllSources()
	}
}
