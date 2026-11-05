//go:build unit

package demo

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	"sigs.k8s.io/yaml"

	"github.com/diagridio/dev-dashboard/pkg/resources"
)

func list(t *testing.T, kind resources.Kind) []resources.Resource {
	t.Helper()
	svc := resources.New(func() []string { return []string{"resources"} }, nil)
	out, err := svc.List(context.Background(), kind)
	if err != nil {
		t.Fatalf("List(%s): %v", kind, err)
	}
	return out
}

func decode(t *testing.T, name string, v any) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("resources", name))
	if err != nil {
		t.Fatal(err)
	}
	if err := yaml.Unmarshal(raw, v); err != nil {
		t.Fatal(err)
	}
}

func TestDemoResourcesLoad(t *testing.T) {
	comps := list(t, resources.KindComponent)
	got := map[string]string{}
	for _, c := range comps {
		got[c.Name] = c.Type
	}
	want := map[string]string{
		"statestore":     "state.redis",
		"pubsub":         "pubsub.redis",
		"payloads":       "binarystore.in-memory",
		"sweep-schedule": "bindings.cron",
		"command-codes":  "secretstores.local.file",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("components = %v, want %v", got, want)
	}

	// The loader does not expose component metadata; decode the file directly.
	raw, err := os.ReadFile(filepath.Join("resources", "statestore.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var sc struct {
		Spec struct {
			Metadata []struct{ Name, Value string } `json:"metadata"`
		} `json:"spec"`
	}
	if err := yaml.Unmarshal(raw, &sc); err != nil {
		t.Fatal(err)
	}
	actor := ""
	for _, m := range sc.Spec.Metadata {
		if m.Name == "actorStateStore" {
			actor = m.Value
		}
	}
	if actor != "true" {
		t.Errorf("statestore actorStateStore = %q, want \"true\"", actor)
	}

	craw, err := os.ReadFile(filepath.Join("resources", "sweep-schedule.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var cron struct {
		Spec struct {
			Metadata []struct{ Name, Value string } `json:"metadata"`
		} `json:"spec"`
	}
	if err := yaml.Unmarshal(craw, &cron); err != nil {
		t.Fatal(err)
	}
	sched := ""
	for _, m := range cron.Spec.Metadata {
		if m.Name == "schedule" {
			sched = m.Value
		}
	}
	if sched != "@every 24h" {
		t.Errorf("cron schedule = %q, want @every 24h", sched)
	}

	for _, c := range comps {
		if c.Name == "payloads" || c.Name == "sweep-schedule" {
			if !reflect.DeepEqual(c.Scopes, []string{"engineering"}) {
				t.Errorf("%s scopes = %v, want [engineering]", c.Name, c.Scopes)
			}
		}
	}

	names := func(kind resources.Kind) []string {
		var n []string
		for _, r := range list(t, kind) {
			n = append(n, r.Name)
		}
		sort.Strings(n)
		return n
	}
	if n := names(resources.KindConfiguration); !reflect.DeepEqual(n, []string{"diagnostics"}) {
		t.Errorf("configurations = %v", n)
	}
	if n := names(resources.KindResiliency); !reflect.DeepEqual(n, []string{"ship-systems"}) {
		t.Errorf("resiliencies = %v", n)
	}

	// Configuration features and resiliency targets are not exposed by the
	// loader; decode the files directly.
	var cfg struct {
		Spec struct {
			Features []struct {
				Name    string `json:"name"`
				Enabled bool   `json:"enabled"`
			} `json:"features"`
		} `json:"spec"`
	}
	decode(t, "diagnostics-config.yaml", &cfg)
	if len(cfg.Spec.Features) != 1 || cfg.Spec.Features[0].Name != "HotReload" || !cfg.Spec.Features[0].Enabled {
		t.Errorf("diagnostics features = %+v, want [HotReload enabled]", cfg.Spec.Features)
	}
	var res struct {
		Spec struct {
			Targets struct {
				Apps map[string]struct {
					CircuitBreaker string `json:"circuitBreaker"`
				} `json:"apps"`
			} `json:"targets"`
		} `json:"spec"`
	}
	decode(t, "resiliency.yaml", &res)
	if cb := res.Spec.Targets.Apps["engineering"].CircuitBreaker; cb != "subspaceBreaker" {
		t.Errorf("engineering circuitBreaker = %q, want subspaceBreaker", cb)
	}
	if _, ok := res.Spec.Targets.Apps["sickbay"]; !ok {
		t.Error("resiliency has no sickbay app target")
	}
	if cb := res.Spec.Targets.Apps["sickbay"].CircuitBreaker; cb != "" {
		t.Errorf("sickbay circuitBreaker = %q, want none (cold start trips it)", cb)
	}

	eps := list(t, resources.KindHTTPEndpoint)
	if len(eps) != 1 || eps[0].Name != "starfleet-command" || eps[0].HTTPEndpoint == nil {
		t.Fatalf("httpendpoints = %+v", eps)
	}
	if got := eps[0].HTTPEndpoint.BaseURL; got != "http://localhost:6003/starfleet" {
		t.Errorf("baseUrl = %q", got)
	}
	var sawRef, sawShip bool
	for _, h := range eps[0].HTTPEndpoint.Headers {
		if h.Name == "X-Starfleet-Api-Key" && h.SecretKeyRef != nil &&
			// local.file secret stores expose each top-level key as its own secret,
			// so the secret name (not the store name) is the key in secrets.json;
			// the store comes from auth.secretStore.
			h.SecretKeyRef.Name == "starfleet-api-key" && h.SecretKeyRef.Key == "starfleet-api-key" {
			sawRef = true
		}
		if h.Name == "X-Ship" && h.Value == "Enterprise" {
			sawShip = true
		}
	}
	if !sawRef || !sawShip {
		t.Errorf("headers = %+v", eps[0].HTTPEndpoint.Headers)
	}

	// Subscription is not covered by the loader; decode directly.
	raw, err = os.ReadFile(filepath.Join("resources", "red-alert-sub.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var sub struct {
		Kind     string `json:"kind"`
		Metadata struct {
			Name string `json:"name"`
		} `json:"metadata"`
		Spec struct {
			Topic  string `json:"topic"`
			Routes struct {
				Default string `json:"default"`
			} `json:"routes"`
			Pubsubname string `json:"pubsubname"`
		} `json:"spec"`
		Scopes []string `json:"scopes"`
	}
	if err := yaml.Unmarshal(raw, &sub); err != nil {
		t.Fatal(err)
	}
	if sub.Kind != "Subscription" || sub.Metadata.Name != "red-alert-sub" ||
		sub.Spec.Topic != "red-alert" || sub.Spec.Routes.Default != "/alerts" ||
		sub.Spec.Pubsubname != "pubsub" || !reflect.DeepEqual(sub.Scopes, []string{"sickbay"}) {
		t.Errorf("subscription = %+v", sub)
	}

	// Secrets file carries both keys.
	sraw, err := os.ReadFile("secrets.json")
	if err != nil {
		t.Fatal(err)
	}
	var secrets map[string]string
	if err := yaml.Unmarshal(sraw, &secrets); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"warp-override-code", "starfleet-api-key"} {
		if secrets[k] == "" {
			t.Errorf("secrets.json missing %q", k)
		}
	}
}
