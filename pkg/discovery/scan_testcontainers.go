package discovery

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/containerruntime"
)

const (
	// labelTestcontainers marks every container the Testcontainers library
	// starts (value "true"); labelTestcontainersSessionID groups one run.
	labelTestcontainers          = "org.testcontainers"
	labelTestcontainersSessionID = "org.testcontainers.sessionId"

	testcontainersScanTimeout = 3 * time.Second
	// testcontainersCacheTTL keeps 1s SPA polling from causing exec storms.
	testcontainersCacheTTL = 2 * time.Second
)

// TestcontainersSource discovers daprd sidecars run by Testcontainers (e.g.
// dapr-spring-boot-starter-test): containers labeled org.testcontainers=true
// whose argv invokes daprd. The paired app is a host process reached via
// host.testcontainers.internal; enrichment resolves it from the app port.
// A nil runner (no docker/podman) degrades to an empty, error-free scan.
type TestcontainersSource struct {
	run   containerruntime.Runner
	clock func() time.Time // injectable for cache tests

	mu      sync.Mutex
	last    time.Time
	results []ScanResult
	lastErr error
}

func NewTestcontainersSource(run containerruntime.Runner) *TestcontainersSource {
	return &TestcontainersSource{run: run, clock: time.Now}
}

// Scanner returns the testcontainers scan as a discovery.Scanner.
func (s *TestcontainersSource) Scanner() Scanner { return s.scan }

func (s *TestcontainersSource) scan() ([]ScanResult, error) {
	if s.run == nil {
		return nil, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.last.IsZero() && s.clock().Sub(s.last) < testcontainersCacheTTL {
		return s.results, s.lastErr
	}
	results, err := s.scanOnce()
	s.last = s.clock()
	s.results, s.lastErr = results, err
	return results, err
}

func (s *TestcontainersSource) scanOnce() ([]ScanResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), testcontainersScanTimeout)
	defer cancel()

	out, err := s.run.Run(ctx, "ps", "-aq", "--filter", "label="+labelTestcontainers+"=true")
	if err != nil {
		return nil, fmt.Errorf("testcontainers ps: %w", err)
	}
	ids := strings.Fields(string(out))
	if len(ids) == 0 {
		return nil, nil
	}
	raw, err := s.run.Run(ctx, append([]string{"inspect"}, ids...)...)
	if err != nil {
		return nil, fmt.Errorf("testcontainers inspect: %w", err)
	}
	containers, err := parseInspectContainers(raw)
	if err != nil {
		return nil, fmt.Errorf("testcontainers inspect parse: %w", err)
	}

	var results []ScanResult
	for _, c := range containers {
		args, ok := parseDaprdArgs(c.Argv)
		if !ok || args.AppID == "" {
			continue // ryuk, sshd, placement, scheduler, app containers
		}
		r := ScanResult{
			AppID:                 args.AppID,
			HTTPPort:              c.Ports[args.HTTPPort],
			GRPCPort:              c.Ports[args.GRPCPort],
			AppPort:               args.AppPort,
			Created:               c.StartedAt,
			Command:               strings.Join(c.Argv, " "),
			Source:                SourceTestcontainers,
			TestcontainersSession: c.Labels[labelTestcontainersSessionID],
			DaprdContainerID:      c.ID,
			DaprdContainerName:    c.Name,
			DaprdStatus:           composeStatus(c.Running),
		}
		if c.Running {
			r.DaprdStartedAt = c.StartedAt
		}
		r.SidecarReachable = r.HTTPPort != 0
		results = append(results, r)
	}
	return results, nil
}
