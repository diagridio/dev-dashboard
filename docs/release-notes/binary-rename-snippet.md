### ⚠️ Breaking: the binary is now `diagrid-dev-dashboard`

The CLI, release archives, and installed binary are renamed from `dev-dashboard`
to `diagrid-dev-dashboard`. **Existing installs cannot self-update across this
rename** — `dev-dashboard update` (and the startup update prompt) will fail with
"release not found". Reinstall once with the one-liner:

```sh
curl -sSL https://raw.githubusercontent.com/diagridio/dev-dashboard/main/scripts/install.sh | sh
```

Windows (PowerShell):

```powershell
iwr -useb https://raw.githubusercontent.com/diagridio/dev-dashboard/main/scripts/install.ps1 | iex
```

then delete the old `dev-dashboard` binary (the installer prints its location if
one is found). The GitHub repo, Go module path, container image names
(`ghcr.io/diagridio/dev-dashboard`), `DEVDASHBOARD_*` environment variables,
and your saved state-store connections in `~/.dapr/dev-dashboard/` are unchanged.
