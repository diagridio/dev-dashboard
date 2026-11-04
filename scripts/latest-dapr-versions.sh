#!/usr/bin/env bash
# Print the latest stable Dapr runtime, Dapr.Workflow (.NET SDK) and Go SDK
# releases for one minor line, in GITHUB_OUTPUT key=value form:
#
#   $ scripts/latest-dapr-versions.sh 1.19
#   runtime=1.19.1
#   dotnet_sdk=1.19.0
#   go_sdk=v1.16.0
#
# The runtime comes from dapr/dapr GitHub releases (prereleases and drafts
# excluded), the .NET SDK from the NuGet flat-container index (versions with a
# pre-release suffix excluded). The Go SDK doesn't share Dapr's version
# numbers, so go_sdk is the newest stable dapr/go-sdk release whose go.mod
# requires github.com/dapr/dapr at this minor line (read from the Go module
# proxy). Uses `gh` for the GitHub API so CI gets an authenticated rate limit
# via GH_TOKEN.
set -euo pipefail

minor="${1:?usage: $0 <major.minor>, e.g. 1.19}"
if ! [[ "$minor" =~ ^[0-9]+\.[0-9]+$ ]]; then
  echo "invalid minor version: $minor" >&2
  exit 1
fi

# Sort semver patch versions numerically and keep the highest.
latest() { sort -t. -k3,3n | tail -n1; }

runtime=$(gh api --paginate 'repos/dapr/dapr/releases?per_page=100' \
  -q '.[] | select(.prerelease == false and .draft == false) | .tag_name' |
  sed 's/^v//' | grep -E "^${minor//./\\.}\.[0-9]+$" | latest || true)

dotnet_sdk=$(curl -fsSL https://api.nuget.org/v3-flatcontainer/dapr.workflow/index.json |
  jq -r '.versions[]' | grep -E "^${minor//./\\.}\.[0-9]+$" | latest || true)

proxy=https://proxy.golang.org/github.com/dapr/go-sdk/@v
go_sdk=""
# Newest first; only the 10 newest are checked (each lookup is a request).
for v in $(curl -fsSL "$proxy/list" | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' |
  sed 's/^v//' | sort -t. -k1,1nr -k2,2nr -k3,3nr | head -n 10); do
  mod=$(curl -fsSL "$proxy/v$v.mod")
  if grep -qE "github\.com/dapr/dapr v${minor//./\\.}\." <<<"$mod"; then
    go_sdk=v$v
    break
  fi
done

if [ -z "$runtime" ] || [ -z "$dotnet_sdk" ] || [ -z "$go_sdk" ]; then
  echo "no stable release found for Dapr $minor (runtime='$runtime', dotnet_sdk='$dotnet_sdk', go_sdk='$go_sdk')" >&2
  exit 1
fi

echo "runtime=$runtime"
echo "dotnet_sdk=$dotnet_sdk"
echo "go_sdk=$go_sdk"
