package workflow

import (
	"context"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"google.golang.org/protobuf/proto"
)

var (
	ErrNotFound = errors.New("workflow not found")
	ErrNoStore  = errors.New("no state store configured")
)

const defaultPageSize = 50

type ListQuery struct {
	AppID     string
	Status    []Status
	Search    string
	PageSize  int
	PageToken string
}

type Service interface {
	List(ctx context.Context, q ListQuery) (ListResult, error)
	Stats(ctx context.Context, q ListQuery) (StatsResult, error)
	Get(ctx context.Context, appID, instanceID string) (Execution, error)
}

type service struct {
	store     statestore.Store
	namespace string
	appIDs    func(context.Context) ([]string, error)
}

func New(store statestore.Store, namespace string, appIDs func(context.Context) ([]string, error)) Service {
	if namespace == "" {
		namespace = "default"
	}
	return &service{store: store, namespace: namespace, appIDs: appIDs}
}

func (s *service) List(ctx context.Context, q ListQuery) (ListResult, error) {
	if s.store == nil {
		return ListResult{}, ErrNoStore
	}
	apps, err := s.appIDs(ctx)
	if err != nil {
		return ListResult{}, err
	}
	if q.AppID != "" {
		apps = []string{q.AppID}
	}
	pageSize := q.PageSize
	if pageSize <= 0 {
		pageSize = defaultPageSize
	}

	var items []ExecutionSummary
	seen := make(map[string]struct{})
	var next string
	for _, appID := range apps {
		keys, tok, err := s.store.Keys(ctx, statestore.InstanceMetaPattern(s.namespace, appID), q.PageToken, pageSize)
		if err != nil {
			return ListResult{}, err
		}
		if tok != "" {
			next = tok
		}
		for _, k := range keys {
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
	}
	sort.SliceStable(items, func(a, b int) bool {
		return afterOrZero(items[a].CreatedAt, items[b].CreatedAt)
	})
	if len(items) > pageSize {
		items = items[:pageSize]
	}
	return ListResult{Items: items, NextToken: next}, nil
}

// Stats scans all instances across the relevant apps, honoring AppID and
// Search but ignoring Status and paging, and tallies a count per status.
func (s *service) Stats(ctx context.Context, q ListQuery) (StatsResult, error) {
	if s.store == nil {
		return StatsResult{}, ErrNoStore
	}
	apps, err := s.appIDs(ctx)
	if err != nil {
		return StatsResult{}, err
	}
	if q.AppID != "" {
		apps = []string{q.AppID}
	}
	// Reuse matches() for search only — never filter counts by status.
	searchQ := ListQuery{Search: q.Search}
	res := StatsResult{Counts: map[Status]int{}}
	seen := make(map[string]struct{})
	for _, appID := range apps {
		// pageSize 0 = all keys (same convention load() relies on).
		keys, _, err := s.store.Keys(ctx, statestore.InstanceMetaPattern(s.namespace, appID), "", 0)
		if err != nil {
			return StatsResult{}, err
		}
		for _, k := range keys {
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
	}
	return res, nil
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
