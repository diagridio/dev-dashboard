#!/usr/bin/env bash
# Print the latest stable Dapr runtime and Dapr.Workflow (.NET SDK) patch
# releases for one minor line, in GITHUB_OUTPUT key=value form:
#
#   $ scripts/latest-dapr-versions.sh 1.19
#   runtime=1.19.1
#   dotnet_sdk=1.19.0
#
# The runtime comes from dapr/dapr GitHub releases (prereleases and drafts
# excluded), the SDK from the NuGet flat-container index (versions with a
# pre-release suffix excluded). Uses `gh` for the GitHub API so CI gets an
# authenticated rate limit via GH_TOKEN.
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

if [ -z "$runtime" ] || [ -z "$dotnet_sdk" ]; then
  echo "no stable release found for Dapr $minor (runtime='$runtime', dotnet_sdk='$dotnet_sdk')" >&2
  exit 1
fi

echo "runtime=$runtime"
echo "dotnet_sdk=$dotnet_sdk"
