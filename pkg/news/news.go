package news

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Item represents a single content item from the product feed.
type Item struct {
	Title          string `json:"title"`
	URL            string `json:"url"`
	Excerpt        string `json:"excerpt,omitempty"`
	PublishedAt    string `json:"publishedAt,omitempty"`
	EventStartDate string `json:"eventStartDate,omitempty"`
	EventLocation  string `json:"eventLocation,omitempty"`
}

// Response holds the four derived content slots returned by the news service.
type Response struct {
	Blog    *Item `json:"blog"`
	Report  *Item `json:"report"`
	Webinar *Item `json:"webinar"`
	Event   *Item `json:"event"`
	// Promotion is the single time-sensitive item to float in as a banner,
	// or nil. The window (StartsAt/EndsAt) is applied on every Get.
	Promotion *Promotion `json:"promotion"`
}

// Promotion is the feed's optional time-sensitive banner item.
type Promotion struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Text     string `json:"text,omitempty"`
	URL      string `json:"url"`
	CTA      string `json:"cta"`
	StartsAt string `json:"startsAt,omitempty"`
	EndsAt   string `json:"endsAt,omitempty"`
}

// Service fetches and caches the product feed, exposing derived content slots.
type Service interface {
	Get(ctx context.Context) Response
}

// feedPayload mirrors the upstream JSON structure.
type feedPayload struct {
	LatestBlogPosts  []Item     `json:"latestBlogPosts"`
	LatestReports    []Item     `json:"latestReports"`
	UpcomingWebinars []Item     `json:"upcomingWebinars"`
	UpcomingEvents   []Item     `json:"upcomingEvents"`
	Promotion        *Promotion `json:"promotion"`
}

// maxNegativeTTL caps how long a failed refresh suppresses retries.
const maxNegativeTTL = 30 * time.Second

type service struct {
	client *http.Client
	url    string
	ttl    time.Duration
	negTTL time.Duration

	mu        sync.Mutex
	cached    Response
	fetchedAt time.Time     // time of the last successful fetch
	failedAt  time.Time     // time of the last failed fetch (zero after a success)
	hasGood   bool          // whether cached holds a real (last-good) response
	inflight  chan struct{} // non-nil while a fetch is in progress; closed when it completes
}

// New builds a caching news service. url is the upstream product feed URL; ttl is the cache lifetime.
// Failed fetches are negatively cached for half the ttl, capped at 30s, so an
// upstream outage is not re-probed on every request.
func New(client *http.Client, url string, ttl time.Duration) Service {
	negTTL := ttl / 2
	if negTTL > maxNegativeTTL {
		negTTL = maxNegativeTTL
	}
	return &service{
		client: client,
		url:    url,
		ttl:    ttl,
		negTTL: negTTL,
	}
}

// Get returns a Response with up to four content slots. It serves from cache when
// fresh. When stale, at most one fetch is in flight at a time: callers with a
// last-good response get it immediately (the refresh runs in the background),
// while callers with no last-good wait for the single in-flight fetch. A failed
// fetch is negatively cached and never evicts the last-good response.
// Get returns the cached content slots, with the promotion filtered against
// its time window at call time, so it disappears at endsAt even while the
// feed itself is still cached.
func (s *service) Get(ctx context.Context) Response {
	r := s.get(ctx)
	r.Promotion = activePromotion(r.Promotion, time.Now())
	return r
}

func (s *service) get(ctx context.Context) Response {
	s.mu.Lock()

	if s.hasGood && time.Since(s.fetchedAt) < s.ttl {
		r := s.cached
		s.mu.Unlock()
		return r
	}

	// Negative cache: a recent failed fetch is not retried yet.
	if s.inflight == nil && !s.failedAt.IsZero() && time.Since(s.failedAt) < s.negTTL {
		r := s.cached // last-good (zero Response{} if none)
		s.mu.Unlock()
		return r
	}

	if ch := s.inflight; ch != nil {
		// A fetch is already in progress.
		if s.hasGood {
			r := s.cached
			s.mu.Unlock()
			return r // serve stale immediately rather than blocking
		}
		s.mu.Unlock()
		select {
		case <-ch: // share the single in-flight fetch's outcome
			s.mu.Lock()
			r := s.cached
			s.mu.Unlock()
			return r
		case <-ctx.Done():
			return Response{}
		}
	}

	// Become the refresher.
	ch := make(chan struct{})
	s.inflight = ch
	if s.hasGood {
		r := s.cached
		s.mu.Unlock()
		// Stale-while-revalidate: refresh in the background, detached from the
		// caller's context so a canceled request doesn't abort the refresh.
		go s.refresh(context.Background(), ch)
		return r
	}
	s.mu.Unlock()
	return s.refresh(ctx, ch)
}

// refresh performs one upstream fetch (without holding the lock), records the
// outcome, and wakes any callers waiting on ch. On failure the last-good
// response is preserved and the failure time is recorded for negative caching.
func (s *service) refresh(ctx context.Context, ch chan struct{}) Response {
	payload, err := s.fetch(ctx)

	s.mu.Lock()
	if err != nil {
		s.failedAt = time.Now()
	} else {
		s.cached = derive(payload)
		s.fetchedAt = time.Now()
		s.failedAt = time.Time{}
		s.hasGood = true
	}
	r := s.cached
	s.inflight = nil
	s.mu.Unlock()
	close(ch)
	return r
}

// fetch performs the HTTP request and parses the feed payload.
func (s *service) fetch(ctx context.Context) (*feedPayload, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.url, nil)
	if err != nil {
		return nil, err
	}
	res, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, &httpError{code: res.StatusCode}
	}
	var payload feedPayload
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		return nil, err
	}
	return &payload, nil
}

// httpError represents a non-2xx HTTP response.
type httpError struct {
	code int
}

func (e *httpError) Error() string {
	return "news: upstream returned status " + http.StatusText(e.code)
}

// withUTM appends dev-dashboard UTM parameters to URLs on the diagrid.io
// domain, preserving any existing query parameters. URLs on other hosts (or
// that fail to parse) are returned unchanged.
func withUTM(raw, medium string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	host := strings.ToLower(u.Hostname())
	if host != "diagrid.io" && host != "www.diagrid.io" {
		return raw
	}
	q := u.Query()
	q.Set("utm_source", "dev-dashboard")
	q.Set("utm_medium", medium)
	u.RawQuery = q.Encode()
	return u.String()
}

// derive converts a raw feed payload into the four content slots.
func derive(p *feedPayload) Response {
	var r Response

	if len(p.LatestBlogPosts) > 0 {
		item := p.LatestBlogPosts[0]
		item.URL = withUTM(item.URL, "menu")
		r.Blog = &item
	}
	if len(p.LatestReports) > 0 {
		item := p.LatestReports[0]
		item.URL = withUTM(item.URL, "menu")
		r.Report = &item
	}

	now := time.Now()

	for i := range p.UpcomingWebinars {
		t, err := time.Parse(time.RFC3339, p.UpcomingWebinars[i].EventStartDate)
		if err != nil {
			continue // parse error → skip
		}
		if t.After(now) {
			item := p.UpcomingWebinars[i]
			item.URL = withUTM(item.URL, "menu")
			r.Webinar = &item
			break
		}
	}

	for i := range p.UpcomingEvents {
		t, err := time.Parse(time.RFC3339, p.UpcomingEvents[i].EventStartDate)
		if err != nil {
			continue // parse error → skip
		}
		if t.After(now) {
			item := p.UpcomingEvents[i]
			item.URL = withUTM(item.URL, "menu")
			r.Event = &item
			break
		}
	}

	r.Promotion = validPromotion(p.Promotion)

	return r
}

// validPromotion returns a normalised copy of p, or nil when a required field
// is missing, the URL isn't http(s), or a window bound doesn't parse.
func validPromotion(p *Promotion) *Promotion {
	if p == nil {
		return nil
	}
	c := *p
	c.ID, c.Title, c.URL = strings.TrimSpace(c.ID), strings.TrimSpace(c.Title), strings.TrimSpace(c.URL)
	if c.ID == "" || c.Title == "" || c.URL == "" {
		return nil
	}
	u, err := url.Parse(c.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil
	}
	if _, _, err := parseBound(c.StartsAt, false); err != nil {
		return nil
	}
	if _, _, err := parseBound(c.EndsAt, true); err != nil {
		return nil
	}
	if strings.TrimSpace(c.CTA) == "" {
		c.CTA = "Learn more"
	}
	c.URL = withUTM(c.URL, "banner")
	return &c
}

// parseBound parses a window bound: RFC 3339, or a bare YYYY-MM-DD in UTC.
// A bare-date end bound is inclusive, so it resolves to the next midnight.
// ok is false for an empty string (no bound).
func parseBound(s string, end bool) (t time.Time, ok bool, err error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, false, nil
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t, true, nil
	}
	t, err = time.Parse("2006-01-02", s)
	if err != nil {
		return time.Time{}, false, err
	}
	if end {
		t = t.AddDate(0, 0, 1)
	}
	return t, true, nil
}

// activePromotion returns p when now is inside its [startsAt, endsAt) window.
func activePromotion(p *Promotion, now time.Time) *Promotion {
	if p == nil {
		return nil
	}
	if start, ok, err := parseBound(p.StartsAt, false); err != nil || (ok && now.Before(start)) {
		return nil
	}
	if end, ok, err := parseBound(p.EndsAt, true); err != nil || (ok && !now.Before(end)) {
		return nil
	}
	return p
}
