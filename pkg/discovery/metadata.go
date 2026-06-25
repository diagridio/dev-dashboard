package discovery

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
)

type Metadata struct {
	ID             string
	RuntimeVersion string
	AppPID         int
	CLIPID         int
	AppCommand     string
	AppLogPath     string
	DaprdLogPath   string
	RunTemplate    string
}

type rawMetadata struct {
	ID             string            `json:"id"`
	RuntimeVersion string            `json:"runtimeVersion"`
	Extended       map[string]string `json:"extended"`
}

// FetchMetadata queries a sidecar's /v1.0/metadata endpoint.
func FetchMetadata(ctx context.Context, client *http.Client, httpPort int) (Metadata, error) {
	url := fmt.Sprintf("http://127.0.0.1:%d/v1.0/metadata", httpPort)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return Metadata{}, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return Metadata{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return Metadata{}, fmt.Errorf("metadata: status %d", resp.StatusCode)
	}
	var raw rawMetadata
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return Metadata{}, err
	}
	atoi := func(k string) int { n, _ := strconv.Atoi(raw.Extended[k]); return n }
	return Metadata{
		ID:             raw.ID,
		RuntimeVersion: raw.RuntimeVersion,
		AppPID:         atoi("appPID"),
		CLIPID:         atoi("cliPID"),
		AppCommand:     raw.Extended["appCommand"],
		AppLogPath:     raw.Extended["appLogPath"],
		DaprdLogPath:   raw.Extended["daprdLogPath"],
		RunTemplate:    raw.Extended["runTemplateName"],
	}, nil
}
