package discovery

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"sync"
	"time"
)

var ErrNotFound = errors.New("app not found")

const (
	SourceStandalone = "standalone"
	SourceCompose    = "compose"
)

func logger() *slog.Logger { return slog.Default().With("component", "discovery") }

type Scanner func() ([]ScanResult, error)

type ScanResult struct {
	AppID         string
	HTTPPort      int
	GRPCPort      int
	AppPort       int
	DaprdPID      int
	CLIPID        int
	Created       time.Time
	RunTemplate   string
	ResourcePaths []string
	ConfigPath    string
	Command       string

	// Source is SourceStandalone (process table) or SourceCompose (containers).
	Source             string
	ComposeProject     string
	ComposeService     string
	DaprdContainerID   string
	DaprdContainerName string
	AppContainerID     string
	AppContainerName   string
	AppImage           string
	// SidecarReachable is false only for compose sidecars whose HTTP port is
	// not published to the host (metadata/health enrichment impossible).
	SidecarReachable bool
}

// Key returns the routing identity for this scan result. Compose sidecars can
// share one -app-id (scaled instances), so they key by container name — the
// app container when paired, else the daprd container; everything else keys
// by AppID. Container names are unique per host, so keys are unique whenever
// a container name is available.
func (r ScanResult) Key() string {
	if r.Source == SourceCompose {
		if r.AppContainerName != "" {
			return r.AppContainerName
		}
		if r.DaprdContainerName != "" {
			return r.DaprdContainerName
		}
	}
	return r.AppID
}

type Service interface {
	List(ctx context.Context) ([]Instance, error)
	// Get resolves key as an InstanceKey first, then as an AppID (first match).
	Get(ctx context.Context, key string) (Instance, error)
}

type service struct {
	scan       Scanner
	client     *http.Client
	appProc    appProcResolver
	stdoutFile func(pid int) string
}

func New(scan Scanner, client *http.Client) Service {
	return &service{scan: scan, client: client, appProc: gopsutilResolver{}, stdoutFile: lsofStdoutFile}
}

const enrichWorkers = 8

func (s *service) List(ctx context.Context) ([]Instance, error) {
	results, err := s.scan()
	if err != nil {
		logger().Error("app scan failed", "err", err)
		return nil, err
	}
	out := make([]Instance, len(results))
	sem := make(chan struct{}, enrichWorkers)
	var wg sync.WaitGroup
	for i, r := range results {
		wg.Add(1)
		go func(idx int, sr ScanResult) {
			defer wg.Done()
			sem <- struct{}{}
			out[idx] = s.enrich(ctx, sr)
			<-sem
		}(i, r)
	}
	wg.Wait()
	sort.SliceStable(out, func(a, b int) bool {
		if out[a].AppID != out[b].AppID {
			return out[a].AppID < out[b].AppID
		}
		return out[a].InstanceKey < out[b].InstanceKey
	})
	logger().Info("discovered Dapr apps", "count", len(out))
	return out, nil
}

// Get resolves key as an instance key first (container name for compose
// apps), then as an app id. The app-id fallback keeps legacy links working —
// e.g. workflow pages, which only know the daprd app id — and resolves
// duplicates to the first instance in scan order.
func (s *service) Get(ctx context.Context, key string) (Instance, error) {
	results, err := s.scan()
	if err != nil {
		logger().Error("app scan failed", "err", err)
		return Instance{}, err
	}
	for _, r := range results {
		if r.Key() == key {
			return s.enrich(ctx, r), nil
		}
	}
	for _, r := range results {
		if r.AppID == key {
			return s.enrich(ctx, r), nil
		}
	}
	return Instance{}, fmt.Errorf("%w: %s", ErrNotFound, key)
}

func (s *service) enrich(ctx context.Context, r ScanResult) Instance {
	in := Instance{
		AppID: r.AppID, InstanceKey: r.Key(), HTTPPort: r.HTTPPort, GRPCPort: r.GRPCPort, AppPort: r.AppPort,
		DaprdPID: r.DaprdPID, CLIPID: r.CLIPID, RunTemplate: r.RunTemplate,
		ResourcePaths: r.ResourcePaths, ConfigPath: r.ConfigPath, Command: r.Command,
		Created: r.Created.Local().Format("15:04:05"), Age: humanAge(r.Created),
		Runtime: InferRuntime(r.Command), Health: HealthUnknown,
		Source: r.Source, ComposeProject: r.ComposeProject, ComposeService: r.ComposeService,
		DaprdContainerID: r.DaprdContainerID, DaprdContainerName: r.DaprdContainerName,
		AppContainerID: r.AppContainerID, AppContainerName: r.AppContainerName,
		SidecarReachable: r.SidecarReachable,
	}
	if in.Source == "" { // scanners predating the field (and bare test fixtures)
		in.Source = SourceStandalone
		in.SidecarReachable = true
	}
	if in.Source == SourceCompose && in.Runtime == "unknown" {
		in.Runtime = InferRuntimeFromImage(r.AppImage)
	}
	// An unreachable sidecar (compose, HTTP port unpublished) cannot answer
	// health or metadata — skip both probes instead of burning their timeouts.
	if !in.SidecarReachable {
		return in
	}
	in.Health = CheckHealth(ctx, s.client, r.HTTPPort)
	md, err := FetchMetadata(ctx, s.client, r.HTTPPort)
	if err != nil {
		in.MetadataOK = false
		logger().Warn("app metadata unavailable", "appID", r.AppID, "httpPort", r.HTTPPort, "err", err)
		return in
	}
	in.MetadataOK = true
	in.RuntimeVersion = md.RuntimeVersion
	in.AppPID = md.AppPID
	in.Actors = md.Actors
	in.Subscriptions = md.Subscriptions
	in.Components = md.Components
	in.EnabledFeatures = md.EnabledFeatures
	in.Placement = md.Placement
	if in.Source == SourceCompose {
		// Container apps: metadata Extended fields (PIDs, commands, log paths)
		// describe the container's own view; process probing and file log
		// sources don't apply. Logs stream from the container runtime instead.
		if md.RunTemplate != "" {
			in.RunTemplate = md.RunTemplate
		}
		return in
	}
	if md.CLIPID != 0 {
		in.CLIPID = md.CLIPID
	}
	if md.AppCommand != "" {
		in.Command = md.AppCommand
	}
	in.Runtime, in.IsAspire = appRuntime(in.Command, in.AppPort, s.appProc)
	if md.AppLogPath != "" {
		in.AppLogPath, in.AppLogFormat = md.AppLogPath, logFormatPlain
	}
	if md.DaprdLogPath != "" {
		in.DaprdLogPath, in.DaprdLogFormat = md.DaprdLogPath, logFormatPlain
	}
	s.resolveLogSources(&in)
	if md.RunTemplate != "" {
		in.RunTemplate = md.RunTemplate
	}
	return in
}

// resolveLogSources fills in AppLogPath/DaprdLogPath (and their formats) when the
// sidecar's metadata reported none. Aspire apps get their logs from the DCP
// session dir; standalone `dapr run` gets them from the process's stdout when it
// is a regular file (i.e. redirected to a file rather than a terminal).
func (s *service) resolveLogSources(in *Instance) {
	if in.DaprdLogPath != "" && in.AppLogPath != "" {
		return
	}

	// Aspire: locate the DCP session dir from the app-port listener command.
	if in.IsAspire && s.appProc != nil && in.AppPort != 0 {
		if cmd, ok := s.appProc.CommandForPort(in.AppPort); ok {
			if dir, ok := dcpSessionDir(cmd); ok {
				daprdPath, appPath := resolveDCPLogs(dir, in.AppID)
				if in.DaprdLogPath == "" && daprdPath != "" {
					in.DaprdLogPath, in.DaprdLogFormat = daprdPath, logFormatDCP
				}
				if in.AppLogPath == "" && appPath != "" {
					in.AppLogPath, in.AppLogFormat = appPath, logFormatDCP
				}
			}
		}
	}

	// Standalone dapr run: stdout is tailable only if redirected to a regular file.
	// Skip entirely for Aspire apps — fds are pipes so lsof always returns "".
	if s.stdoutFile == nil || in.IsAspire {
		return
	}
	if in.DaprdLogPath == "" && in.DaprdPID != 0 {
		if p := s.stdoutFile(in.DaprdPID); p != "" {
			in.DaprdLogPath, in.DaprdLogFormat = p, logFormatPlain
		}
	}
	if in.AppLogPath == "" && in.AppPID != 0 {
		if p := s.stdoutFile(in.AppPID); p != "" {
			in.AppLogPath, in.AppLogFormat = p, logFormatPlain
		}
	}
}

func humanAge(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	d := time.Since(t)
	if d < 0 { // clock skew can make Created appear in the future
		d = 0
	}
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	}
}
