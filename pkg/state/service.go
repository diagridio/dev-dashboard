package state

import (
	"context"
	"fmt"
	"sort"

	"github.com/diagridio/dev-dashboard/pkg/statestore"
)

// service is the store-backed Service.
type service struct {
	store  statestore.Store
	reader statestore.RecordReader
}

// New builds a Service over an opened store. A nil store yields ErrNoStore
// from every method — cmd builds a degraded entry that way. A non-nil store
// whose backend does not implement RecordReader yields ErrNotBrowsable.
func New(store statestore.Store, rr statestore.RecordReader) Service {
	return &service{store: store, reader: rr}
}

// ready reports why the service cannot serve, or nil.
func (s *service) ready() error {
	if s.store == nil {
		return ErrNoStore
	}
	if s.reader == nil {
		return ErrNotBrowsable
	}
	return nil
}

// AppIDs returns the sorted distinct key prefixes in the store.
//
// It reads keys only — no values. It ignores Search and AppID, so selecting an
// app never collapses the dropdown to that one app, but it does honour
// includeInternal: a prefix earns its place only if at least one of its keys
// survives that filter. Without this, a store full of finished workflow apps
// offers a dropdown of prefixes that every yield an empty table, since
// workflow history and actor state are hidden by default.
//
// A prefix that has both plain records and workflow/actor keys therefore stays
// listed either way — the filter is per key, not per prefix.
//
// Unprefixed keys contribute nothing; those records are still listed and
// reachable under "All apps".
func (s *service) AppIDs(ctx context.Context, includeInternal bool) ([]string, error) {
	if err := s.ready(); err != nil {
		return nil, err
	}
	keys, _, err := s.store.Keys(ctx, "%", "", 0)
	if err != nil {
		return nil, err
	}
	seen := make(map[string]struct{}, len(keys))
	var ids []string
	for _, k := range keys {
		p := classify(k)
		if p.AppID == "" {
			continue
		}
		if !includeInternal && p.Kind != KindApp {
			continue
		}
		if _, dup := seen[p.AppID]; dup {
			continue
		}
		seen[p.AppID] = struct{}{}
		ids = append(ids, p.AppID)
	}
	sort.Strings(ids)
	return ids, nil
}

// Delete removes each key, reporting per-key outcomes so a partial failure
// names exactly which keys survived. There is no second mechanism: unlike a
// workflow instance, a state record has no lifecycle to terminate.
func (s *service) Delete(ctx context.Context, keys []string) []DeleteResult {
	out := make([]DeleteResult, 0, len(keys))
	if err := s.ready(); err != nil {
		for _, k := range keys {
			out = append(out, DeleteResult{Key: k, Error: err.Error()})
		}
		return out
	}
	for _, k := range keys {
		res := DeleteResult{Key: k}
		if err := s.store.Delete(ctx, k); err != nil {
			res.Error = err.Error()
		} else {
			res.OK = true
		}
		out = append(out, res)
	}
	return out
}

// Set writes one record at AppID||Key — the same composition classify() splits
// on read.
//
// The existence check is a read followed by a write, so a concurrent writer
// could slip in between. For a local dashboard driving a local store that race
// is not worth an ETag dance, and losing it only means an overwrite the user
// was one click away from confirming anyway.
func (s *service) Set(ctx context.Context, req SetRequest) error {
	if err := s.ready(); err != nil {
		return err
	}
	key := ComposeKey(req.AppID, req.Key)
	if !req.Overwrite {
		existing, err := s.store.Get(ctx, key)
		if err != nil {
			return err
		}
		if existing != nil {
			return fmt.Errorf("%w: %s", ErrExists, key)
		}
	}
	return s.store.Set(ctx, key, []byte(req.Value))
}

// unreachable is the Service for a known store whose backend could not be
// opened. Every method fails with a store-specific ErrStoreUnreachable so the
// API can surface an accurate "could not connect…" message. There is no
// sidecar fallback: Dapr's HTTP State API cannot enumerate keys.
type unreachable struct{ name, conn string }

// NewUnreachable builds a Service that always reports ErrStoreUnreachable.
func NewUnreachable(name, conn string) Service { return unreachable{name: name, conn: conn} }

func (u unreachable) err() error {
	return fmt.Errorf("%w %q (%s)", ErrStoreUnreachable, u.name, u.conn)
}

func (u unreachable) List(context.Context, ListQuery) (ListResult, error) {
	return ListResult{}, u.err()
}
func (u unreachable) Record(context.Context, string) (Record, error) { return Record{}, u.err() }
func (u unreachable) AppIDs(context.Context, bool) ([]string, error) { return nil, u.err() }
func (u unreachable) Set(context.Context, SetRequest) error          { return u.err() }
func (u unreachable) Delete(_ context.Context, keys []string) []DeleteResult {
	out := make([]DeleteResult, 0, len(keys))
	for _, k := range keys {
		out = append(out, DeleteResult{Key: k, Error: u.err().Error()})
	}
	return out
}

// List returns one page of records.
//
// The ordering matters. Keys are paged and classified first, so a store that
// is 99% workflow history costs only key bytes to skip; the single bulk value
// read happens last, for the rows actually returned. (Contrast workflow.List,
// which must load each instance in order to filter it.)
//
// Loop-fill is needed even though the app filter and key search are pushed
// into the pattern, because excluding runtime-internal keys cannot be: KeysLike
// takes a single positive pattern with no negation. As in workflow.List,
// NextToken always points past the last fully-scanned key page, so a page
// capped by the scan guard may hold fewer than PageSize items — possibly zero —
// alongside a non-empty token; clients must treat that as "keep paging".
// Accumulated matches are never truncated: NextToken has already advanced past
// them, so dropping them would remove them from pagination entirely.
func (s *service) List(ctx context.Context, q ListQuery) (ListResult, error) {
	if err := s.ready(); err != nil {
		return ListResult{}, err
	}
	pageSize := q.PageSize
	if pageSize <= 0 {
		pageSize = defaultPageSize
	}
	pattern := listPattern(q.AppID, q.Search)

	maxScan := pageSize * filteredScanPageMultiple
	if maxScan > maxFilteredScanKeys {
		maxScan = maxFilteredScanKeys
	}

	var matched []string
	parts := make(map[string]keyParts, pageSize)
	token := q.PageToken
	next := ""
	scanned := 0
	for {
		keys, n, err := s.store.Keys(ctx, pattern, token, pageSize)
		if err != nil {
			return ListResult{}, err
		}
		next = n
		scanned += len(keys)
		for _, k := range keys {
			p := classify(k)
			if !q.IncludeInternal && p.Kind != KindApp {
				continue
			}
			if _, dup := parts[k]; dup {
				continue
			}
			parts[k] = p
			matched = append(matched, k)
		}
		// Unfiltered: preserve one-key-page-per-call semantics. Filtered: stop
		// once the page is full, the keys ran out, or the scan cap is reached.
		if q.IncludeInternal || len(matched) >= pageSize || next == "" || scanned >= maxScan {
			break
		}
		token = next
	}

	recs, err := s.reader.Records(ctx, matched)
	if err != nil {
		return ListResult{}, err
	}
	byKey := make(map[string]statestore.Record, len(recs))
	for _, r := range recs {
		byKey[r.Key] = r
	}

	items := make([]Item, 0, len(matched))
	for _, k := range matched {
		r, ok := byKey[k]
		if !ok {
			continue // deleted between the key scan and the value read
		}
		items = append(items, newItem(parts[k], r))
	}
	// Keys ordering is not guaranteed across backends; sort so page boundaries
	// and the rendered order are stable.
	sort.Slice(items, func(a, b int) bool { return items[a].Key < items[b].Key })
	return ListResult{Items: items, NextToken: next}, nil
}

// newItem builds a list row from a classified key and its record.
func newItem(p keyParts, r statestore.Record) Item {
	rendered, enc := renderValue(r.Value)
	return Item{
		Key:          r.Key,
		AppID:        p.AppID,
		LogicalKey:   p.LogicalKey,
		Kind:         p.Kind,
		Preview:      preview(rendered),
		Encoding:     enc,
		Size:         len(r.Value),
		ETag:         r.ETag,
		TTLExpiresAt: r.TTLExpire,
		ContentType:  r.ContentType,
	}
}

// Record returns one record's full value, capped at maxValueBytes. It reads by
// exact key, so a runtime-internal key the list filter hides is still readable.
func (s *service) Record(ctx context.Context, key string) (Record, error) {
	if err := s.ready(); err != nil {
		return Record{}, err
	}
	recs, err := s.reader.Records(ctx, []string{key})
	if err != nil {
		return Record{}, err
	}
	if len(recs) == 0 {
		return Record{}, ErrNotFound
	}
	r := recs[0]
	p := classify(r.Key)
	rendered, enc := renderValue(r.Value)
	value, cut := truncateValue(rendered)
	return Record{
		Key:          r.Key,
		AppID:        p.AppID,
		LogicalKey:   p.LogicalKey,
		Kind:         p.Kind,
		Value:        value,
		Encoding:     enc,
		Size:         len(r.Value),
		Truncated:    cut,
		ETag:         r.ETag,
		TTLExpiresAt: r.TTLExpire,
		ContentType:  r.ContentType,
	}, nil
}
