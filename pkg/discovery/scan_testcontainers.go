package discovery

import (
	"context"
	"errors"
	"fmt"
	"path"
	"sort"
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

	// extracted caches per-container-ID resource files (containerID ->
	// files); extractFailed remembers IDs whose extraction already failed
	// so the failure logs once and is not retried every scan.
	extracted     map[string][]ExtractedFile
	extractFailed map[string]bool
}

// ExtractedFile is one YAML file copied out of a daprd container's
// resources dir. Container is the container name (display identity), Path
// the container-internal file path.
type ExtractedFile struct {
	Container string
	Path      string
	Content   []byte
}

func NewTestcontainersSource(run containerruntime.Runner) *TestcontainersSource {
	return &TestcontainersSource{run: run, clock: time.Now,
		extracted: map[string][]ExtractedFile{}, extractFailed: map[string]bool{}}
}

// Files returns the extracted resource files of all currently-scanned
// containers, ordered by container name then path.
func (s *TestcontainersSource) Files() []ExtractedFile {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []ExtractedFile
	for _, files := range s.extracted {
		out = append(out, files...)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Container != out[j].Container {
			return out[i].Container < out[j].Container
		}
		return out[i].Path < out[j].Path
	})
	return out
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
		// No testcontainers-labeled containers left: evict all extraction cache.
		s.extracted = map[string][]ExtractedFile{}
		s.extractFailed = map[string]bool{}
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
			AppProtocol:           args.AppProtocol,
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
		if args.ResourcesPath != "" {
			r.ResourcePaths = []string{c.Name + ":" + args.ResourcesPath}
			s.extractResources(ctx, c, args.ResourcesPath)
		}
		if args.ConfigPath != "" {
			r.ConfigPath = c.Name + ":" + args.ConfigPath
		}
		results = append(results, r)
	}

	// Evict extraction cache entries for containers gone from this scan.
	live := map[string]bool{}
	for _, c := range containers {
		live[c.ID] = true
	}
	for id := range s.extracted {
		if !live[id] {
			delete(s.extracted, id)
		}
	}
	for id := range s.extractFailed {
		if !live[id] {
			delete(s.extractFailed, id)
		}
	}

	return results, nil
}

// extractResources copies the container's resources dir out as a tar stream
// (`cp <id>:<dir> -`, no shell needed — works on distroless images) and
// caches the YAML files per container ID. Runs once per container; genuine
// failures are pinned and not retried, while context-expiry failures are
// retried on the next scan. Caller holds s.mu (extractResources is only ever
// called from scanOnce, which is only ever called from scan while s.mu is
// held).
func (s *TestcontainersSource) extractResources(ctx context.Context, c composeContainer, dir string) {
	if _, done := s.extracted[c.ID]; done || s.extractFailed[c.ID] {
		return
	}
	raw, err := s.run.Run(ctx, "cp", c.ID+":"+dir, "-")
	if err != nil {
		if extractionRetryable(ctx, err) {
			// The cp call shares scanOnce's single scan-wide context with ps
			// and inspect; a slow docker round-trip can expire the deadline
			// mid-cp. That's transient, not a genuine extraction failure —
			// leave extractFailed unset so the next scan retries.
			logger().Warn("testcontainers resource extraction timed out, will retry", "container", c.Name, "err", err)
			return
		}
		logger().Warn("testcontainers resource extraction failed", "container", c.Name, "err", err)
		s.extractFailed[c.ID] = true
		return
	}
	files, err := extractYAMLFromTar(raw)
	if err != nil {
		logger().Warn("testcontainers resource tar parse failed", "container", c.Name, "err", err)
		s.extractFailed[c.ID] = true
		return
	}
	out := make([]ExtractedFile, 0, len(files))
	base := path.Base(strings.TrimSuffix(dir, "/"))
	for name, content := range files {
		// Tar member names are relative to the copied dir's parent (e.g.
		// "dapr-resources/kvstore.yaml"); rebase onto the container path.
		rel := strings.TrimPrefix(name, base+"/")
		out = append(out, ExtractedFile{Container: c.Name, Path: dir + "/" + rel, Content: content})
	}
	s.extracted[c.ID] = out
}

// extractionRetryable classifies a failed extraction call as transient
// (caused by the scan's shared context expiring or being cancelled, rather
// than a genuine failure like a missing container or corrupt tar). scanCtx
// is the context passed to the runner for this scan; it is checked directly
// because a container runtime may return its own error type instead of (or
// in addition to) propagating ctx.Err() verbatim.
func extractionRetryable(scanCtx context.Context, err error) bool {
	if scanCtx.Err() != nil {
		return true
	}
	return errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled)
}
