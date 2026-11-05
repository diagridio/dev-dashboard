package discovery

import (
	"time"

	"github.com/dapr/cli/pkg/standalone"
)

// createdLayout is the time format used by the Dapr CLI in ListOutput.Created.
const createdLayout = "2006-01-02 15:04.05"

// StandaloneScanner returns a Scanner that reads running Dapr sidecars from
// the local process table via the Dapr CLI standalone.List function.
func StandaloneScanner() Scanner {
	return newStandaloneScanner(standalone.List, gopsutilDaprdConfig)
}

// newStandaloneScanner builds the standalone Scanner from its two process
// readers: list (the Dapr CLI's process-table scan) and daprdConfig (the
// --config file of a daprd PID, "" when unknown). Injectable for tests.
func newStandaloneScanner(list func() ([]standalone.ListOutput, error), daprdConfig func(pid int) string) Scanner {
	return func() ([]ScanResult, error) {
		outputs, err := list()
		if err != nil {
			return nil, err
		}
		results := make([]ScanResult, 0, len(outputs))
		for _, o := range outputs {
			created, _ := time.ParseInLocation(createdLayout, o.Created, time.Local)
			results = append(results, ScanResult{
				AppID:            o.AppID,
				HTTPPort:         o.HTTPPort,
				GRPCPort:         o.GRPCPort,
				AppPort:          o.AppPort,
				DaprdPID:         o.DaprdPID,
				CLIPID:           o.CliPID,
				Created:          created,
				RunTemplate:      o.RunTemplateName,
				ResourcePaths:    o.ResourcePaths,
				ConfigPath:       daprdConfig(o.DaprdPID),
				Command:          o.Command,
				Source:           SourceStandalone,
				SidecarReachable: true,
			})
		}
		return results, nil
	}
}
