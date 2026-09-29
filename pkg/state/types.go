// Package state reads and deletes records from a Dapr state store.
//
// It is the read model behind the dashboard's State page, and is deliberately
// separate from pkg/workflow: that package decodes one known key shape into
// executions, while this one browses the whole keyspace without interpreting
// what it finds.
package state

import (
	"context"
	"errors"
	"time"
)

var (
	// ErrNoStore: no store is configured (or the degraded no-store entry).
	ErrNoStore = errors.New("no state store configured")
	// ErrStoreUnreachable: a known store that could not be opened.
	ErrStoreUnreachable = errors.New("could not connect to state store")
	// ErrNotBrowsable: the store opened but cannot enumerate keys or read
	// record metadata. Dapr's HTTP State API cannot list keys, so there is no
	// fallback for such a store — the page reports it rather than degrading.
	ErrNotBrowsable = errors.New("state store cannot be browsed")
	// ErrNotFound: the requested key does not exist.
	ErrNotFound = errors.New("record not found")
	// ErrExists: the key a write would create is already present, and the
	// write did not ask to overwrite it.
	ErrExists = errors.New("record already exists")
)

// Kind is how a key was produced: app code, the workflow engine, or an actor.
type Kind string

const (
	KindApp      Kind = "app"
	KindWorkflow Kind = "workflow"
	KindActor    Kind = "actor"
)

// Encoding labels how Value/Preview represent the raw bytes.
const (
	EncodingText   = "text"
	EncodingBase64 = "base64"
)

const (
	defaultPageSize = 50
	// previewChars bounds the single-line preview carried in a list item.
	previewChars = 200
	// maxValueBytes bounds a single record's value on the detail read.
	maxValueBytes = 1 << 20 // 1 MiB
	// Guard rails for the loop-fill in List: excluding runtime-internal keys
	// cannot be expressed in a KeysLike pattern (it takes a single positive
	// pattern with no negation), so a page can under-fill and must be refilled
	// — but never by scanning more than this many keys.
	filteredScanPageMultiple = 10
	maxFilteredScanKeys      = 2000
)

// ListQuery is one page request. IncludeInternal false — the default — keeps
// only KindApp records.
type ListQuery struct {
	AppID           string
	Search          string
	PageToken       string
	PageSize        int
	IncludeInternal bool
}

// Item is one row in a listing: metadata plus a bounded preview, never the
// full value. The full value comes from Service.Record so that list pages stay
// small under the dashboard's auto-refresh.
type Item struct {
	Key          string     `json:"key"`
	AppID        string     `json:"appId"`
	LogicalKey   string     `json:"logicalKey"`
	Kind         Kind       `json:"kind"`
	Preview      string     `json:"preview"`
	Encoding     string     `json:"encoding"`
	Size         int        `json:"size"`
	ETag         string     `json:"etag,omitempty"`
	TTLExpiresAt *time.Time `json:"ttlExpiresAt,omitempty"`
	ContentType  string     `json:"contentType,omitempty"`
}

// Record is one record's full value plus metadata.
type Record struct {
	Key          string     `json:"key"`
	AppID        string     `json:"appId"`
	LogicalKey   string     `json:"logicalKey"`
	Kind         Kind       `json:"kind"`
	Value        string     `json:"value"`
	Encoding     string     `json:"encoding"`
	Size         int        `json:"size"`
	Truncated    bool       `json:"truncated"`
	ETag         string     `json:"etag,omitempty"`
	TTLExpiresAt *time.Time `json:"ttlExpiresAt,omitempty"`
	ContentType  string     `json:"contentType,omitempty"`
}

// ListResult is one page. A non-empty NextToken means "keep paging" even when
// Items is short: the token has already advanced past every scanned key.
type ListResult struct {
	Items     []Item `json:"items"`
	NextToken string `json:"nextToken,omitempty"`
}

// DeleteResult reports one key's outcome, so a partial failure names exactly
// which keys survived.
type DeleteResult struct {
	Key   string `json:"key"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

// SetRequest is one record write. Value is stored verbatim as bytes: Dapr
// SDKs read values as JSON, but wrapping the text here would mean a pasted
// JSON object could not be stored as one, so the encoding stays the caller's
// choice. Overwrite false fails with ErrExists when the key already exists.
type SetRequest struct {
	AppID     string
	Key       string
	Value     string
	Overwrite bool
}

// Service is the read + write + delete surface the API needs.
type Service interface {
	List(ctx context.Context, q ListQuery) (ListResult, error)
	Record(ctx context.Context, key string) (Record, error)
	// AppIDs lists the selectable key prefixes. includeInternal must match the
	// caller's list filter so the dropdown never offers a prefix whose every
	// record that filter hides.
	AppIDs(ctx context.Context, includeInternal bool) ([]string, error)
	Delete(ctx context.Context, keys []string) []DeleteResult
	// Set writes one record at AppID||Key. It reports ErrExists rather than
	// replacing a present key unless the request opts into overwriting.
	Set(ctx context.Context, req SetRequest) error
}
