# dev-dashboard self-update (`dev-dashboard update`)

**Status:** Approved design — ready for implementation planning
**Date:** 2026-06-28

## Summary

Add the ability for the `dev-dashboard` binary to update itself in place from its
GitHub Releases, via a new `update` subcommand:

```sh
dev-dashboard update          # install the latest release (no-op if already current)
dev-dashboard update 1.2.0    # install exactly 1.2.0 (allows downgrade / reinstall)
```

The mechanism mirrors the existing `scripts/install.sh` / `install.ps1` flow
(resolve version → download archive → verify checksum → place the binary), but
performed by the binary itself, swapping the currently-running executable.

## Goals

- One command to move to the latest release, or to a pinned version.
- No new third-party dependencies — standard library only, consistent with the
  project's minimal-dependency ethos (embedded SPA, hand-rolled install scripts,
  custom YAML highlighter).
- Safe: verify the SHA256 checksum before replacing the binary; never leave the
  install in a partial/broken state on failure.
- Cross-platform: macOS, Linux, Windows (the 5 GoReleaser targets).

## Non-goals

- Code signing / signature verification of the downloaded binary (the release
  pipeline ships `checksums.txt` only; signing is out of scope for v1).
- Auto-update / background update checks. This is an explicit, user-initiated
  command only.
- Updating installs that are not a single self-contained binary (e.g. a custom
  multi-file layout). The release artifact is a single binary, matching the
  `selfupdate` single-file model.
- Package-manager installs (Homebrew/Scoop/winget) — not yet shipped; when they
  exist, updates go through the package manager, not this command.

## CLI surface

A new Cobra subcommand registered on the root command:

- `dev-dashboard update`
  - Resolve the latest release tag.
  - If the latest equals the current build version → print
    `already up to date (vX.Y.Z)` and exit 0 **without downloading**.
  - Otherwise download, verify, and replace.
- `dev-dashboard update <version>`
  - Install exactly `<version>` (e.g. `1.2.0` or `v1.2.0`; both accepted and
    normalized). Skips the "already current" comparison, so it can downgrade or
    reinstall the same version.

Behavior:

- Progress is written to **stderr** as plain lines:
  `resolving latest…`, `downloading dev-dashboard vX.Y.Z (os/arch)…`,
  `verifying checksum…`, `installing to <path>…`, `updated vA.B.C → vX.Y.Z (restart to use it)`.
- **No confirmation prompt** — running `update` is itself the confirmation.
- Exit code 0 on success or on "already up to date"; non-zero on any error.

This is implemented as a subcommand (not a `--update` flag) because Cobra models
an optional positional argument and per-subcommand `--help` cleanly, whereas a
flag-with-optional-value (`NoOptDefVal`) is awkward.

## Architecture

All logic lives in a new domain package `pkg/selfupdate`, with `cmd/update.go`
as a thin wrapper. No `pkg → cmd` dependency, consistent with the rest of the
codebase.

### `pkg/selfupdate`

An `Updater` value carries everything needed (and everything tests need to
override):

```go
type Updater struct {
    Repo           string       // "diagridio/dev-dashboard"
    APIBase        string       // default "https://api.github.com" (overridable in tests)
    DownloadBase   string       // default "https://github.com"      (overridable in tests)
    HTTP           *http.Client
    GOOS, GOARCH   string       // default runtime.GOOS / runtime.GOARCH
    CurrentVersion string       // version.Get().Version
    ExecPath       string       // resolved path of the running binary
    Out            io.Writer    // progress sink (stderr)
}

type Result struct {
    From, To string // version moved from → to
    Skipped  bool   // already up to date
}

func (u *Updater) Run(ctx context.Context, requested string) (Result, error)
```

Internally composed of small, independently-testable functions:

- `resolveVersion(ctx, requested) (string, error)` — if `requested` is empty,
  GET `{APIBase}/repos/{Repo}/releases/latest` and read `tag_name`; otherwise
  normalize `requested` (ensure a leading `v`). Returns the canonical `vX.Y.Z`.
- `assetName(version, goos, goarch) string` — reproduces the GoReleaser
  `name_template`: `dev-dashboard_{num}_{os}_{arch}` with `num` = version without
  the leading `v`; extension `.tar.gz` everywhere except Windows (`.zip`).
- `download(ctx, url) ([]byte, error)` — fetch archive and `checksums.txt` from
  `{DownloadBase}/{Repo}/releases/download/{version}/{name}`.
- `verifyChecksum(archive []byte, assetName, checksumsTxt string) error` —
  compute SHA256 of `archive`, find the line for `assetName` in `checksums.txt`,
  compare. Mismatch (or missing entry) returns an error **before** any swap.
- `extractBinary(archive []byte, goos string) ([]byte, error)` — read
  `dev-dashboard` (or `dev-dashboard.exe`) out of a tar.gz or zip in memory.
- `replaceExecutable(path string, newBin []byte) error` — the atomic swap (below).

### Atomic self-replacement

This is the one genuinely tricky, platform-specific part.

1. Target path = `filepath.EvalSymlinks(ExecPath)` so we replace the real file,
   not a symlink.
2. Write `newBin` to a temp file **in the same directory** as the target (same
   filesystem → `os.Rename` is atomic), `chmod 0755`.
3. **Unix (darwin/linux):** `os.Rename(temp, target)`. Replacing the on-disk
   file of a running process is allowed; the running process keeps the old inode,
   the next launch uses the new file.
4. **Windows:** the running `.exe` cannot be overwritten. Rename
   `target → target + ".old"`, then `temp → target`. Best-effort `os.Remove` of
   the `.old` file (it may be locked while the process runs — if so it is left
   behind and cleaned up opportunistically on a later run).
5. **Failure handling:** if the second rename fails after moving the target
   aside, restore the original from `.old`/backup so the install is never left
   broken. The temp file is always cleaned up on the error path.
6. **Non-writable target** (system dir, read-only `go install` location, etc.):
   detect the permission error and return a clear message pointing the user back
   to the install one-liner (or suggesting `sudo` / relocating the binary). No
   partial state is written.

### Version comparison

For the no-argument case, compare the normalized latest tag against
`version.Get().Version` (comparison tolerant of an optional leading `v`). Equal →
`Result{Skipped: true}`, no download. A `dev` / `go install` build reports
version `dev`, which is never equal to a release tag, so `update` upgrades it to
the latest release binary.

## Security

- Downloads occur only from `github.com/diagridio/dev-dashboard` releases over
  HTTPS (`Repo` is a compile-time constant; not user-overridable on the CLI).
- The archive's SHA256 is verified against the release's `checksums.txt` before
  the binary is swapped in. A mismatch aborts with a non-zero exit and no change
  to the installed binary.
- No code signing in v1 (see Non-goals).

## `cmd/update.go`

A thin wrapper:

- Build an `Updater` from `version.Get()`, `os.Executable()`, `runtime.GOOS` /
  `runtime.GOARCH`, an `*http.Client`, the `diagridio/dev-dashboard` repo
  constant, and `os.Stderr`.
- Take the optional positional version argument.
- Call `Updater.Run`, print the final result line, and map errors to a non-zero
  exit (using the existing `SilenceUsage`/`SilenceErrors` conventions).
- Register on the root command via `AddCommand`.

## Error handling

| Condition | Behavior |
|-----------|----------|
| Network/API failure resolving latest | Non-zero exit, message; no change. |
| Requested version not found (404) | Non-zero exit: `release vX.Y.Z not found`. |
| Archive download failure | Non-zero exit; no change. |
| Checksum mismatch / missing entry | Non-zero exit; binary **not** replaced. |
| Binary missing from archive | Non-zero exit; no change. |
| Target not writable | Non-zero exit with guidance (re-run install / sudo). |
| Already up to date (no-arg) | Exit 0, informational message. |

## Testing

- **Unit** (`-tags unit`):
  - `assetName` across all 5 release targets (linux/darwin amd64+arm64, windows
    amd64) — correct extension and `num` formatting.
  - version normalization (`1.2.0` ↔ `v1.2.0`) and the equality check.
  - `verifyChecksum` pass and fail.
  - `extractBinary` from an in-memory tar.gz and an in-memory zip.
  - `replaceExecutable` against a temp directory: seed a dummy "binary", swap,
    assert new contents and `0755` mode. (Windows-specific rename path guarded
    by `runtime.GOOS`.)
- **Integration** (`-tags integration`):
  - Full `Updater.Run` against an `httptest.Server` serving `releases/latest`
    JSON, the archive bytes, and `checksums.txt`, with `APIBase`/`DownloadBase`
    pointed at the test server. Cases: happy-path upgrade, checksum mismatch,
    version-not-found, already-current (no download).

## Documentation

Add an "Updating" section to `README.md`:

```sh
# Update to the latest release
dev-dashboard update

# Pin a specific version (can downgrade / reinstall)
dev-dashboard update 1.2.0
```

Note that the new binary takes effect on the next launch (restart any running
instance), and that package-manager installs (when available) should update
through the package manager instead.

## Out of scope / future

- Auto / background update checks and "update available" notices in the UI.
- Code signing / notarization of release binaries and verification here.
- A `--dry-run` flag (mirroring `install.sh`'s `DRY_RUN`) to print the resolved
  URL without applying — easy to add later if useful.
