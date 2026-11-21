package cmd

import (
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	defaultNewsFeedURL = "https://www.diagrid.io/api/product-feed"
	// newsFeedEnv overrides the product feed behind the Resources menu and the
	// promotion banner — for local testing with your own feed content.
	newsFeedEnv = "DEVDASHBOARD_NEWS_FEED_URL"
	// overrideNewsTTL keeps an overridden feed fresh, so an edited file shows
	// on the next page reload instead of after the production 1h cache.
	overrideNewsTTL = 5 * time.Second
)

// newsFeed is where the news service fetches the product feed from.
type newsFeed struct {
	Client *http.Client
	URL    string
	TTL    time.Duration
	// Notice is printed at startup when the feed is overridden; empty otherwise.
	Notice string
}

// resolveNewsFeed returns the production feed when raw (the value of
// DEVDASHBOARD_NEWS_FEED_URL) is empty, otherwise an override: an http(s)
// URL, a file:// URL, or a plain (absolute or relative) path to a JSON file.
func resolveNewsFeed(raw string) (newsFeed, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return newsFeed{Client: &http.Client{Timeout: 5 * time.Second}, URL: defaultNewsFeedURL, TTL: time.Hour}, nil
	}
	invalid := func(why string) (newsFeed, error) {
		return newsFeed{}, fmt.Errorf("%s=%q: %s (use an http(s) URL, a file:// URL, or a path to a JSON file)", newsFeedEnv, raw, why)
	}

	if u, err := url.Parse(raw); err == nil && u.Scheme != "" && len(u.Scheme) > 1 { // len>1: not a Windows drive letter
		switch u.Scheme {
		case "http", "https":
			if u.Host == "" {
				return invalid("URL has no host")
			}
			return newsFeed{
				Client: &http.Client{Timeout: 5 * time.Second},
				URL:    raw,
				TTL:    overrideNewsTTL,
				Notice: fmt.Sprintf("News feed override (%s): %s, refreshed every %s.", newsFeedEnv, raw, overrideNewsTTL),
			}, nil
		case "file":
			return fileNewsFeed(raw, filepath.FromSlash(u.Path), invalid)
		default:
			return invalid("unsupported scheme " + u.Scheme)
		}
	}
	return fileNewsFeed(raw, raw, invalid)
}

// fileNewsFeed serves a local JSON file through an http.Client, so the news
// service reads it exactly like the remote feed.
func fileNewsFeed(raw, path string, invalid func(string) (newsFeed, error)) (newsFeed, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return invalid(err.Error())
	}
	if info, err := os.Stat(abs); err != nil {
		return invalid("file not found")
	} else if info.IsDir() {
		return invalid("path is a directory")
	}
	client := &http.Client{Timeout: 5 * time.Second, Transport: http.NewFileTransport(http.Dir(filepath.Dir(abs)))}
	return newsFeed{
		Client: client,
		URL:    "file:///" + url.PathEscape(filepath.Base(abs)),
		TTL:    overrideNewsTTL,
		Notice: fmt.Sprintf("News feed override (%s): %s, re-read every %s.", newsFeedEnv, abs, overrideNewsTTL),
	}, nil
}
