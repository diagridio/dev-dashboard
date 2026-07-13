package discovery

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strconv"
)

type ActorType struct {
	Type  string `json:"type"`
	Count int    `json:"count"`
}

type SubRule struct {
	Match string `json:"match,omitempty"`
	Path  string `json:"path,omitempty"`
}

type Subscription struct {
	PubsubName      string    `json:"pubsubName"`
	Topic           string    `json:"topic"`
	Rules           []SubRule `json:"rules,omitempty"`
	DeadLetterTopic string    `json:"deadLetterTopic,omitempty"`
	Type            string    `json:"type,omitempty"`
}

type Component struct {
	Name    string `json:"name"`
	Type    string `json:"type"`
	Version string `json:"version,omitempty"`
}

type Metadata struct {
	ID              string
	RuntimeVersion  string
	AppPID          int
	CLIPID          int
	AppCommand      string
	AppLogPath      string
	DaprdLogPath    string
	RunTemplate     string
	AppProtocol     string
	Actors          []ActorType
	Subscriptions   []Subscription
	Components      []Component
	EnabledFeatures []string
	Placement       string
}

type rawSubscription struct {
	PubsubName      string    `json:"pubsubname"`
	Topic           string    `json:"topic"`
	Rules           []SubRule `json:"rules"`
	DeadLetterTopic string    `json:"deadLetterTopic"`
	Type            string    `json:"type"`
}

type rawMetadata struct {
	ID              string            `json:"id"`
	RuntimeVersion  string            `json:"runtimeVersion"`
	EnabledFeatures []string          `json:"enabledFeatures"`
	Extended        map[string]string `json:"extended"`
	Actors          []ActorType       `json:"actors"`
	Components      []Component       `json:"components"`
	Subscriptions   []rawSubscription `json:"subscriptions"`
	ActorRuntime    struct {
		Placement string `json:"placement"`
	} `json:"actorRuntime"`
	AppConnectionProperties struct {
		Protocol string `json:"protocol"`
	} `json:"appConnectionProperties"`
}

// runTemplateFromExtended returns the run template's display name. The
// CLI's "runTemplateName" is the run template YAML's optional top-level
// `name` field, which is commonly left unset; in that case fall back to the
// basename of "runTemplatePath" (the absolute path to the template file,
// always set by the CLI when apps are started via `dapr run -f`).
func runTemplateFromExtended(extended map[string]string) string {
	if name := extended["runTemplateName"]; name != "" {
		return name
	}
	if path := extended["runTemplatePath"]; path != "" {
		return filepath.Base(path)
	}
	return ""
}

// FetchMetadata queries a sidecar's /v1.0/metadata endpoint at baseURL.
func FetchMetadata(ctx context.Context, client *http.Client, baseURL string) (Metadata, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/v1.0/metadata", nil)
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

	subs := make([]Subscription, len(raw.Subscriptions))
	for i, rs := range raw.Subscriptions {
		subs[i] = Subscription{
			PubsubName:      rs.PubsubName,
			Topic:           rs.Topic,
			Rules:           rs.Rules,
			DeadLetterTopic: rs.DeadLetterTopic,
			Type:            rs.Type,
		}
	}

	return Metadata{
		ID:              raw.ID,
		RuntimeVersion:  raw.RuntimeVersion,
		AppPID:          atoi("appPID"),
		CLIPID:          atoi("cliPID"),
		AppCommand:      raw.Extended["appCommand"],
		AppLogPath:      raw.Extended["appLogPath"],
		DaprdLogPath:    raw.Extended["daprdLogPath"],
		RunTemplate:     runTemplateFromExtended(raw.Extended),
		AppProtocol:     raw.AppConnectionProperties.Protocol,
		Actors:          raw.Actors,
		Components:      raw.Components,
		Subscriptions:   subs,
		EnabledFeatures: raw.EnabledFeatures,
		Placement:       raw.ActorRuntime.Placement,
	}, nil
}
