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
	return func() ([]ScanResult, error) {
		outputs, err := standalone.List()
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
				ConfigPath:       "",
				Command:          o.Command,
				Source:           SourceStandalone,
				SidecarReachable: true,
			})
		}
		return results, nil
	}
}
