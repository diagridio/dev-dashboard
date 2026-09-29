package statestore

import (
	"context"
	"fmt"
	"time"

	"github.com/dapr/components-contrib/state"
)

// Record is one state entry with the metadata the four supported backends
// actually expose. There is deliberately no created/modified timestamp:
// components-contrib never surfaces one, even for the SQL backends whose
// tables physically store it (see the design spec).
type Record struct {
	Key       string
	Value     []byte
	ETag      string     // "" when the backend has none for this entry
	TTLExpire *time.Time // nil when the entry has no TTL
	// ContentType is nil for all four supported backends today; it is carried
	// through so it starts working for free if contrib begins populating it.
	ContentType string
}

// RecordReader is the metadata-preserving bulk read path. ccStore implements
// it; consumers type-assert for it rather than it being part of Store, mirroring
// how ccStore.Keys asserts for state.KeysLiker.
type RecordReader interface {
	Records(ctx context.Context, keys []string) ([]Record, error)
}

// recordsFromBulk converts a contrib bulk-get response into Records.
//
// Entries the backend could not read (non-empty Error) and entries that do not
// exist (backends fill those in with just a Key) are omitted: a key deleted
// between the key scan and the value fetch should vanish from the page rather
// than render as an empty row. A present-but-empty value is kept, which is why
// the existence check tests Data == nil rather than len(Data) == 0.
func recordsFromBulk(resp []state.BulkGetResponse) []Record {
	out := make([]Record, 0, len(resp))
	for _, r := range resp {
		if r.Error != "" || (r.Data == nil && r.ETag == nil) {
			continue
		}
		rec := Record{Key: r.Key, Value: r.Data}
		if r.ETag != nil {
			rec.ETag = *r.ETag
		}
		if r.ContentType != nil {
			rec.ContentType = *r.ContentType
		}
		if ts, ok := r.Metadata[state.GetRespMetaKeyTTLExpireTime]; ok {
			// A malformed timestamp costs the TTL column, not the record.
			if t, err := time.Parse(time.RFC3339, ts); err == nil {
				rec.TTLExpire = &t
			}
		}
		out = append(out, rec)
	}
	return out
}

// Records reads multiple keys in a single backend round-trip, preserving etag
// and TTL. state.Store embeds state.BulkStore, so all four supported backends
// satisfy the assertion; the error path is defensive.
func (s *ccStore) Records(ctx context.Context, keys []string) ([]Record, error) {
	if len(keys) == 0 {
		return nil, nil
	}
	bs, ok := s.inner.(state.BulkStore)
	if !ok {
		return nil, fmt.Errorf("store %q does not support bulk reads", s.storeType)
	}
	reqs := make([]state.GetRequest, len(keys))
	for i, k := range keys {
		reqs[i] = state.GetRequest{Key: k}
	}
	resp, err := bs.BulkGet(ctx, reqs, state.BulkGetOpts{})
	if err != nil {
		return nil, err
	}
	return recordsFromBulk(resp), nil
}
