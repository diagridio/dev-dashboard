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
