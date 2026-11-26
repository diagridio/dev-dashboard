package actors

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/state"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// ErrInvalidRequest marks a request the caller must fix (empty actor ID,
// method or reminder name, or an unsupported verb).
var ErrInvalidRequest = errors.New("invalid actor request")

const (
	// readBudget bounds the concurrent reads behind one List/Type/Actor call.
	readBudget = 5 * time.Second
	// statePageSize and maxScanKeys bound the state scan for one actor type.
	statePageSize = 500
	maxScanKeys   = 2000
)

// Unavailable says why a value couldn't be read.
type Unavailable struct {
	Reason string `json:"reason"`
}

// TypeRow is one actor type hosted by one app instance.
type TypeRow struct {
	AppID                string       `json:"appId"`
	InstanceKey          string       `json:"instanceKey"`
	Type                 string       `json:"type"`
	Count                int          `json:"count"`
	Internal             bool         `json:"internal"`
	RuntimeStatus        string       `json:"runtimeStatus,omitempty"`
	HostReady            bool         `json:"hostReady"`
	Placement            string       `json:"placement,omitempty"`
	Config               *TypeConfig  `json:"config,omitempty"`
	ConfigUnavailable    *Unavailable `json:"configUnavailable,omitempty"`
	Reminders            *int         `json:"reminders,omitempty"`
	RemindersUnavailable *Unavailable `json:"remindersUnavailable,omitempty"`
}

// TypeDetail is one actor type with the actor IDs found in state and reminders.
type TypeDetail struct {
	TypeRow
	IDs              []ActorID    `json:"ids"`
	Truncated        bool         `json:"truncated"`
	StateUnavailable *Unavailable `json:"stateUnavailable,omitempty"`
}

// ActorDetail is one actor instance: its state, reminders and timers. Each
// section fails independently.
type ActorDetail struct {
	AppID                string       `json:"appId"`
	InstanceKey          string       `json:"instanceKey"`
	Type                 string       `json:"type"`
	ID                   string       `json:"id"`
	State                []state.Item `json:"state"`
	StateUnavailable     *Unavailable `json:"stateUnavailable,omitempty"`
	StateTruncated       bool         `json:"stateTruncated"`
	Reminders            []Scheduled  `json:"reminders"`
	RemindersUnavailable *Unavailable `json:"remindersUnavailable,omitempty"`
	Timers               []Scheduled  `json:"timers"`
	TimersUnavailable    *Unavailable `json:"timersUnavailable,omitempty"`
	StoreID              string       `json:"storeId,omitempty"`
}

// Service composes discovery, app config, sidecar gRPC/HTTP and state reads
// into the Actors API.
type Service struct {
	apps     discovery.Service
	conns    ConnProvider
	cfg      *ConfigReader
	stateFor func(storeID string) (state.Service, bool)
	resolve  func(discovery.Instance) (storeID, componentName string, ok bool)
	client   *http.Client
}

// NewService returns an actors service. stateFor opens a store by registry
// ID; resolve answers which store holds an app's actor state; client carries
// invoke and reminder-delete calls (the caller owns its timeout).
func NewService(apps discovery.Service, conns ConnProvider, cfg *ConfigReader, stateFor func(storeID string) (state.Service, bool), resolve func(discovery.Instance) (string, string, bool), client *http.Client) *Service {
	return &Service{apps: apps, conns: conns, cfg: cfg, stateFor: stateFor, resolve: resolve, client: client}
}

func instanceKey(in discovery.Instance) string {
	if in.InstanceKey != "" {
		return in.InstanceKey
	}
	return in.AppID
}

func newRow(in discovery.Instance, actorType string, count int) TypeRow {
	return TypeRow{
		AppID: in.AppID, InstanceKey: instanceKey(in), Type: actorType, Count: count,
		Internal: IsInternal(actorType), RuntimeStatus: in.ActorRuntimeStatus,
		HostReady: in.ActorHostReady, Placement: in.Placement,
	}
}

// reason maps an error to its Unavailable reason, collapsing every flavour of
// "can't reach the sidecar" to the one user-facing string.
func reason(err error) *Unavailable {
	if errors.Is(err, ErrSidecarUnreachable) || status.Code(err) == codes.Unavailable {
		return &Unavailable{Reason: ErrSidecarUnreachable.Error()}
	}
	return &Unavailable{Reason: err.Error()}
}

func applyConfig(row *TypeRow, cfg AppConfig, err error) {
	if err != nil {
		row.ConfigUnavailable = reason(err)
		return
	}
	tc := cfg.ForType(row.Type)
	row.Config = &tc
}

func applyReminders(row *TypeRow, rems []Scheduled, err error) {
	if row.Internal {
		return
	}
	if err != nil {
		row.RemindersUnavailable = reason(err)
		return
	}
	n := len(rems)
	row.Reminders = &n
}

// List returns one row per actor type per instance, optionally filtered by
// app ID. Config is read once per instance and reminders once per type,
// concurrently, within one overall budget.
func (s *Service) List(ctx context.Context, appID string) ([]TypeRow, error) {
	list, err := s.apps.List(ctx)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, readBudget)
	defer cancel()

	type cfgResult struct {
		cfg AppConfig
		err error
	}
	type remResult struct {
		rems []Scheduled
		err  error
	}
	var instances []discovery.Instance
	for _, in := range list {
		if (appID == "" || in.AppID == appID) && len(in.Actors) > 0 {
			instances = append(instances, in)
		}
	}
	cfgs := make([]cfgResult, len(instances))
	rems := make([][]remResult, len(instances))
	var wg sync.WaitGroup
	for i, in := range instances {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, err := s.cfg.Get(ctx, in)
			cfgs[i] = cfgResult{c, err}
		}()
		rems[i] = make([]remResult, len(in.Actors))
		for j, a := range in.Actors {
			if IsInternal(a.Type) {
				continue
			}
			wg.Add(1)
			go func() {
				defer wg.Done()
				r, err := ListReminders(ctx, s.conns, in, a.Type, nil)
				rems[i][j] = remResult{r, err}
			}()
		}
	}
	wg.Wait()

	rows := []TypeRow{}
	for i, in := range instances {
		for j, a := range in.Actors {
			row := newRow(in, a.Type, a.Count)
			applyConfig(&row, cfgs[i].cfg, cfgs[i].err)
			applyReminders(&row, rems[i][j].rems, rems[i][j].err)
			rows = append(rows, row)
		}
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].AppID != rows[j].AppID {
			return rows[i].AppID < rows[j].AppID
		}
		return rows[i].Type < rows[j].Type
	})
	return rows, nil
}

// openStore resolves and opens the instance's actor state store.
func (s *Service) openStore(in discovery.Instance) (state.Service, string, *Unavailable) {
	var id, name string
	var ok bool
	if s.resolve != nil {
		id, name, ok = s.resolve(in)
	}
	notConnected := func() *Unavailable {
		if name != "" {
			return &Unavailable{Reason: fmt.Sprintf("This app's actor state store (%s) isn't connected", name)}
		}
		return &Unavailable{Reason: "No state store found for this app"}
	}
	if !ok || s.stateFor == nil {
		return nil, "", notConnected()
	}
	svc, ok := s.stateFor(id)
	if !ok {
		return nil, "", notConnected()
	}
	return svc, id, nil
}

// scanState pages through the app's keys matching search, stopping once
// maxScanKeys have been scanned. truncated reports that keys remained.
func scanState(ctx context.Context, svc state.Service, appID, search string) (items []state.Item, truncated bool, err error) {
	token := ""
	for scanned := 0; ; {
		res, err := svc.List(ctx, state.ListQuery{AppID: appID, Search: search, PageToken: token, PageSize: statePageSize, IncludeInternal: true})
		if err != nil {
			return nil, false, err
		}
		items = append(items, res.Items...)
		// With IncludeInternal each call scans one key page, so count pages
		// rather than returned items (a page can shrink if keys vanish).
		scanned += statePageSize
		if res.NextToken == "" {
			return items, false, nil
		}
		if scanned >= maxScanKeys {
			return items, true, nil
		}
		token = res.NextToken
	}
}

func countFor(in discovery.Instance, actorType string) int {
	for _, a := range in.Actors {
		if a.Type == actorType {
			return a.Count
		}
	}
	return 0
}

// Type returns one actor type on one instance with the actor IDs found in
// its state store and reminders.
func (s *Service) Type(ctx context.Context, key, actorType string) (TypeDetail, error) {
	in, err := s.apps.Get(ctx, key)
	if err != nil {
		return TypeDetail{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, readBudget)
	defer cancel()

	d := TypeDetail{TypeRow: newRow(in, actorType, countFor(in, actorType))}
	var (
		cfg       AppConfig
		cfgErr    error
		rems      []Scheduled
		remErr    error
		items     []state.Item
		stateErr  *Unavailable
		truncated bool
		wg        sync.WaitGroup
	)
	wg.Add(2)
	go func() {
		defer wg.Done()
		cfg, cfgErr = s.cfg.Get(ctx, in)
	}()
	go func() {
		defer wg.Done()
		svc, _, un := s.openStore(in)
		if un != nil {
			stateErr = un
			return
		}
		var err error
		items, truncated, err = scanState(ctx, svc, in.AppID, actorType+"||")
		if err != nil {
			stateErr = &Unavailable{Reason: err.Error()}
		}
	}()
	if !d.Internal {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rems, remErr = ListReminders(ctx, s.conns, in, actorType, nil)
		}()
	}
	wg.Wait()

	applyConfig(&d.TypeRow, cfg, cfgErr)
	applyReminders(&d.TypeRow, rems, remErr)
	d.StateUnavailable = stateErr
	d.Truncated = truncated
	d.IDs = MergeIDs(IDsFromState(items, actorType), rems)
	return d, nil
}

// Actor returns one actor's state, reminders and timers. Each section is
// read independently; a failure marks only that section unavailable.
func (s *Service) Actor(ctx context.Context, key, actorType, actorID string) (ActorDetail, error) {
	in, err := s.apps.Get(ctx, key)
	if err != nil {
		return ActorDetail{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, readBudget)
	defer cancel()

	d := ActorDetail{AppID: in.AppID, InstanceKey: instanceKey(in), Type: actorType, ID: actorID}
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		svc, id, un := s.openStore(in)
		if un != nil {
			d.StateUnavailable = un
			return
		}
		d.StoreID = id
		items, truncated, err := scanState(ctx, svc, in.AppID, actorType+"||"+actorID+"||")
		if err != nil {
			d.StateUnavailable = &Unavailable{Reason: err.Error()}
			return
		}
		d.State = StateKeysFor(items, actorType, actorID)
		d.StateTruncated = truncated
	}()
	if !IsInternal(actorType) {
		wg.Add(2)
		go func() {
			defer wg.Done()
			r, err := ListReminders(ctx, s.conns, in, actorType, &actorID)
			if err != nil {
				d.RemindersUnavailable = reason(err)
				return
			}
			d.Reminders = r
		}()
		go func() {
			defer wg.Done()
			t, err := ListTimers(ctx, s.conns, in, actorType, actorID)
			if err != nil {
				d.TimersUnavailable = reason(err)
				return
			}
			d.Timers = t
		}()
	}
	wg.Wait()

	if d.State == nil {
		d.State = []state.Item{}
	}
	if d.Reminders == nil {
		d.Reminders = []Scheduled{}
	}
	if d.Timers == nil {
		d.Timers = []Scheduled{}
	}
	return d, nil
}

func validateTarget(actorType, actorID string) error {
	if IsInternal(actorType) {
		return ErrInternalType
	}
	if actorType == "" {
		return fmt.Errorf("%w: actor type is required", ErrInvalidRequest)
	}
	if actorID == "" {
		return fmt.Errorf("%w: actor ID is required", ErrInvalidRequest)
	}
	return nil
}

// Invoke calls an actor method through the instance's sidecar.
func (s *Service) Invoke(ctx context.Context, key, actorType, actorID string, r InvokeRequest) (InvokeResult, error) {
	if err := validateTarget(actorType, actorID); err != nil {
		return InvokeResult{}, err
	}
	if r.Method == "" {
		return InvokeResult{}, fmt.Errorf("%w: method is required", ErrInvalidRequest)
	}
	switch strings.ToUpper(r.Verb) {
	case "", http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete:
	default:
		return InvokeResult{}, fmt.Errorf("%w: unsupported verb %q", ErrInvalidRequest, r.Verb)
	}
	in, err := s.apps.Get(ctx, key)
	if err != nil {
		return InvokeResult{}, err
	}
	return Invoke(ctx, s.client, in, actorType, actorID, r)
}

// DeleteReminder deletes one actor reminder through the instance's sidecar.
func (s *Service) DeleteReminder(ctx context.Context, key, actorType, actorID, name string) error {
	if err := validateTarget(actorType, actorID); err != nil {
		return err
	}
	if name == "" {
		return fmt.Errorf("%w: reminder name is required", ErrInvalidRequest)
	}
	in, err := s.apps.Get(ctx, key)
	if err != nil {
		return err
	}
	return DeleteReminder(ctx, s.client, in, actorType, actorID, name)
}
