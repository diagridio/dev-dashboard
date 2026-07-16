# Subscriptions page — developer experience

**Status:** Design approved, ready for implementation planning
**Date:** 2026-07-16

## Problem

The Subscriptions page is a static, read-only table sourced entirely from each
sidecar's `/v1.0/metadata` endpoint. It answers "what subscriptions exist?" but
does nothing to help a developer *exercise* them. There is no way to send a test
message to a topic, no runtime signal about message flow, and some of the static
config we already carry is either hidden (`type`) or shown as a permanently empty
column (`Scopes`).

Goal: make the page an interactive part of the dev loop, with the headline
capability being **publishing a test message to a topic**.

## Scope & phasing

Build order is **publish-first**. This spec covers Phase 1 and Phase 2 in full;
Phase 3 is sketched and will get its own spec later.

- **Phase 1 — Publish to topic** (headline feature)
- **Phase 2 — Static-insight quick-wins** (folded in alongside Phase 1)
- **Phase 3 — Metrics observability** (sketch only; separate spec)

## Background: how the page works today

- Data path: `pkg/discovery/metadata.go` (`FetchMetadata` → `/v1.0/metadata`) →
  `pkg/server/subscriptions.go` (`GET /api/subscriptions`) →
  `web/src/pages/Subscriptions.tsx` (`useSubscriptions`).
- Each subscription carries: `pubsubName`, `topic`, `rules` (match/path),
  `deadLetterTopic`, `type`. Backend `SubscriptionRow` also carries `Type`.
- The dashboard is read-only for *discovery*, but there is clear precedent for
  **mutations**: state-store CRUD (`POST/PUT/DELETE /api/statestores`) and app
  lifecycle start/stop/restart. Each `discovery.Instance` exposes a reachable
  daprd HTTP base URL (`DaprHTTPBaseURL`, falling back to `127.0.0.1:httpPort`)
  and a `SidecarReachable` flag.

Publishing through a subscribing app's **own** sidecar causes the message to loop
back into that same app (it is subscribed) — which is exactly the desired
"send a test message and watch my app handle it" behavior.

## Phase 1 — Publish to topic

### Backend

New endpoint mounted in `appsRouter` (publishing goes *through a specific
sidecar*, so it is instance-scoped alongside the existing lifecycle actions):

```
POST /api/apps/{instanceKey}/publish
```

Request body:

```json
{
  "pubsubName": "pubsub",
  "topic": "orders",
  "data": "<raw payload string>",
  "contentType": "application/json",
  "metadata": { "ttlInSeconds": "60", "rawPayload": "false" }
}
```

Handler behavior:

1. Resolve the instance by `instanceKey` from `discovery.Service`. If not found →
   404.
2. Require `SidecarReachable`. If the sidecar is unreachable → 503.
3. Validate `pubsubName` is a known pubsub component on that instance (present in
   the instance's `Components` as a `pubsub.*` type). Unknown → 400. `topic` is
   free-form (Dapr allows publishing to any topic); reject only empty topic.
4. Proxy to the sidecar:
   `POST {baseURL}/v1.0/publish/{pubsubName}/{topic}` with the request body as
   the raw payload, the `Content-Type` header set from `contentType` (default
   `application/json`), and each `metadata` entry passed as a `metadata.<key>`
   query parameter (e.g. `metadata.ttlInSeconds=60`, `metadata.rawPayload=true`).
5. Response mapping:
   - daprd `204 No Content` → success to the client.
   - daprd `4xx` (e.g. pubsub component not found, serialization error) →
     surface the daprd status + error body verbatim.
   - Network / dial failure to the sidecar → `502`.

Follows the existing `writeJSON` + sentinel-status conventions in
`pkg/server/api.go`. Content and validation errors are rejected before the proxy
call.

### Frontend

Each subscription row in `Subscriptions.tsx` gains a **Publish** action button:

- Disabled with an explanatory tooltip when the row's instance is not reachable
  (`SidecarReachable === false`).
- Clicking opens a **modal** (reusing the existing state-store modal pattern),
  pre-filled with the row's `pubsubName` and `topic`.

Modal contents:

- **Payload editor**: multiline monospace input with client-side JSON validation
  (validation applies when content-type is a JSON type; invalid JSON blocks
  submit with an inline message).
- **Content-type** select: default `application/json`, plus `text/plain` and a
  raw/binary option.
- **Advanced** (collapsed by default):
  - `ttlInSeconds` numeric field.
  - `rawPayload` toggle (sends `metadata.rawPayload=true`, bypassing CloudEvent
    wrapping).
  - Room for arbitrary additional `metadata` key/value rows.
- **Publish** button. No secondary confirm dialog — the modal is the deliberate
  action (consistent with lifecycle start/stop). Copy clearly states this
  publishes to a real broker.

Feedback:

- **Success (204)**: inline success — "Published to `<topic>`" — plus a link to
  that app's Logs page so the developer can watch the message get handled
  (it loops back to the subscriber).
- **Failure**: render the exact error returned by daprd (status + message).

### Guardrails

Publishing is **on by default** for any discovered, reachable subscription, with
no opt-in flag and no extra confirm dialog. Rationale: the dashboard is a
localhost dev tool, lifecycle mutations already work this way, and the modal
itself is a deliberate step. Copy makes clear it is a real publish.

## Phase 2 — Static-insight quick-wins

Folded in alongside Phase 1 (same page, same test file):

1. **Add a `Type` column** (declarative / programmatic / streaming). The data
   already reaches the frontend (`SubscriptionRow.Type` → `Subscription.type`);
   it is simply not rendered today.
2. **Remove the dead `Scopes` column.** Scopes are a *component* scoping
   property, not a subscription property, so the backend never populates it and
   the column always renders "—". Removing it avoids implying data we do not
   have. (The frontend `Subscription.scopes` field can be dropped too.)
3. **Inline rule inspection.** Replace the current "open a row in the real app to
   inspect match expressions" hint with an expandable detail row that shows each
   routing rule's `match` expression and `path`, since `rules` is already
   carried end to end.

## Phase 3 — Metrics observability (sketch only)

Not part of this spec's implementation; captured here so the design intent is on
record. A future spec would add per-topic publish/deliver/fail counts from
daprd's Prometheus metrics endpoint
(`dapr_component_pubsub_egress_count`, `dapr_component_pubsub_ingress_count`).
This requires:

- Metrics-port discovery — daprd's metrics port is not in `/v1.0/metadata`; it
  would be parsed from the daprd command line (`--metrics-port`), which the CLI
  often randomizes.
- A new scraper/poller data path (the dashboard scrapes no metrics today) plus
  UI (counts as columns or a small sparkline).

This is a meaningfully larger, separate change and is deferred.

## Testing

### Backend (`pkg/server/`)

Table-driven handler tests (mirroring `subscriptions_test.go`) using an
`httptest` fake sidecar:

- Validation failures: unknown instance (404), unreachable sidecar (503),
  unknown/empty pubsub or empty topic (400).
- Successful proxy: correct URL, `Content-Type` header, and `metadata.*` query
  params reach the fake sidecar; 204 maps to success.
- daprd error passthrough: a 4xx from the fake sidecar is surfaced verbatim.
- Network failure to the sidecar maps to 502.

### Frontend (`web/src/pages/Subscriptions.test.tsx`)

- Publish button renders per row; disabled with tooltip when unreachable.
- Modal opens pre-filled with the row's pubsub + topic.
- Payload JSON validation blocks submit on invalid JSON.
- Publish call is made with the expected body; success renders the confirmation
  + logs link; error renders the daprd message.
- New `Type` column renders the subscription type.
- `Scopes` column is gone.
- Rules expansion shows match/path for multi-rule subscriptions.

## Out of scope

- Delivery confirmation (polling metrics/logs to prove the app received the
  message) — async and app-dependent; the logs link is the pragmatic substitute.
- CloudEvent field overrides (id/type/source) — beyond a dev-loop tool's needs.
- Phase 3 metrics implementation (separate spec).
