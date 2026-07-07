# Resiliency Builder Enhancements — Design

**Date:** 2026-07-02
**Branch:** `feat/component-resiliency-builders`
**Builds on:** `docs/superpowers/specs/2026-06-28-component-resiliency-builders-design.md` and the shipped Resiliency Builder (`web/src/pages/resiliency-builder/*`).

## Goal

Four enhancements to the existing 3-step Resiliency Builder (General → Policies → Targets → YAML preview):

1. Default the namespace to `default`.
2. Show default values as real, editable text in the dialogs (not just placeholders).
3. Make policy **and** target chips editable by clicking the chip.
4. Bring back the original "override default Dapr policies" feature (the reserved `DaprBuiltIn*` retry policies).

These are additive; the data model (`types/resiliency.ts`) and reducer actions are sufficient as-is except where noted.

## Non-goals (YAGNI)

- The read-only "default policy overrides" **table** on the Targets step (the original `DefaultPolicyOverridesContainer`). Redundant — overrides live on the Policies step here.
- The connected-mode cluster/namespace/scope pickers (`ResiliencyAccess`). Still dropped, as in v1.

---

## 1. Namespace defaults to `default`

- `defaultResiliencyConfig()` in `web/src/types/resiliency.ts` initializes `metadata.namespace = 'default'` (was `''`).
- `StepGeneral` already binds the Namespace input to `state.config.metadata.namespace`, so the field renders `default` as real text with no component change.
- **Emission:** `assembleResiliency` keeps its existing rule — emit `metadata.namespace` only when the trimmed value is non-empty. With the new default, YAML includes `namespace: default`; if the user clears the field, `namespace` is omitted.
- **Tests:** update any reducer/assemble test that assumed an empty default namespace.

---

## 2. Real default values instead of placeholders

Initial field values sourced from the canonical `ResiliencyDefaults` presets. Placeholders remain (they now echo the default). Validation is unchanged.

| Dialog | Field | Default |
|---|---|---|
| Timeout | Duration | `5s` |
| Retry (custom) | Duration / Max interval / Max retries | `5s` / `60s` / `-1` *(already real — no change)* |
| Circuit breaker | Max requests | `1` |
| Circuit breaker | Timeout | `45s` |
| Circuit breaker | Trip (CEL) | `consecutiveFailures >= 5` |
| Circuit breaker | Interval | `8s` |

Affected file: `web/src/pages/resiliency-builder/policyDialogs.tsx` (change the `useState` initializers for `TimeoutDialog` duration and `CircuitBreakerDialog` maxRequests/timeout/trip/interval).

---

## 3. Editable chips — policies and targets

### NamedList

`web/src/pages/resiliency-builder/NamedList.tsx` gains an optional `onEdit(name)` callback:

- The chip **body** (currently `<b>{name}</b>`) becomes a clickable `<button>` that fires `onEdit(name)`.
- The ✕ remove button stays; its click handler calls `stopPropagation` so removing does not also trigger edit.
- When `onEdit` is not provided, the chip renders non-interactive (backward-compatible), though every caller in this change provides it.

### Dialogs gain edit mode

All six dialogs gain optional initial-value props and a mode-aware title:

- **Policy dialogs** (`policyDialogs.tsx`): `TimeoutDialog` → `initialName`, `initialDuration`; `RetryDialog` → `initialName`, `initialPolicy?: RetryPolicy`; `CircuitBreakerDialog` → `initialName`, `initialPolicy?: CircuitBreakerPolicy`.
- **Target dialogs** (`targetDialogs.tsx`): `AppTargetDialog`/`ActorTargetDialog`/`ComponentTargetDialog` → `initialName`, `initialTarget?`.
- Title reads **"Add …"** when there is no initial value, **"Edit …"** when editing.
- `ComponentTargetDialog` derives its **direction** from the initial target: both legs present → `both`; only `outbound` → `outbound`; only `inbound` → `inbound`.
- Dialogs continue to be remounted per open (existing pattern) so each open starts from the correct initial state.

### Steps wire onEdit

- `StepPolicies` and `StepTargets` track an "editing" name alongside the existing open-dialog state, and pass the existing policy/target as the dialog's initial value.
- **Rename during edit** is allowed for all custom policies and all targets. If the saved name differs from the name being edited, the step dispatches `REMOVE_<old>` followed by `UPSERT_<new>`; otherwise a single `UPSERT_<name>`. This reuses the existing reducer actions — no reducer or type changes.
- `DaprBuiltIn*` override names are **locked** in edit mode (see §4).

---

## 4. Default policy overrides (`DaprBuiltIn*` retries)

### Preset data

New `web/src/pages/resiliency-builder/defaultPolicies.ts` exporting `DEFAULT_DAPR_RETRY_POLICIES`:

| Label | policy | duration | maxInterval | maxRetries |
|---|---|---|---|---|
| `DaprBuiltInServiceRetries` | constant | `1s` | — | `3` |
| `DaprBuiltInActorRetries` | constant | `1s` | — | `3` |
| `DaprBuiltInActorReminderRetries` | exponential | `15m` | `60s` | `3` |
| `DaprBuiltInInitializationRetries` | exponential | `10s` | `500ms` | `3` |

Also export a helper `isDefaultPolicyName(name): boolean` (`name.startsWith('DaprBuiltIn')`).

### Policies step — new "Default policy overrides" section

Rendered below the three existing policy lists in `StepPolicies`:

- A section header "Default policy overrides" with a collapsible info note and a warning line ("These override Dapr's built-in retry behavior globally").
- One row per built-in policy. If not yet added, a **+ Add** action; if already added, the chip (editable/removable via §3).
- **Adding** opens `RetryDialog` with the name **locked** to the built-in label and all fields **prefilled** from the preset. Editing opens it prefilled from the current stored value, name still locked.
- Stored under their reserved keys in `spec.policies.retries` via the existing `UPSERT_RETRY` action.

### Retries list filters out built-ins

The regular "Retries" `NamedList` in `StepPolicies` filters keys with `isDefaultPolicyName`, so a built-in override appears only in the overrides section, never in both.

### Exponential preset nuance

Dapr exponential retries use both `duration` (initial interval) and `maxInterval` (cap). The standard `RetryDialog` only edits `maxInterval` for exponential and drops `duration` on save. For the override flow, the preset's `duration` must be **preserved** through save so the emitted override matches Dapr's real defaults (`ActorReminder` = `duration 15m` + `maxInterval 60s`; `Initialization` = `duration 10s` + `maxInterval 500ms`). Implementation preserves the carried `duration` when the policy type is unchanged; this is scoped to the override save path so the regular custom-retry flow is unaffected.

### Targets gating

`canContinue` for the Targets step (case 2 in `reducer.ts`) passes when there is **≥1 target of any type OR ≥1 `DaprBuiltIn*` retry override** present. This enables the common overrides-only resiliency config (overrides apply globally with no target reference).

---

## Files touched

- `web/src/types/resiliency.ts` — namespace default `'default'`.
- `web/src/pages/resiliency-builder/policyDialogs.tsx` — real defaults; edit-mode props + titles.
- `web/src/pages/resiliency-builder/targetDialogs.tsx` — edit-mode props + titles; component-direction derivation.
- `web/src/pages/resiliency-builder/NamedList.tsx` — `onEdit` + clickable chip body.
- `web/src/pages/resiliency-builder/StepPolicies.tsx` — edit wiring; overrides section; retries filter.
- `web/src/pages/resiliency-builder/StepTargets.tsx` — edit wiring.
- `web/src/pages/resiliency-builder/reducer.ts` — override-aware Targets gating.
- `web/src/pages/resiliency-builder/defaultPolicies.ts` — **new** preset data + helper.

## Testing (TDD)

- `reducer.test.ts` — namespace default; override-aware gating (overrides-only passes; empty fails).
- `policyDialogs.test.tsx` — real defaults present; edit mode prefills + rename; locked built-in name.
- `targetDialogs.test.tsx` — edit mode prefills + rename; component direction derivation.
- `steps.test.tsx` — overrides section rows/add/edit; retries list excludes built-ins; chip-click opens edit for policies and targets.
- `defaultPolicies.test.ts` — **new**; preset values and `isDefaultPolicyName`.
- `ResiliencyBuilder.test.tsx` — end-to-end override-only config reaches preview with `namespace: default` and the built-in key under `spec.policies.retries`.
- Run `npx tsc -b` before every commit (all `npm`/`npx` from `web/`).
