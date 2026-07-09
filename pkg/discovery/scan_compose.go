package discovery

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/containerruntime"
)

const (
	composeScanTimeout = 3 * time.Second
	// composeCacheTTL keeps 1s SPA polling from causing exec storms.
	composeCacheTTL = 2 * time.Second
)

// ComposeProject is the host-reachable view of one compose project.
type ComposeProject struct {
	// ServicePorts maps service name -> container port -> published host port.
	ServicePorts map[string]map[int]int
	// Mounts maps container destination -> host source, merged across the
	// project's daprd sidecars (first destination wins). Used for SQLite
	// connection-path translation.
	Mounts map[string]string
}

// ComposeEnv is the compose network/mount context from the last scan. The
// reconciler uses it to translate store addresses to host-reachable ones.
type ComposeEnv struct {
	Projects map[string]ComposeProject
	// PathProject maps each host resource/config dir found on a sidecar to its
	// compose project name.
	PathProject map[string]string
}

// ProjectForPath returns the compose project owning p (p equal to, or nested
// under, one of the scanned host resource dirs).
func (e ComposeEnv) ProjectForPath(p string) (string, bool) {
	abs, err := filepath.Abs(p)
	if err != nil {
		abs = p
	}
	for dir, proj := range e.PathProject {
		d, err := filepath.Abs(dir)
		if err != nil {
			d = dir
		}
		if abs == d {
			return proj, true
		}
		rel, err := filepath.Rel(d, abs)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return proj, true
		}
	}
	return "", false
}

// ComposeSource discovers Dapr sidecars running in compose-managed containers.
// A nil runner (no docker/podman) degrades to an empty, error-free scan.
type ComposeSource struct {
	run   containerruntime.Runner
	clock func() time.Time // injectable for cache tests

	mu      sync.Mutex
	last    time.Time
	results []ScanResult
	env     ComposeEnv
	lastErr error
}

func NewComposeSource(run containerruntime.Runner) *ComposeSource {
	return &ComposeSource{run: run, clock: time.Now}
}

// Scanner returns the compose scan as a discovery.Scanner.
func (s *ComposeSource) Scanner() Scanner { return s.scan }

// Env returns the compose endpoint/mount context from the last successful scan.
func (s *ComposeSource) Env() ComposeEnv {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.env
}

func (s *ComposeSource) scan() ([]ScanResult, error) {
	if s.run == nil {
		return nil, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.last.IsZero() && s.clock().Sub(s.last) < composeCacheTTL {
		return s.results, s.lastErr
	}
	results, env, err := s.scanOnce()
	s.last = s.clock()
	s.results, s.lastErr = results, err
	if err == nil {
		s.env = env
	}
	return results, err
}

func (s *ComposeSource) scanOnce() ([]ScanResult, ComposeEnv, error) {
	ctx, cancel := context.WithTimeout(context.Background(), composeScanTimeout)
	defer cancel()
	env := ComposeEnv{Projects: map[string]ComposeProject{}, PathProject: map[string]string{}}

	out, err := s.run.Run(ctx, "ps", "-q", "--filter", "label="+labelComposeProject)
	if err != nil {
		return nil, env, fmt.Errorf("compose ps: %w", err)
	}
	ids := strings.Fields(string(out))
	if len(ids) == 0 {
		return nil, env, nil
	}
	raw, err := s.run.Run(ctx, append([]string{"inspect"}, ids...)...)
	if err != nil {
		return nil, env, fmt.Errorf("compose inspect: %w", err)
	}
	containers, err := parseComposeContainers(raw)
	if err != nil {
		return nil, env, fmt.Errorf("compose inspect parse: %w", err)
	}

	// Index every container's published ports; index by project/service for
	// app pairing.
	byProjSvc := map[string]composeContainer{}
	for _, c := range containers {
		byProjSvc[c.Project+"/"+c.Service] = c
		proj, ok := env.Projects[c.Project]
		if !ok {
			proj = ComposeProject{ServicePorts: map[string]map[int]int{}, Mounts: map[string]string{}}
		}
		if len(c.Ports) > 0 {
			proj.ServicePorts[c.Service] = c.Ports
		}
		env.Projects[c.Project] = proj
	}

	var results []ScanResult
	for _, c := range containers {
		if !c.Running {
			continue
		}
		args, ok := parseDaprdArgs(c.Argv)
		if !ok || args.AppID == "" {
			continue
		}
		r := ScanResult{
			AppID:              args.AppID,
			HTTPPort:           c.Ports[args.HTTPPort],
			GRPCPort:           c.Ports[args.GRPCPort],
			AppPort:            args.AppPort,
			Created:            c.StartedAt,
			Command:            strings.Join(c.Argv, " "),
			Source:             SourceCompose,
			ComposeProject:     c.Project,
			ComposeService:     c.Service,
			DaprdContainerID:   c.ID,
			DaprdContainerName: c.Name,
		}
		r.SidecarReachable = r.HTTPPort != 0
		if args.ResourcesPath != "" {
			if host, ok := TranslateMountPath(c.Mounts, args.ResourcesPath); ok {
				r.ResourcePaths = []string{host}
				env.PathProject[host] = c.Project
			}
		}
		if args.ConfigPath != "" {
			if host, ok := TranslateMountPath(c.Mounts, args.ConfigPath); ok {
				r.ConfigPath = host
				env.PathProject[filepath.Dir(host)] = c.Project
			}
		}
		// Merge the sidecar's bind mounts into the project mount table.
		proj := env.Projects[c.Project]
		for dest, src := range c.Mounts {
			if _, exists := proj.Mounts[dest]; !exists {
				proj.Mounts[dest] = src
			}
		}
		env.Projects[c.Project] = proj
		// Pair the app container: same project, service named by
		// -app-channel-address (fallback: the app id).
		appSvc := args.AppChannelAddress
		if appSvc == "" {
			appSvc = args.AppID
		}
		if app, ok := byProjSvc[c.Project+"/"+appSvc]; ok {
			r.AppContainerID = app.ID
			r.AppContainerName = app.Name
			r.AppImage = app.Image
			r.AppRuntime = composeAppRuntime(app)
		}
		results = append(results, r)
	}
	return results, env, nil
}
