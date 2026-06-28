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
}

// Service fetches and caches the product feed, exposing derived content slots.
type Service interface {
	Get(ctx context.Context) Response
}

// feedPayload mirrors the upstream JSON structure.
type feedPayload struct {
	LatestBlogPosts  []Item `json:"latestBlogPosts"`
	LatestReports    []Item `json:"latestReports"`
	UpcomingWebinars []Item `json:"upcomingWebinars"`
	UpcomingEvents   []Item `json:"upcomingEvents"`
}

type service struct {
	client    *http.Client
	url       string
	ttl       time.Duration
	mu        sync.Mutex
	cached    Response
	fetchedAt time.Time
	hasGood   bool
}

// New builds a caching news service. url is the upstream product feed URL; ttl is the cache lifetime.
func New(client *http.Client, url string, ttl time.Duration) Service {
	return &service{
		client: client,
		url:    url,
		ttl:    ttl,
	}
}

// Get returns a Response with up to four content slots. It serves from cache when fresh,
// refetches when stale, and falls back to the last-good response on fetch/parse failure.
func (s *service) Get(ctx context.Context) Response {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.hasGood && time.Since(s.fetchedAt) < s.ttl {
		return s.cached
	}

	resp, err := s.fetch(ctx)
	if err != nil {
		return s.cached // last-good (zero Response{} if none)
	}

	derived := derive(resp)
	s.cached = derived
	s.fetchedAt = time.Now()
	s.hasGood = true
	return derived
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
func withUTM(raw string) string {
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
	q.Set("utm_medium", "menu")
	u.RawQuery = q.Encode()
	return u.String()
}

// derive converts a raw feed payload into the four content slots.
func derive(p *feedPayload) Response {
	var r Response

	if len(p.LatestBlogPosts) > 0 {
		item := p.LatestBlogPosts[0]
		item.URL = withUTM(item.URL)
		r.Blog = &item
	}
	if len(p.LatestReports) > 0 {
		item := p.LatestReports[0]
		item.URL = withUTM(item.URL)
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
			item.URL = withUTM(item.URL)
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
			item.URL = withUTM(item.URL)
			r.Event = &item
			break
		}
	}

	return r
}
