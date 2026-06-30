#!/usr/bin/env bash
# Refresh pkg/metadata/component-metadata-bundle.json from the dapr-components-contrib
# release asset. Usage: scripts/update-component-metadata-bundle.sh <tag>
# Example tag: v1.18.0-catalyst.1
set -euo pipefail
TAG="${1:?usage: update-component-metadata-bundle.sh <tag>}"
DEST="$(dirname "$0")/../pkg/metadata/component-metadata-bundle.json"
URL="https://github.com/diagridio/dapr-components-contrib/releases/download/${TAG}/component-metadata-bundle.json"
echo "Downloading ${URL}"
curl -fsSL "$URL" -o "$DEST"
echo "Wrote $DEST"
