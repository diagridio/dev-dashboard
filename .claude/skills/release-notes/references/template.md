# Release notes template

The previous release's notes are the source of truth for wording; use this when they're
unavailable, and for the section vocabulary. Replace `X.Y.Z` with the release version.

```markdown
## Diagrid Dapr Dev Dashboard

A local dashboard for Dapr developers that offers a live view of everything Dapr running on your machine, plus guided builders for authoring Dapr component files and resiliency policies. In `vX.Y.Z` <one-sentence summary of the headline changes>. Once the dashboard is open, **try the Konami code** and have some fun! ;)

### What's new

**<emoji> <Feature name>**
- <What users can now do, in a full sentence.>
- <Another aspect of the same feature.>

**🎨 UI**
- <...>

**🐛 Fixes**
- <...>

**📚 Docs**
- <...>

**🧪 Testing**
- <...>

**📦 Dependencies**
- Go: `<module>` <old> → <new>, ...
- Web: `<package>` <old> → <new>, ...
- Container base image `distroless/static` updated to the latest digest.

### Install & run

**One-liner (macOS / Linux):**
```sh
curl -sSL https://raw.githubusercontent.com/diagridio/dev-dashboard/main/scripts/install.sh | sh
```

**Windows (PowerShell):**
```powershell
iwr -useb https://raw.githubusercontent.com/diagridio/dev-dashboard/main/scripts/install.ps1 | iex
```

**Go (≥ 1.26):**
```sh
go install github.com/diagridio/dev-dashboard@vX.Y.Z
```
> `go install` names the binary after the module path, so it produces `dev-dashboard`, not `diagrid-dev-dashboard` — rename it afterwards or use the install script above.

**Container:**
```sh
docker pull ghcr.io/diagridio/dev-dashboard:X.Y.Z
```

**Run:**
```sh
diagrid-dev-dashboard          # serves http://localhost:9090 and opens your browser
```

Single self-contained binary — the React frontend is embedded via `go:embed`, so there are no runtime dependencies. This release's tag commit ships the prebuilt UI so `go install` works without a frontend build step. Prebuilt archives for macOS and Linux (amd64 + arm64) and Windows (amd64) are attached below, and the multi-arch container image is on GHCR.
```

For a maintenance release, the summary sentence reads: "`vX.Y.Z` is a maintenance release: <what it tidies or updates>."

## Section vocabulary

Standard sections, in this order, each only when it has content:

| Heading | Use for |
|---|---|
| **🎨 UI** | Visual and navigation changes, sidebar links, copy |
| **🚀 Startup** | Banner, startup messages, ports, how the dashboard decides what to run |
| **🔒 Security** | Security fixes, TLS, secret handling, Go security advisories |
| **🐛 Fixes** | Bugs fixed in existing features |
| **📈 Telemetry** | Changes to the anonymous usage telemetry |
| **📚 Docs** | README, ARCHITECTURE, CONTRIBUTING changes users or contributors would notice |
| **🧪 Testing** | New test suites, e2e coverage, CI test changes |
| **📦 Dependencies** | Version bumps (Go, web, container image, CI actions), always last |

Feature sections come first, with an emoji that fits the feature. Headings used so far:
🐳 Run the dashboard inside Docker Compose · 🔎 Clearer app and sidecar status · 🌐 HTTP Endpoints
page · ⚙️ Configuration files for `dapr run` apps · 🧱 Dapr 1.19 building blocks · 🛡️ Discovered
resiliency policies · 🔗 Dapr Ops Dashboard link · 🚀 Friendlier startup · 🕹️ Konami code game polish.
