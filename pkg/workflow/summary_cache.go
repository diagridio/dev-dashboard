package workflow

import (
	"bytes"
	"sync"
)

// maxCachedSummaries caps the summary cache. Past it the cache is cleared
// and refills on demand: simple and correct, and a local store that large
// is already an outlier.
const maxCachedSummaries = 20_000

// summaryCache holds list/stats summaries keyed by namespace/app/instance and
// validated against the instance's raw metadata bytes. Dapr rewrites the
// metadata record (new HistoryLength/Generation) in the same transaction as
// every history change, so identical bytes mean an unchanged summary.
type summaryCache struct {
	mu  sync.Mutex
	max int
	m   map[string]cachedSummary
}

type cachedSummary struct {
	ns, appID string
	meta      []byte
	summary   ExecutionSummary
}

func newSummaryCache(max int) *summaryCache {
	return &summaryCache{max: max, m: map[string]cachedSummary{}}
}

func cacheKey(ns, appID, id string) string { return ns + "\x00" + appID + "\x00" + id }

// get returns the cached summary when its metadata bytes equal meta.
func (c *summaryCache) get(key string, meta []byte) (ExecutionSummary, bool) {
	if meta == nil {
		return ExecutionSummary{}, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[key]
	if !ok || !bytes.Equal(e.meta, meta) {
		return ExecutionSummary{}, false
	}
	return e.summary, true
}

func (c *summaryCache) put(key, ns, appID string, meta []byte, sum ExecutionSummary) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, exists := c.m[key]; !exists && len(c.m) >= c.max {
		c.m = map[string]cachedSummary{}
	}
	c.m[key] = cachedSummary{ns: ns, appID: appID, meta: meta, summary: sum}
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
