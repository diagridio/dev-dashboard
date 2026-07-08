package updatecheck

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/selfupdate"
)

// maxNegativeTTL caps how long a failed resolve suppresses retries.
const maxNegativeTTL = 5 * time.Minute

// Service reports whether a newer release exists, caching the result.
type Service interface {
	Check(ctx context.Context) Result
}

type service struct {
	client  *http.Client
	apiBase string
	repo    string
	current string
	ttl     time.Duration
	negTTL  time.Duration

	mu        sync.Mutex
	cached    Result
	fetchedAt time.Time
	failedAt  time.Time
	hasResult bool
}

// New builds a caching update-check service. ttl is the positive cache lifetime;
// failed resolves are negatively cached for half the ttl, capped at 5m.
func New(client *http.Client, apiBase, repo, current string, ttl time.Duration) Service {
	negTTL := ttl / 2
	if negTTL > maxNegativeTTL {
		negTTL = maxNegativeTTL
	}
	return &service{
		client:  client,
		apiBase: apiBase,
		repo:    repo,
		current: current,
		ttl:     ttl,
		negTTL:  negTTL,
	}
}

// Check returns update availability, serving from cache when fresh. On a resolve
// error the last-good result is preserved (zero Result if none) and the failure
// is negatively cached so the endpoint is not re-probed on every request.
func (s *service) Check(ctx context.Context) Result {
	// Dev/source builds have no comparable version: skip the network entirely
	// (mirrors the CLI startup guard so the HTTP endpoint stays silent too).
	if !IsReleaseVersion(s.current) {
		return Result{Current: s.current}
	}

	// The mutex is held across the network call below: the cache is warmed at
	// startup, so a waiter is bounded by the http.Client's 5s timeout.
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	if s.hasResult && now.Sub(s.fetchedAt) < s.ttl {
		return s.cached
	}
	if !s.failedAt.IsZero() && now.Sub(s.failedAt) < s.negTTL {
		return s.cached
	}

	// On error the failure is negatively cached, so the endpoint may report
	// "no update" for up to negTTL before retrying.
	latest, err := selfupdate.ResolveLatest(ctx, s.client, s.apiBase, s.repo)
	if err != nil {
		s.failedAt = time.Now()
		return s.cached
	}
	s.cached = evaluate(s.current, latest, s.repo)
	s.fetchedAt = time.Now()
	s.failedAt = time.Time{}
	s.hasResult = true
	return s.cached
}
