package workflow

import (
	"bytes"
	"sync"
)

// maxCachedSummaries caps the summary cache. Past it the cache is cleared
// and refills on demand: simple and correct, and a local store that large
// is already an outlier. Note the cliff: with more than this many instances
// every Stats pass overflows and clears the cache, so it stops helping and
// each pass reloads every instance (still correct, just slower).
const maxCachedSummaries = 20_000

// summaryCache holds list/stats summaries keyed by namespace/app/instance and
// validated against two raw values: the instance's metadata bytes and the
// bytes of its first history entry (history-000000). Dapr rewrites the
// metadata record (new HistoryLength/Generation) in the same transaction as
// every history change, so changed metadata catches every in-place change.
// Metadata alone can't catch a purge + re-create under the same instance ID:
// the new instance starts again at Generation 1 and, once it reaches the
// same length, writes byte-identical metadata. Its first event carries the
// creation timestamp, so the first-entry bytes differ and the entry misses.
type summaryCache struct {
	mu  sync.Mutex
	max int
	m   map[string]cachedSummary
}

type cachedSummary struct {
	ns, appID string
	meta      []byte
	first     []byte
	summary   ExecutionSummary
}

func newSummaryCache(max int) *summaryCache {
	return &summaryCache{max: max, m: map[string]cachedSummary{}}
}

func cacheKey(ns, appID, id string) string { return ns + "\x00" + appID + "\x00" + id }

// get returns the cached summary when its metadata bytes equal meta and its
// first-history-entry bytes equal first. A nil meta is always a miss.
func (c *summaryCache) get(key string, meta, first []byte) (ExecutionSummary, bool) {
	if meta == nil {
		return ExecutionSummary{}, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[key]
	if !ok || !bytes.Equal(e.meta, meta) || !bytes.Equal(e.first, first) {
		return ExecutionSummary{}, false
	}
	return e.summary, true
}

func (c *summaryCache) put(key, ns, appID string, meta, first []byte, sum ExecutionSummary) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, exists := c.m[key]; !exists && len(c.m) >= c.max {
		c.m = map[string]cachedSummary{}
	}
	c.m[key] = cachedSummary{ns: ns, appID: appID, meta: meta, first: first, summary: sum}
}

// prune drops entries in namespace ns (and, when appID != "", only that
// app) whose key is not in keep. Called after a full metadata scan.
func (c *summaryCache) prune(ns, appID string, keep map[string]struct{}) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k, e := range c.m {
		if e.ns != ns || (appID != "" && e.appID != appID) {
			continue
		}
		if _, ok := keep[k]; !ok {
			delete(c.m, k)
		}
	}
}

func (c *summaryCache) size() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.m)
}
