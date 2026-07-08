// Package selfupdate updates the dev-dashboard binary in place from GitHub Releases.
package selfupdate

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// normalizeVersion ensures a single leading "v" and trims surrounding space.
// "1.2.0" -> "v1.2.0"; " v1.2.0 " -> "v1.2.0"; "" -> "".
func normalizeVersion(v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return ""
	}
	return "v" + strings.TrimPrefix(v, "v")
}

// versionsEqual reports whether a and b name the same version, ignoring a
// leading "v" and surrounding space.
func versionsEqual(a, b string) bool {
	return strings.TrimPrefix(strings.TrimSpace(a), "v") ==
		strings.TrimPrefix(strings.TrimSpace(b), "v")
}

// ResolveLatest queries the GitHub releases API for repo's latest tag_name and
// returns it normalized (with a leading "v"). The /releases/latest endpoint
// excludes prereleases by design, so this always resolves to the latest stable release.
func ResolveLatest(ctx context.Context, client *http.Client, apiBase, repo string) (string, error) {
	url := fmt.Sprintf("%s/repos/%s/releases/latest", apiBase, repo)
	body, err := httpGet(ctx, client, url)
	if err != nil {
		return "", fmt.Errorf("resolve latest release: %w", err)
	}
	var rel struct {
		TagName string `json:"tag_name"`
	}
	if err := json.Unmarshal(body, &rel); err != nil {
		return "", fmt.Errorf("parse latest release: %w", err)
	}
	if rel.TagName == "" {
		return "", fmt.Errorf("latest release has no tag_name")
	}
	return normalizeVersion(rel.TagName), nil
}
