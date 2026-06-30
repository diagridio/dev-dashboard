package workflow

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"google.golang.org/protobuf/proto"
)

var (
	ErrNotFound         = errors.New("workflow not found")
	ErrNoStore          = errors.New("no state store configured")
	ErrStoreUnreachable = errors.New("could not connect to state store")
)

const defaultPageSize = 50

type ListQuery struct {
	AppID           string
	Status          []Status
	Search          string
	PageSize        int
	PageToken       string
	IncludeChildren bool
}

type Service interface {
	List(ctx context.Context, q ListQuery) (ListResult, error)
	Stats(ctx context.Context, q ListQuery) (StatsResult, error)
	Get(ctx context.Context, appID, instanceID string) (Execution, error)
	// AppIDs returns every distinct app-id that has workflow data in the store,
	// independent of any list filter — the source of truth for the app filter.
	AppIDs(ctx context.Context) ([]string, error)
}

type service struct {
	store     statestore.Store
	namespace string
}

func New(store statestore.Store, namespace string) Service {
	if namespace == "" {
		namespace = "default"
	}
	return &service{store: store, namespace: namespace}
}

// unreachableService is a workflow.Service for a known state store whose
// backend could not be opened. Every method returns ErrStoreUnreachable
// wrapped with the store's display name and secrets-free connection so the
// API can surface an accurate "could not connect…" message.
type unreachableService struct {
	name string
	conn string
}

// NewUnreachableService builds a Service whose List/Stats/Get all fail with a
// store-specific ErrStoreUnreachable error.
func NewUnreachableService(name, conn string) Service {
	return unreachableService{name: name, conn: conn}
}

func (u unreachableService) err() error {
	return fmt.Errorf("%w %q (%s)", ErrStoreUnreachable, u.name, u.conn)
}

func (u unreachableService) List(context.Context, ListQuery) (ListResult, error) {
	return ListResult{}, u.err()
}

func (u unreachableService) Stats(context.Context, ListQuery) (StatsResult, error) {
	return StatsResult{}, u.err()
}

func (u unreachableService) Get(context.Context, string, string) (Execution, error) {
	return Execution{}, u.err()
}

func (u unreachableService) AppIDs(context.Context) ([]string, error) {
	return nil, u.err()
}

// metaKeys returns instance-metadata keys: scoped to one app when appID != "",
// otherwise across every app-id in the namespace.
func (s *service) metaKeys(ctx context.Context, appID, token string, pageSize int) ([]string, string, error) {
	pattern := statestore.AllInstanceMetaPattern(s.namespace)
	if appID != "" {
		pattern = statestore.InstanceMetaPattern(s.namespace, appID)
	}
	return s.store.Keys(ctx, pattern, token, pageSize)
}

func (s *service) List(ctx context.Context, q ListQuery) (ListResult, error) {
	if s.store == nil {
		return ListResult{}, ErrNoStore
	}
	pageSize := q.PageSize
	if pageSize <= 0 {
		pageSize = defaultPageSize
	}

	metaKeys, next, err := s.metaKeys(ctx, q.AppID, q.PageToken, pageSize)
	if err != nil {
		return ListResult{}, err
	}

	var items []ExecutionSummary
	seen := make(map[string]struct{})
	for _, k := range metaKeys {
		appID, ok := statestore.ParseAppID(k)
		if !ok {
			continue
		}
		id, ok := statestore.ParseInstanceID(k)
		if !ok {
			continue
		}
		dedupKey := appID + "/" + id
		if _, dup := seen[dedupKey]; dup {
			continue
		}
		seen[dedupKey] = struct{}{}
		ex, err := s.load(ctx, appID, id)
		if err != nil {
			continue
		}
		if matches(ex.ExecutionSummary, q) {
			items = append(items, ex.ExecutionSummary)
		}
	}
	sort.SliceStable(items, func(a, b int) bool {
		return afterOrZero(items[a].CreatedAt, items[b].CreatedAt)
	})
	if len(items) > pageSize {
		items = items[:pageSize]
	}
	return ListResult{Items: items, NextToken: next}, nil
}

// Stats scans all instances across the relevant app-ids, honoring AppID and
// Search but ignoring Status and paging, and tallies a count per status.
func (s *service) Stats(ctx context.Context, q ListQuery) (StatsResult, error) {
	if s.store == nil {
		return StatsResult{}, ErrNoStore
	}
	searchQ := ListQuery{Search: q.Search, IncludeChildren: q.IncludeChildren}
	res := StatsResult{Counts: map[Status]int{}}
	seen := make(map[string]struct{})

	metaKeys, _, err := s.metaKeys(ctx, q.AppID, "", 0)
	if err != nil {
		return StatsResult{}, err
	}
	for _, k := range metaKeys {
		appID, ok := statestore.ParseAppID(k)
		if !ok {
			continue
		}
		id, ok := statestore.ParseInstanceID(k)
		if !ok {
			continue
		}
		dedupKey := appID + "/" + id
		if _, dup := seen[dedupKey]; dup {
			continue
		}
		seen[dedupKey] = struct{}{}
		ex, err := s.load(ctx, appID, id)
		if err != nil {
			continue
		}
		if !matches(ex.ExecutionSummary, searchQ) {
			continue
		}
		res.Counts[ex.Status]++
		res.Total++
	}
	return res, nil
}

// AppIDs scans every instance-metadata key across the namespace and returns the
// distinct app-ids, sorted. It reads only keys (no per-instance load), so it is
// cheap relative to List/Stats and is the filter-independent source for the UI's
// app dropdown.
func (s *service) AppIDs(ctx context.Context) ([]string, error) {
	if s.store == nil {
		return nil, ErrNoStore
	}
	keys, _, err := s.store.Keys(ctx, statestore.AllInstanceMetaPattern(s.namespace), "", 0)
	if err != nil {
		return nil, err
	}
	seen := make(map[string]struct{})
	var ids []string
	for _, k := range keys {
		appID, ok := statestore.ParseAppID(k)
		if !ok {
			continue
		}
		if _, dup := seen[appID]; dup {
			continue
		}
		seen[appID] = struct{}{}
		ids = append(ids, appID)
	}
	sort.Strings(ids)
	return ids, nil
}

func (s *service) Get(ctx context.Context, appID, instanceID string) (Execution, error) {
	if s.store == nil {
		return Execution{}, ErrNoStore
	}
	ex, err := s.load(ctx, appID, instanceID)
	if err != nil {
		return Execution{}, err
	}
	if len(ex.History) == 0 && ex.Status == StatusPending && ex.Name == "" {
		return Execution{}, ErrNotFound
	}
	return ex, nil
}

// load reads an instance's history-* and customStatus keys and decodes them.
func (s *service) load(ctx context.Context, appID, instanceID string) (Execution, error) {
	keys, _, err := s.store.Keys(ctx, statestore.InstanceKeyPattern(s.namespace, appID, instanceID), "", 0)
	if err != nil {
		return Execution{}, err
	}
	if len(keys) == 0 {
		return Execution{}, ErrNotFound
	}
	values, err := s.store.BulkGet(ctx, keys)
	if err != nil {
		return Execution{}, err
	}
	prefix := statestore.InstancePrefix(s.namespace, appID, instanceID)
	var history []*protos.HistoryEvent
	var historyKeys []string
	customStatus := ""
	for k := range values {
		suffix := strings.TrimPrefix(k, prefix)
		switch {
		case strings.HasPrefix(suffix, statestore.HistoryPrefix):
			historyKeys = append(historyKeys, k)
		case suffix == statestore.SuffixCustomStatus:
			customStatus = string(values[k])
		}
	}
	sort.Strings(historyKeys) // history-000000, history-000001, ... lexical == chronological
	for _, hk := range historyKeys {
		var e protos.HistoryEvent
		if err := proto.Unmarshal(values[hk], &e); err != nil {
			continue
		}
		history = append(history, &e)
	}
	return DecodeExecution(appID, instanceID, history, customStatus), nil
}

func matches(s ExecutionSummary, q ListQuery) bool {
	if !q.IncludeChildren && s.ParentInstanceID != "" {
		return false
	}
	if len(q.Status) > 0 {
		found := false
		for _, st := range q.Status {
			if s.Status == st {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	if q.Search != "" {
		needle := strings.ToLower(q.Search)
		if !strings.Contains(strings.ToLower(s.InstanceID), needle) && !strings.Contains(strings.ToLower(s.Name), needle) {
			return false
		}
	}
	return true
}

func afterOrZero(a, b *time.Time) bool {
	if a == nil {
		return false
	}
	if b == nil {
		return true
	}
	return a.After(*b)
}
