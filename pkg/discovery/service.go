package discovery

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"sync"
	"time"
)

var ErrNotFound = errors.New("app not found")

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
}

type Service interface {
	List(ctx context.Context) ([]Instance, error)
	Get(ctx context.Context, appID string) (Instance, error)
}

type service struct {
	scan   Scanner
	client *http.Client
}

func New(scan Scanner, client *http.Client) Service { return &service{scan: scan, client: client} }

const enrichWorkers = 8

func (s *service) List(ctx context.Context) ([]Instance, error) {
	results, err := s.scan()
	if err != nil {
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
	sort.SliceStable(out, func(a, b int) bool { return out[a].AppID < out[b].AppID })
	return out, nil
}

func (s *service) Get(ctx context.Context, appID string) (Instance, error) {
	results, err := s.scan()
	if err != nil {
		return Instance{}, err
	}
	for _, r := range results {
		if r.AppID == appID {
			return s.enrich(ctx, r), nil
		}
	}
	return Instance{}, fmt.Errorf("%w: %s", ErrNotFound, appID)
}

func (s *service) enrich(ctx context.Context, r ScanResult) Instance {
	in := Instance{
		AppID: r.AppID, HTTPPort: r.HTTPPort, GRPCPort: r.GRPCPort, AppPort: r.AppPort,
		DaprdPID: r.DaprdPID, CLIPID: r.CLIPID, RunTemplate: r.RunTemplate,
		ResourcePaths: r.ResourcePaths, ConfigPath: r.ConfigPath, Command: r.Command,
		Created: r.Created.Local().Format("15:04:05"), Age: humanAge(r.Created),
		Runtime: InferRuntime(r.Command), Health: HealthUnknown,
	}
	in.Health = CheckHealth(ctx, s.client, r.HTTPPort)
	md, err := FetchMetadata(ctx, s.client, r.HTTPPort)
	if err != nil {
		in.MetadataOK = false
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
	if md.CLIPID != 0 {
		in.CLIPID = md.CLIPID
	}
	if md.AppCommand != "" {
		in.Command = md.AppCommand
		in.Runtime = InferRuntime(md.AppCommand)
	}
	if md.AppLogPath != "" {
		in.AppLogPath = md.AppLogPath
	}
	if md.DaprdLogPath != "" {
		in.DaprdLogPath = md.DaprdLogPath
	}
	if md.RunTemplate != "" {
		in.RunTemplate = md.RunTemplate
	}
	return in
}

func humanAge(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	default:
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
}
