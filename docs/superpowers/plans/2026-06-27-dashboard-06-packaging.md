# Dev Dashboard — Plan 6: Packaging (GoReleaser + Install Scripts + README)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the dashboard as cross-platform GitHub Release binaries built by GoReleaser, installable via a one-line script (curl|sh / iwr|iex) or `go install`, with the README documenting install + the base-path build coupling.

**Architecture:** A `.goreleaser.yaml` builds the matrix (Win/macOS/Linux × amd64/arm64): a `before` hook builds the embedded React SPA first (so `//go:embed all:dist` captures the real UI), and version metadata is injected via `-ldflags -X .../pkg/version.*`. A tag-push GitHub Actions workflow runs GoReleaser (archives + `checksums.txt`, published to a GitHub Release). Because `go install` cannot run npm, a `scripts/release.sh` helper creates the version tag on a **detached commit that embeds the freshly-built `web/dist`** (force-added past `.gitignore`), so `go install …@<tag>` also gets the full UI while `main` stays asset-free. POSIX `scripts/install.sh` + PowerShell `scripts/install.ps1` detect OS/arch, download the right archive from the latest GitHub Release, and install to `~/.local/bin` (no sudo). A new `--version` CLI flag lets users/scripts verify the build.

**Tech Stack:** (builds on Plans 1–5) Go + cobra · GoReleaser v2 · GitHub Actions · POSIX sh + PowerShell · `//go:embed`. No new Go runtime dependencies.

**Builds on Plans 1–5 (all merged, `main` @ `aaac383`).** Real facts this plan consumes:
- `pkg/version`: `var (Version="dev"; Commit="none"; Date="unknown")` are `-ldflags -X`-overridable; `version.Get() Info{Version,Commit,Date}`; served at `/api/version`.
- `cmd/`: cobra root built by `NewRootCmd()`; `Execute()` (signal-cancelled ctx). Flags `--port`(9090)/`--base-path`/`--no-open`/`--statestore`/`--namespace`. `main.go` calls `cmd.Execute()`.
- `web/embed.go`: `//go:embed all:dist` → `DistFS()`; only `web/dist/index.html` is a committed placeholder, `web/dist/assets/` is gitignored; `make web` (`cd web && npm install && npm run build`) populates it.
- `web/vite.config.ts`: `base: process.env.DASH_BASE_PATH || '/'` (baked at build time).
- `Makefile`: `web`, `build` (= `web` then `go build -o bin/dev-dashboard .`), `test-go`/`test-web`/`test`, `tidy`.
- `.github/workflows/ci.yaml`: existing CI (go + web jobs). Module `github.com/diagridio/dev-dashboard`; GitHub repo `diagridio/dev-dashboard`. Go 1.26.x, Node 20.
- `README.md`: has placeholder install section with `<release-install-script-url>` / `<module-path>` to fill in.

## Global Constraints

(Inherited from Plans 1–5 — single binary, no Node at runtime, testify + `//go:build unit`, `gofmt -l` empty, `go vet -tags unit`, never commit `web/dist/assets` **to main** — see Plan-6 exception below, commit messages end with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.) Plan-6-specific (from spec §2 Distribution + user decisions):

- **Distribution = GoReleaser binaries** for **Win/macOS/Linux × amd64/arm64** on **GitHub Releases**. One-line install scripts (`curl | sh`, `iwr | iex`). `go install` must work. **Homebrew/Scoop/winget are deferred** — do NOT add them. **No code signing / notarization** (deferred) — checksums only.
- **Version injection:** GoReleaser sets `-ldflags -X github.com/diagridio/dev-dashboard/pkg/version.{Version,Commit,Date}=…`. Released `dev-dashboard --version` must print the tag version (not `dev`).
- **The SPA must be built BEFORE the Go binary** (the binary embeds `web/dist`). GoReleaser's `before.hooks` builds it; the release-tag flow also commits it.
- **`go install` UI (user decision):** built `web/dist` assets ARE committed on the **release tag commit only** (force-added past `.gitignore`), so `go install …@<tag>` embeds the real UI. `main` must stay free of built assets — the release commit is reachable only via the tag, created on a detached HEAD. The `.gitignore` rule for `web/dist/assets/` stays; only `scripts/release.sh` force-adds.
- **Install target (user decision):** `~/.local/bin` (POSIX) / `%LOCALAPPDATA%\Programs\dev-dashboard` (Windows). **No sudo.** Warn (don't fail) if the dir isn't on `PATH`, printing the export line.
- **Release trigger (user decision):** pushing a `v*` git tag runs the release workflow → archives + `checksums.txt` → GitHub Release. No signing.
- **Base-path coupling (spec §9.1, README):** the SPA's `base` is baked at build time from `DASH_BASE_PATH`, which MUST match the server's `--base-path`. Released binaries are built root-mounted (`/`); a non-root mount requires building from source with `DASH_BASE_PATH` set. Document this.
- **Archive naming:** `dev-dashboard_{Version}_{Os}_{Arch}.{tar.gz|zip}` (zip for Windows). Install scripts and README depend on this exact pattern.

## File Structure

```
cmd/
  root.go            # MODIFY: add --version flag (+ wire version.Get())
  root_test.go       # MODIFY: assert --version prints the version string
.goreleaser.yaml     # GoReleaser v2 config (build matrix, ldflags, archives, checksums)
.github/workflows/
  release.yaml       # tag-push → GoReleaser release job
scripts/
  release.sh         # build SPA + detached commit embedding web/dist + tag (for go install)
  install.sh         # POSIX one-line installer (detect os/arch, download, install to ~/.local/bin)
  install.ps1        # PowerShell one-line installer (Windows)
Makefile             # MODIFY: release-snapshot + release targets; help
README.md            # MODIFY: real install one-liners, go install, base-path coupling note
.gitignore           # (unchanged; release.sh force-adds web/dist at tag time)
```

---

### Task 1: `--version` CLI flag

**Files:** Modify `cmd/root.go`, `cmd/root_test.go`

**Interfaces — Consumes:** `version.Get() version.Info` (already exists). **Produces:** `dev-dashboard --version` prints `dev-dashboard {Version} (commit {Commit}, built {Date})\n` and exits 0 without starting the server.

- [ ] **Step 1: Write the failing test** (`cmd/root_test.go`, `//go:build unit`) — execute the command with `--version` and assert the output contains the version. cobra's `Version` field + `SetArgs` + captured output:
```go
func TestVersionFlag(t *testing.T) {
	c := NewRootCmd()
	var buf bytes.Buffer
	c.SetOut(&buf)
	c.SetArgs([]string{"--version"})
	require.NoError(t, c.Execute())
	out := buf.String()
	require.Contains(t, out, version.Get().Version)
	require.Contains(t, out, "dev-dashboard")
}
```
(add imports `bytes`, and `github.com/diagridio/dev-dashboard/pkg/version` if not already imported in the test file.)
- [ ] **Step 2: Run → fail.** `go test -tags unit ./cmd/ -run TestVersionFlag -v` → FAIL (no version output / flag).
- [ ] **Step 3: Implement** — in `NewRootCmd()`, set cobra's built-in version support on the `&cobra.Command{…}`:
```go
	info := version.Get()
	c := &cobra.Command{
		Use:           "dev-dashboard",
		Short:         "Local dashboard for Dapr apps, workflows, and sidecars",
		Version:       info.Version,
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runServe(cmd.Context(), port, basePath, noOpen, stateStore, namespace)
		},
	}
	c.SetVersionTemplate(fmt.Sprintf("dev-dashboard {{.Version}} (commit %s, built %s)\n", info.Commit, info.Date))
```
(ensure `fmt` + the `version` import are present in `cmd/root.go`; `version` is already imported there for `version.Get()` in `runServe`.)
- [ ] **Step 4: Run → pass.** `go test -tags unit ./cmd/ -v`
- [ ] **Step 5: Manual check.** `go run . --version` prints `dev-dashboard dev (commit none, built unknown)`; `go run . --no-open` still serves. Stop.
- [ ] **Step 6: Commit.** `gofmt -w cmd && git add cmd/root.go cmd/root_test.go && git commit -m "feat(cmd): --version flag"`

---

### Task 2: GoReleaser config + snapshot build

**Files:** Create `.goreleaser.yaml`; **modify** `Makefile`.

**Interfaces — Produces:** a GoReleaser v2 config that (a) builds the SPA in `before.hooks`, (b) compiles the 6-target matrix with version ldflags, (c) archives as `dev-dashboard_{Version}_{Os}_{Arch}` (tar.gz; zip on Windows), (d) emits `checksums.txt`. `make release-snapshot` runs a local snapshot build into `dist/`.

- [ ] **Step 1: Create `.goreleaser.yaml`:**
```yaml
version: 2
project_name: dev-dashboard

before:
  hooks:
    - go mod tidy
    - sh -c "cd web && npm ci && npm run build"

builds:
  - id: dev-dashboard
    main: .
    binary: dev-dashboard
    env:
      - CGO_ENABLED=0
    goos: [linux, darwin, windows]
    goarch: [amd64, arm64]
    ldflags:
      - -s -w
      - -X github.com/diagridio/dev-dashboard/pkg/version.Version={{ .Version }}
      - -X github.com/diagridio/dev-dashboard/pkg/version.Commit={{ .Commit }}
      - -X github.com/diagridio/dev-dashboard/pkg/version.Date={{ .Date }}

archives:
  - id: default
    formats: [tar.gz]
    format_overrides:
      - goos: windows
        formats: [zip]
    name_template: "{{ .ProjectName }}_{{ .Version }}_{{ .Os }}_{{ .Arch }}"

checksum:
  name_template: "checksums.txt"

snapshot:
  version_template: "{{ incpatch .Version }}-snapshot"

release:
  github:
    owner: diagridio
    name: dev-dashboard
  draft: false
  prerelease: auto

changelog:
  use: github
```
> **Version-sensitivity (flagged, not a placeholder):** GoReleaser v2 renamed some keys across minor versions — `archives.formats` (was `format`/`formats` list) and `snapshot.version_template` (was `name_template`). The implementer MUST run `goreleaser check` (next step) and reconcile any deprecation/error against the **installed** GoReleaser version (e.g. if it demands `format:` singular, switch; if `version_template` is rejected, use `name_template`). This is the package-manager equivalent of the `go doc` checks in earlier plans.
- [ ] **Step 2: Validate the config.** Run `goreleaser check` (install if missing: `go install github.com/goreleaser/goreleaser/v2@latest`, ensure `$(go env GOPATH)/bin` on PATH). Expected: `config is valid`. Fix any key the installed version rejects (per the note above) until it passes.
- [ ] **Step 3: Snapshot build.** `goreleaser release --snapshot --clean --skip=publish`. Expected: `dist/` contains `dev-dashboard_*_linux_amd64.tar.gz`, `…_windows_amd64.zip`, …, and `checksums.txt`. Extract one Linux archive and run the binary with `--version` → it prints a `…-snapshot` version (NOT `dev`), proving ldflags injection. Then verify the embedded UI is the real build (the snapshot before-hook ran `npm run build`): `./<extracted>/dev-dashboard --no-open --port 9094 &` then `curl -s localhost:9094/ | grep -qi '<div id="root"'` and `curl -s localhost:9094/api/version` shows the snapshot version; kill it.
- [ ] **Step 4: Add Makefile targets** (append; keep `.PHONY` updated):
```makefile
release-snapshot:
	goreleaser release --snapshot --clean --skip=publish

release-check:
	goreleaser check
```
(add `release-snapshot release-check` to the `.PHONY` line.)
- [ ] **Step 5: Commit.** `git add .goreleaser.yaml Makefile && git commit -m "build: GoReleaser config + snapshot make targets"`
> Do NOT `git add dist/` — it's GoReleaser's output dir. Add `dist/` to `.gitignore` if not already covered (the repo ignores `/bin/` + `web/dist/assets/`; add a top-level `/dist/` line in this commit).

---

### Task 3: Release workflow (tag-push → GoReleaser)

**Files:** Create `.github/workflows/release.yaml`

**Interfaces — Produces:** a workflow that, on a pushed `v*` tag, builds the SPA + runs GoReleaser to publish a GitHub Release with archives + checksums.

- [ ] **Step 1: Create `.github/workflows/release.yaml`:**
```yaml
name: release
on:
  push:
    tags: ['v*']
permissions:
  contents: write
jobs:
  goreleaser:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-go@v5
        with:
          go-version: '1.26.3'
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - uses: goreleaser/goreleaser-action@v6
        with:
          distribution: goreleaser
          version: '~> v2'
          args: release --clean
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```
> `fetch-depth: 0` is required so GoReleaser can read tags/changelog. `GITHUB_TOKEN` is auto-provided; `contents: write` lets it publish the Release. The `before.hooks` (npm build) run inside the action because Node is set up above.
- [ ] **Step 2: Validate the YAML.** `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yaml')); print('ok')"` → `ok`. (CI itself can't be run locally; this only confirms well-formedness.)
- [ ] **Step 3: Commit.** `git add .github/workflows/release.yaml && git commit -m "ci: tag-push GoReleaser release workflow"`

---

### Task 4: Release-tag script (commit built SPA for `go install`)

**Files:** Create `scripts/release.sh`

**Interfaces — Produces:** `scripts/release.sh vX.Y.Z` builds the SPA, creates a **detached** commit that embeds `web/dist` (force-added), tags it `vX.Y.Z`, and returns to the original branch — leaving the built assets reachable ONLY via the tag (so `go install …@vX.Y.Z` gets the full UI and `main` stays clean). It prints the `git push origin vX.Y.Z` the user runs to trigger the release.

- [ ] **Step 1: Create `scripts/release.sh`** (POSIX, `set -eu`):
```sh
#!/usr/bin/env sh
# Tag a release whose commit embeds the built SPA, so `go install ...@<tag>`
# ships the full UI. The asset-bearing commit is created on a detached HEAD and
# is reachable only via the tag — `main` stays free of built assets.
#
# Usage: scripts/release.sh vX.Y.Z
set -eu

VERSION="${1:-}"
case "$VERSION" in
  v[0-9]*) : ;;
  *) echo "usage: scripts/release.sh vX.Y.Z (got '${VERSION}')" >&2; exit 2 ;;
esac

if [ -n "$(git status --porcelain)" ]; then
  echo "working tree not clean; commit or stash first" >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/$VERSION" >/dev/null; then
  echo "tag $VERSION already exists" >&2
  exit 1
fi

START_REF="$(git rev-parse --abbrev-ref HEAD)"
cleanup() {
  # Always return to the original branch and drop built assets from the worktree.
  git checkout -q "$START_REF" 2>/dev/null || true
  git checkout -q -- web/dist 2>/dev/null || true
  rm -rf web/dist/assets 2>/dev/null || true
}
trap cleanup EXIT

echo "building SPA…"
( cd web && npm ci && npm run build )

echo "creating detached release commit…"
git checkout -q --detach
git add -f web/dist
git commit -q -m "release $VERSION (embed built SPA for go install)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git tag -a "$VERSION" -m "$VERSION"

echo "tagged $VERSION at $(git rev-parse --short HEAD) (detached; main untouched)"
echo "push it to trigger the release:  git push origin $VERSION"
```
- [ ] **Step 2: `chmod +x scripts/release.sh`** and **shellcheck**: `shellcheck scripts/release.sh` → no errors (install shellcheck if needed: `brew install shellcheck`; if unavailable, run `sh -n scripts/release.sh` to at least syntax-check and note shellcheck was skipped).
- [ ] **Step 3: Argument-validation check (no side effects).** `sh scripts/release.sh` (no arg) → exits 2 with the usage message; `sh scripts/release.sh 1.2.3` (no `v`) → exits 2. (Do NOT run it with a valid version here — that would build + tag.)
- [ ] **Step 4: Commit.** `git add scripts/release.sh && git commit -m "build: release.sh — tag with embedded SPA for go install"`

---

### Task 5: Install scripts (POSIX + PowerShell)

**Files:** Create `scripts/install.sh`, `scripts/install.ps1`

**Interfaces — Produces:** `scripts/install.sh` downloads the latest (or `$VERSION`) GitHub Release archive for the host OS/arch and installs `dev-dashboard` to `~/.local/bin`; `install.ps1` does the Windows equivalent to `%LOCALAPPDATA%\Programs\dev-dashboard`. Both warn if the target dir isn't on PATH. Archive name pattern: `dev-dashboard_{version-no-v}_{os}_{arch}.{tar.gz|zip}`.

- [ ] **Step 1: Create `scripts/install.sh`** (POSIX, `set -eu`; `DRY_RUN=1` prints the resolved URL without downloading — used for testing):
```sh
#!/usr/bin/env sh
# Install dev-dashboard to ~/.local/bin (no sudo).
#   curl -sSL https://raw.githubusercontent.com/diagridio/dev-dashboard/main/scripts/install.sh | sh
# Env: VERSION=vX.Y.Z (default: latest), BIN_DIR (default: ~/.local/bin), DRY_RUN=1
set -eu

REPO="diagridio/dev-dashboard"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

os="$(uname -s)"; arch="$(uname -m)"
case "$os" in
  Linux) os="linux" ;;
  Darwin) os="darwin" ;;
  *) echo "unsupported OS: $os (use scripts/install.ps1 on Windows)" >&2; exit 1 ;;
esac
case "$arch" in
  x86_64|amd64) arch="amd64" ;;
  aarch64|arm64) arch="arm64" ;;
  *) echo "unsupported arch: $arch" >&2; exit 1 ;;
esac

VERSION="${VERSION:-}"
if [ -z "$VERSION" ]; then
  VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | grep '"tag_name"' | head -n1 | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
fi
[ -n "$VERSION" ] || { echo "could not resolve latest version" >&2; exit 1; }

num="${VERSION#v}"
file="dev-dashboard_${num}_${os}_${arch}.tar.gz"
url="https://github.com/$REPO/releases/download/$VERSION/$file"

if [ "${DRY_RUN:-}" = "1" ]; then
  echo "$url"
  exit 0
fi

echo "downloading $file …"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$url" -o "$tmp/$file"
tar -xzf "$tmp/$file" -C "$tmp"
mkdir -p "$BIN_DIR"
install -m 0755 "$tmp/dev-dashboard" "$BIN_DIR/dev-dashboard"
echo "installed dev-dashboard $VERSION → $BIN_DIR/dev-dashboard"

case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) echo "note: $BIN_DIR is not on your PATH. Add it:"; echo "  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
```
- [ ] **Step 2: Create `scripts/install.ps1`:**
```powershell
# Install dev-dashboard to %LOCALAPPDATA%\Programs\dev-dashboard (no admin).
#   iwr -useb https://raw.githubusercontent.com/diagridio/dev-dashboard/main/scripts/install.ps1 | iex
# Env: $env:VERSION = 'vX.Y.Z' (default latest); $env:DRY_RUN = '1'
$ErrorActionPreference = 'Stop'
$repo = 'diagridio/dev-dashboard'
$binDir = Join-Path $env:LOCALAPPDATA 'Programs\dev-dashboard'

$arch = if ([Environment]::Is64BitOperatingSystem) { 'amd64' } else { 'arm64' }
if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $arch = 'arm64' }

$version = $env:VERSION
if (-not $version) {
  $rel = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest"
  $version = $rel.tag_name
}
$num = $version.TrimStart('v')
$file = "dev-dashboard_${num}_windows_${arch}.zip"
$url = "https://github.com/$repo/releases/download/$version/$file"

if ($env:DRY_RUN -eq '1') { Write-Output $url; exit 0 }

Write-Host "downloading $file …"
$tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ([guid]::NewGuid()))
Invoke-WebRequest $url -OutFile (Join-Path $tmp $file)
Expand-Archive -Path (Join-Path $tmp $file) -DestinationPath $tmp -Force
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
Copy-Item (Join-Path $tmp 'dev-dashboard.exe') (Join-Path $binDir 'dev-dashboard.exe') -Force
Write-Host "installed dev-dashboard $version -> $binDir\dev-dashboard.exe"

if (($env:PATH -split ';') -notcontains $binDir) {
  Write-Host "note: $binDir is not on your PATH. Add it (user scope):"
  Write-Host "  setx PATH `"$binDir;`$env:PATH`""
}
```
- [ ] **Step 3: `chmod +x scripts/install.sh`; shellcheck + dry-run.** `shellcheck scripts/install.sh` → clean (or `sh -n` if shellcheck unavailable, noting the skip). Then `DRY_RUN=1 VERSION=v1.2.3 sh scripts/install.sh` → prints `https://github.com/diagridio/dev-dashboard/releases/download/v1.2.3/dev-dashboard_1.2.3_<os>_<arch>.tar.gz` matching the host OS/arch (confirm the `v`-stripping in the filename + the os/arch mapping). For PowerShell, if `pwsh` is available run `DRY_RUN=1 VERSION=v1.2.3 pwsh -File scripts/install.ps1` and confirm the `…_windows_<arch>.zip` URL; otherwise note it's unverified locally.
- [ ] **Step 4: Commit.** `git add scripts/install.sh scripts/install.ps1 && git commit -m "build: one-line install scripts (curl|sh, iwr|iex)"`

---

### Task 6: README — install + base-path coupling

**Files:** Modify `README.md`

**Interfaces — Produces:** the README's install section filled with the real one-liners + `go install` + a clear base-path build-coupling note. No code.

- [ ] **Step 1: Replace the placeholder install block** (the `## User instructions (download, install, run)` section's `<release-install-script-url>` / `<module-path>` placeholders) with the real commands:
```markdown
## Install

**One-line install** (downloads the latest GitHub Release binary to `~/.local/bin`, no sudo):

macOS / Linux:
\`\`\`sh
curl -sSL https://raw.githubusercontent.com/diagridio/dev-dashboard/main/scripts/install.sh | sh
\`\`\`

Windows (PowerShell):
\`\`\`powershell
iwr -useb https://raw.githubusercontent.com/diagridio/dev-dashboard/main/scripts/install.ps1 | iex
\`\`\`

Pin a version with `VERSION=vX.Y.Z` (sh) or `$env:VERSION='vX.Y.Z'` (PowerShell). If the install
dir isn't on your `PATH`, the script prints the line to add.

**With Go** (≥ 1.26):
\`\`\`sh
go install github.com/diagridio/dev-dashboard@latest
\`\`\`
Use a tagged version (`@vX.Y.Z`) — release tags embed the prebuilt UI so `go install` ships the full
dashboard; `@latest` may resolve to `main`, which carries only a placeholder UI.

**Manual:** download the archive for your OS/arch from
[Releases](https://github.com/diagridio/dev-dashboard/releases), extract, and put `dev-dashboard`
on your `PATH`. Verify with `dev-dashboard --version`.

Run it:
\`\`\`sh
dev-dashboard            # serves http://localhost:9090 and opens your browser
dev-dashboard --no-open  # don't open a browser
dev-dashboard --port 8080
\`\`\`
```
(Use real backticks in the file — the `\`\`\`` above are escaped for this plan only.)
- [ ] **Step 2: Add a base-path note** under the install/run section (or near the Architecture section that already mentions base-path):
```markdown
### Mounting under a sub-path

The server is base-path-aware (`--base-path /dashboard`), but the embedded SPA bakes its asset base
URL at **build time** from `DASH_BASE_PATH`. The released binaries are built for a root mount (`/`),
so `--base-path` on a release binary will not load assets correctly. To run under a sub-path, build
from source with a matching `DASH_BASE_PATH`:

\`\`\`sh
DASH_BASE_PATH=/dashboard/ make build
./bin/dev-dashboard --base-path /dashboard
\`\`\`
(`DASH_BASE_PATH` must equal the `--base-path` value, with a trailing slash.)
```
- [ ] **Step 3: Verify the doc commands are accurate** — confirm the install URLs match the script paths committed in Task 5, the `go install` module path matches `go.mod`, and `make build` + `DASH_BASE_PATH` match `Makefile`/`vite.config.ts`. (Read-through; no execution required beyond `dev-dashboard --version` which Task 1 added.)
- [ ] **Step 4: Commit.** `git add README.md && git commit -m "docs: real install instructions + base-path build note"`

---

## Self-Review

**Spec coverage (Plan 6 scope, spec §2 Distribution):**
- GoReleaser binaries Win/macOS/Linux × amd64/arm64 on GitHub Releases → Task 2 (matrix) + Task 3 (publish). ✓
- One-line install scripts (`curl|sh` / `iwr|iex`) → Task 5. ✓
- `go install` works (with full UI via tag-embedded assets, per user decision) → Task 4 (release.sh commits `web/dist` on the tag) + Task 6 (documented). ✓
- Homebrew/Scoop/winget **deferred** → intentionally omitted. ✓
- No signing/notarization → checksums only (Task 2). ✓
- README base-path coupling note (Plan-1 follow-up, §9.1) → Task 6 Step 2. ✓
- Version injection verifiable → Task 1 (`--version`) + Task 2 Step 3 (snapshot proves ldflags). ✓
- **Plan-1 follow-up cleared:** the README base-path note (the last open Plan-1 item) lands here.

**Placeholder scan:** No hidden TODOs. The one judgment point — GoReleaser v2 key names (`formats`/`format`, `version_template`/`name_template`) varying by installed version — is explicitly flagged in Task 2 with `goreleaser check` as the reconciliation step (same pattern as the `go doc` checks in Plans 3–4). Packaging artifacts (YAML/scripts) are config, so verification is via real tooling (`goreleaser check`, snapshot build, `shellcheck`, `DRY_RUN`) rather than Go unit tests — except Task 1, which is a genuine TDD Go change. Each task ends with a concrete, runnable verification.

**Type/contract consistency:** The archive name template `dev-dashboard_{Version}_{Os}_{Arch}` (Task 2) is consumed verbatim by `install.sh`/`install.ps1` (Task 5: `dev-dashboard_${num}_${os}_${arch}.{tar.gz|zip}`, with `num` = version sans leading `v`) and referenced in the README (Task 6). The binary name `dev-dashboard` (+`.exe` on Windows), the repo `diagridio/dev-dashboard`, the module `github.com/diagridio/dev-dashboard`, and the ldflags var path `…/pkg/version.{Version,Commit,Date}` are identical across Tasks 1–6. `DASH_BASE_PATH` (Task 6) matches `web/vite.config.ts`. The release-tag flow (Task 4) force-adds `web/dist` consistent with the `//go:embed all:dist` in `web/embed.go`.

**Note for implementer:** Task 1 is pure TDD Go. Tasks 2–5 are packaging config verified with real tools — install GoReleaser v2 (`go install github.com/goreleaser/goreleaser/v2@latest`) and `shellcheck` if absent; reconcile any GoReleaser key deprecation against your installed version via `goreleaser check`. Never `git add web/dist/assets` on `main` — only `scripts/release.sh` does so, on a detached tag commit. Add `/dist/` to `.gitignore` (GoReleaser output). A real end-to-end release (pushing a `v*` tag) is a manual post-merge step the maintainer runs, not part of this plan's verification.
