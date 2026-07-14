# Binary Rename to `diagrid-dev-dashboard` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the shipped binary from `dev-dashboard` to `diagrid-dev-dashboard` everywhere it matters — build outputs, release archives, self-update expectations, install scripts, CLI help — as an accepted breaking change for existing installs.

**Architecture:** This is a coordinated string rename across four layers that must stay in lockstep: goreleaser (archive + inner binary names), `pkg/selfupdate` (what the updater downloads and extracts), the install scripts (what they fetch and write), and the CLI/docs surface. The repo, Go module path, GHCR image names, and the `DEVDASHBOARD_*` env prefix are explicitly NOT renamed.

**Tech Stack:** Go (cobra, goreleaser v2), POSIX sh + PowerShell install scripts, Docker.

## Global Constraints

- New binary name is exactly `diagrid-dev-dashboard` (`diagrid-dev-dashboard.exe` on Windows).
- Release asset template becomes `diagrid-dev-dashboard_{version}_{os}_{arch}.tar.gz` (`.zip` on Windows) — goreleaser derives it from `project_name`, so `project_name` changes too.
- **MUST NOT change:** the repo / Go module path `github.com/diagridio/dev-dashboard` (incl. every `-X github.com/diagridio/dev-dashboard/...` ldflag), goreleaser `release.github.name: dev-dashboard` (that is the GitHub *repo* name), the GHCR image names `ghcr.io/diagridio/dev-dashboard*` (external consumers incl. the Aspire hosting integration), the `defaultRepo = "diagridio/dev-dashboard"` / `"diagridio/dev-dashboard"` repo strings in `pkg/selfupdate` and `cmd` (updatecheck), the `DEVDASHBOARD_*` env-var prefix, and the `diagrid.ws/dev-dashboard-*` marketing links in the web UI.
- Breaking change is accepted: NO compatibility shims for old updaters. Binaries ≤ the last old-named release will fail `update` with "release X not found"; the release notes of the first renamed release must say so and give the reinstall one-liners (Task 5 writes that snippet).
- Go tests run with `go test -tags unit -race ./...`; run `gofmt -w` on every touched Go file before committing.
- Reference inventory (verified 2026-07-14): the only files carrying the *binary/asset* name are `pkg/selfupdate/{asset,extract,replace,selfupdate,resolve}.go` (+ their tests), `cmd/{root,update,update_notice}.go`, `pkg/updatecheck/updatecheck.go` (doc comment), `.goreleaser.yaml`, `Dockerfile`, `Dockerfile.goreleaser`, `Makefile`, `scripts/install.sh`, `scripts/install.ps1`, `README.md`, `ARCHITECTURE.md`.

---

### Task 1: Self-update naming (`pkg/selfupdate`)

**Files:**
- Modify: `pkg/selfupdate/asset.go:10,19`
- Modify: `pkg/selfupdate/extract.go:13-22`
- Modify: `pkg/selfupdate/replace.go:17`
- Modify: `pkg/selfupdate/selfupdate.go:86`
- Modify: `pkg/selfupdate/resolve.go:1` (package doc comment)
- Test: `pkg/selfupdate/asset_test.go`, `extract_test.go`, `replace_test.go`, `selfupdate_integration_test.go`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `assetName(...)` returning `diagrid-dev-dashboard_{num}_{os}_{arch}.{ext}` and `binaryFileName(goos)` returning `diagrid-dev-dashboard[.exe]` — these must match Task 3's goreleaser output exactly.

- [ ] **Step 1: Update the test expectations first**

In `pkg/selfupdate/asset_test.go`, `extract_test.go`, `replace_test.go`, and `selfupdate_integration_test.go`, apply this exact mechanical substitution to every string literal (expected asset names, fixture archive entry names, temp-file prefixes):

- `dev-dashboard_` → `diagrid-dev-dashboard_`
- `"dev-dashboard"` → `"diagrid-dev-dashboard"`
- `"dev-dashboard.exe"` → `"diagrid-dev-dashboard.exe"`
- `.dev-dashboard-update-` → `.diagrid-dev-dashboard-update-`

Do NOT touch `diagridio/dev-dashboard` repo strings or `github.com/diagridio/dev-dashboard` import paths. Sanity-check with:

```bash
grep -rn "dev-dashboard" pkg/selfupdate/*_test.go | grep -v "diagrid-dev-dashboard" | grep -v "diagridio/dev-dashboard" | grep -v "github.com/diagridio"
```

Expected: no output (every remaining bare `dev-dashboard` is renamed or is a repo/module reference).

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test -tags unit -race ./pkg/selfupdate/`
Expected: FAIL — asset/extract tests now expect `diagrid-dev-dashboard*` while the implementation still produces `dev-dashboard*`.

- [ ] **Step 3: Rename in the implementation**

`pkg/selfupdate/asset.go` — comment and format string:

```go
//	diagrid-dev-dashboard_{num}_{os}_{arch}.tar.gz   (.zip on windows)
```

```go
	return fmt.Sprintf("diagrid-dev-dashboard_%s_%s_%s.%s", num, goos, goarch, ext)
```

`pkg/selfupdate/extract.go` — both returns and the two doc comments:

```go
// binaryFileName returns the name of the diagrid-dev-dashboard binary inside a release
```

```go
		return "diagrid-dev-dashboard.exe"
	}
	return "diagrid-dev-dashboard"
```

```go
// extractBinary pulls the diagrid-dev-dashboard binary bytes out of a release archive:
```

`pkg/selfupdate/replace.go:17`:

```go
	tmp, err := os.CreateTemp(dir, ".diagrid-dev-dashboard-update-*")
```

`pkg/selfupdate/selfupdate.go:86`:

```go
	fmt.Fprintf(u.Out, "downloading diagrid-dev-dashboard %s (%s/%s)…\n", target, u.GOOS, u.GOARCH)
```

`pkg/selfupdate/resolve.go:1`:

```go
// Package selfupdate updates the diagrid-dev-dashboard binary in place from GitHub Releases.
```

Leave `selfupdate.go`'s `const defaultRepo = "diagridio/dev-dashboard"` untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -tags unit -race ./pkg/selfupdate/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pkg/selfupdate/
git commit -m "feat(selfupdate)!: expect diagrid-dev-dashboard asset and binary names"
```

---

### Task 2: CLI surface strings (`cmd/`, `pkg/updatecheck`)

**Files:**
- Modify: `cmd/root.go:1,49,67`
- Modify: `cmd/update.go:13-15`
- Modify: `cmd/update_notice.go:28`
- Modify: `pkg/updatecheck/updatecheck.go:1` (doc comment)
- Test: existing `cmd/` suites (some assert usage/notice text)

**Interfaces:**
- Consumes: nothing.
- Produces: `--version` output starts with `diagrid-dev-dashboard`; cobra `Use` is `diagrid-dev-dashboard` (drives help/usage text).

- [ ] **Step 1: Rename the user-visible strings**

`cmd/root.go`:

```go
// Package cmd wires the diagrid-dev-dashboard CLI.
```

```go
		Use:           "diagrid-dev-dashboard",
```

```go
	c.SetVersionTemplate(fmt.Sprintf("diagrid-dev-dashboard {{.Version}} (commit %s, built %s)\n", info.Commit, info.Date))
```

`cmd/update.go`:

```go
		Short: "Update diagrid-dev-dashboard to the latest or a specific release",
		Long: "Download and install the latest diagrid-dev-dashboard release in place, or a " +
			"specific version (e.g. `diagrid-dev-dashboard update 1.2.0`). Restart any running " +
```

(keep the rest of the `Long` string as-is)

`cmd/update_notice.go:28`:

```go
			"Run `diagrid-dev-dashboard update` to upgrade.\n\n",
```

`pkg/updatecheck/updatecheck.go:1`:

```go
// Package updatecheck reports whether a newer diagrid-dev-dashboard release exists.
```

- [ ] **Step 2: Run the affected suites and fix text assertions**

Run: `go test -tags unit -race ./cmd/... ./pkg/updatecheck/...`
Expected: any failures are string assertions on the old name in `cmd` tests (e.g. update-notice copy). Update those expected strings to the new name — behavior assertions must not change. Re-run until PASS.

- [ ] **Step 3: Verify the version banner end-to-end**

Run: `go run . --version`
Expected output shape: `diagrid-dev-dashboard dev (commit unknown, built unknown)` (values vary; the leading name must be `diagrid-dev-dashboard`).

- [ ] **Step 4: Commit**

```bash
git add cmd/ pkg/updatecheck/
git commit -m "feat(cli)!: rename command surface to diagrid-dev-dashboard"
```

---

### Task 3: Build & release plumbing (goreleaser, Dockerfiles, Makefile)

**Files:**
- Modify: `.goreleaser.yaml`
- Modify: `Dockerfile.goreleaser`
- Modify: `Dockerfile:24,27,30`
- Modify: `Makefile:7`

**Interfaces:**
- Consumes: nothing.
- Produces: release archives named `diagrid-dev-dashboard_{version}_{os}_{arch}.*` containing a binary named `diagrid-dev-dashboard[.exe]` — exactly what Task 1's updater and Task 4's scripts expect.

- [ ] **Step 1: Update .goreleaser.yaml**

Apply exactly these changes (everything else stays):

```yaml
project_name: diagrid-dev-dashboard
```

```yaml
builds:
  - id: diagrid-dev-dashboard
    main: .
    binary: diagrid-dev-dashboard
```

In BOTH `dockers` entries, update the build reference:

```yaml
    ids: [diagrid-dev-dashboard]
```

Do NOT change: the `-X github.com/diagridio/dev-dashboard/...` ldflags, `image_templates` / `docker_manifests` (all `ghcr.io/diagridio/dev-dashboard*`), or:

```yaml
release:
  github:
    owner: diagridio
    name: dev-dashboard   # GitHub REPO name — not the binary
```

Add that trailing comment on the `name:` line so nobody "fixes" it later.

- [ ] **Step 2: Update the container Dockerfiles (image names stay, inner path renames)**

`Dockerfile.goreleaser` (goreleaser copies the built binary by its `binary:` name):

```dockerfile
FROM gcr.io/distroless/static:nonroot
COPY diagrid-dev-dashboard /diagrid-dev-dashboard
ENV DEVDASHBOARD_MODE=aspire
EXPOSE 8080
ENTRYPOINT ["/diagrid-dev-dashboard"]
```

`Dockerfile` — line 24 build output, line 27 copy, line 30 entrypoint:

```dockerfile
    -o /out/diagrid-dev-dashboard .
```

```dockerfile
COPY --from=build /out/diagrid-dev-dashboard /diagrid-dev-dashboard
```

```dockerfile
ENTRYPOINT ["/diagrid-dev-dashboard"]
```

- [ ] **Step 3: Update the Makefile build output**

`Makefile:7`:

```make
	go build -o bin/diagrid-dev-dashboard .
```

- [ ] **Step 4: Validate**

Run: `make release-check`
Expected: `goreleaser check` reports the config is valid.

Run: `make build && ls bin/`
Expected: build succeeds; `bin/` contains `diagrid-dev-dashboard` (the stale `bin/dev-dashboard` may linger from earlier builds — ignore or delete it).

- [ ] **Step 5: Commit**

```bash
git add .goreleaser.yaml Dockerfile Dockerfile.goreleaser Makefile
git commit -m "feat(release)!: rename build outputs and archives to diagrid-dev-dashboard"
```

---

### Task 4: Install scripts

**Files:**
- Modify: `scripts/install.sh`
- Modify: `scripts/install.ps1`

**Interfaces:**
- Consumes: Task 3's asset name `diagrid-dev-dashboard_{num}_{os}_{arch}.tar.gz|zip` and inner binary `diagrid-dev-dashboard[.exe]`.
- Produces: installs at `~/.local/bin/diagrid-dev-dashboard` (sh) and `%LOCALAPPDATA%\Programs\diagrid-dev-dashboard\diagrid-dev-dashboard.exe` (ps1).

- [ ] **Step 1: Update install.sh**

Header comments (lines 2-4): change `Install dev-dashboard` → `Install diagrid-dev-dashboard`. Then:

```sh
file="diagrid-dev-dashboard_${num}_${os}_${arch}.tar.gz"
```

```sh
install -m 0755 "$tmp/diagrid-dev-dashboard" "$BIN_DIR/diagrid-dev-dashboard"
echo "installed diagrid-dev-dashboard $VERSION → $BIN_DIR/diagrid-dev-dashboard"
if [ -e "$BIN_DIR/dev-dashboard" ]; then
  echo "note: found a previous install under the old name; remove it with: rm \"$BIN_DIR/dev-dashboard\""
fi
```

`REPO="diagridio/dev-dashboard"` stays (repo name).

- [ ] **Step 2: Update install.ps1**

Header comments (lines 1-2): `Install diagrid-dev-dashboard to %LOCALAPPDATA%\Programs\diagrid-dev-dashboard`. Then:

```powershell
$binDir = Join-Path $env:LOCALAPPDATA 'Programs\diagrid-dev-dashboard'
```

```powershell
$file = "diagrid-dev-dashboard_${num}_windows_${file_arch}.zip"
```

```powershell
    Copy-Item (Join-Path $tmp 'diagrid-dev-dashboard.exe') (Join-Path $binDir 'diagrid-dev-dashboard.exe') -Force
    Write-Host "installed diagrid-dev-dashboard $version -> $binDir\diagrid-dev-dashboard.exe"
```

After the PATH note block, add the old-install notice:

```powershell
$oldDir = Join-Path $env:LOCALAPPDATA 'Programs\dev-dashboard'
if (Test-Path $oldDir) {
    Write-Host "note: found a previous install under the old name at $oldDir; you can remove that folder (and its PATH entry)."
}
```

`$repo = 'diagridio/dev-dashboard'` stays.

- [ ] **Step 3: Verify the URL construction**

Run: `DRY_RUN=1 VERSION=v9.9.9 sh scripts/install.sh`
Expected output: `https://github.com/diagridio/dev-dashboard/releases/download/v9.9.9/diagrid-dev-dashboard_9.9.9_<os>_<arch>.tar.gz` (repo path old, asset name new).

- [ ] **Step 4: Commit**

```bash
git add scripts/install.sh scripts/install.ps1
git commit -m "feat(install)!: fetch and install diagrid-dev-dashboard"
```

---

### Task 5: Docs + breaking-change release note

**Files:**
- Modify: `README.md` (~31 occurrences)
- Modify: `ARCHITECTURE.md` (command examples / build-output mentions, if any — grep)
- Create: `docs/release-notes/binary-rename-snippet.md`

**Interfaces:** none — docs only.

- [ ] **Step 1: Update README command examples and install text**

Replace every *command/binary/asset* occurrence of `dev-dashboard` with `diagrid-dev-dashboard`: the `--version` / `--port` / `--verbose` / `update` examples (lines ~69, 81, 86, 192, 198, 210), the `./bin/dev-dashboard --statestore ...` example (~346), the release-artifact description (~463), and any `~/.local/bin` install-path prose. Do NOT change: `github.com/diagridio/dev-dashboard` module/repo URLs, `ghcr.io/diagridio/dev-dashboard` image references, `DEVDASHBOARD_*` env vars, or the raw install-script URLs (they live in the repo, whose name is unchanged). Verify the split with:

```bash
grep -n "dev-dashboard" README.md | grep -v "diagrid-dev-dashboard" | grep -v "diagridio/dev-dashboard" | grep -v "ghcr.io" | grep -v "DEVDASHBOARD"
```

Expected: no output.

- [ ] **Step 2: Add the `go install` caveat to README**

Next to the `go install github.com/diagridio/dev-dashboard@<version>` instruction, add:

```markdown
> **Note:** `go install` names the binary after the module path, so it produces
> `dev-dashboard`, not `diagrid-dev-dashboard` — rename it afterwards
> (`mv "$(go env GOPATH)/bin/dev-dashboard" "$(go env GOPATH)/bin/diagrid-dev-dashboard"`)
> or use the install script above.
```

- [ ] **Step 3: Sweep ARCHITECTURE.md**

Run `grep -n "dev-dashboard" ARCHITECTURE.md | grep -v diagrid- | grep -v "diagridio/"` and rename only binary-name mentions (e.g. `bin/dev-dashboard`, `dev-dashboard binary`, CLI invocations); module paths and image names stay.

- [ ] **Step 4: Write the release-note snippet**

Create `docs/release-notes/binary-rename-snippet.md`:

```markdown
### ⚠️ Breaking: the binary is now `diagrid-dev-dashboard`

The CLI, release archives, and installed binary are renamed from `dev-dashboard`
to `diagrid-dev-dashboard`. **Existing installs cannot self-update across this
rename** — `dev-dashboard update` (and the startup update prompt) will fail with
"release not found". Reinstall once with the one-liner:

​```sh
curl -sSL https://raw.githubusercontent.com/diagridio/dev-dashboard/main/scripts/install.sh | sh
​```

Windows (PowerShell):

​```powershell
iwr -useb https://raw.githubusercontent.com/diagridio/dev-dashboard/main/scripts/install.ps1 | iex
​```

then delete the old `dev-dashboard` binary (the installer prints its location if
one is found). The GitHub repo, Go module path, container image names
(`ghcr.io/diagridio/dev-dashboard`), and `DEVDASHBOARD_*` environment variables
are unchanged.
```

(The `​` marks above are literal triple-backtick fences — un-escape them in the real file.) This snippet is pasted into the first renamed release's notes.

- [ ] **Step 5: Commit**

```bash
git add README.md ARCHITECTURE.md docs/release-notes/
git commit -m "docs!: document the diagrid-dev-dashboard rename and update reinstall path"
```

---

### Task 6: Full verification

**Files:** none new.

- [ ] **Step 1: Whole-repo leftover sweep**

```bash
grep -rn "dev-dashboard" --include="*.go" --include="*.yaml" --include="*.yml" --include="Makefile" --include="Dockerfile*" --include="*.sh" --include="*.ps1" . \
  | grep -v node_modules | grep -v "diagrid-dev-dashboard" \
  | grep -v "diagridio/dev-dashboard" | grep -v "github.com/diagridio" \
  | grep -v "ghcr.io" | grep -v "DEVDASHBOARD" | grep -v "diagrid.ws" | grep -v docs/superpowers
```

Expected: no output, or only deliberate leftovers (e.g. `.github/workflows/ci.yaml`'s local `docker build -t dev-dashboard:ci .` tag, which is a throwaway CI tag and may stay). Judge each hit against the Global Constraints' do-not-change list.

- [ ] **Step 2: Full build + test**

Run: `make build && make test`
Expected: build succeeds producing `bin/diagrid-dev-dashboard`; all Go and web suites pass.

- [ ] **Step 3: Snapshot release dry-run (conclusive artifact check)**

Run: `goreleaser release --snapshot --clean --skip=publish,docker` (use plain `make release-snapshot` if docker buildx is available locally)
Then: `ls dist/ | head` and `tar -tzf dist/diagrid-dev-dashboard_*_$(go env GOOS)_$(go env GOARCH).tar.gz`
Expected: archives named `diagrid-dev-dashboard_<ver>-snapshot_<os>_<arch>.*`, each containing a `diagrid-dev-dashboard` binary — proving Task 1's updater expectations match Task 3's outputs.

- [ ] **Step 4: Commit any final fixes**

```bash
git status --porcelain   # commit stragglers if the sweep/verification changed anything
```
