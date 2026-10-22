#!/usr/bin/env bash
# Runs govulncheck and fails only on vulnerabilities our code actually calls,
# minus the allowlist below. govulncheck has no ignore flag, so we filter its
# JSON stream: a finding is "called" when its innermost trace frame names a
# function.
set -euo pipefail

# Advisories with no upstream fix that we accept. Keep each with a reason.
ALLOW=(
  GO-2026-4883 # github.com/docker/docker: no fixed version (module moved to moby/moby)
  GO-2026-4887 # github.com/docker/docker: no fixed version (module moved to moby/moby)
)

out="$(mktemp)"
trap 'rm -f "$out"' EXIT
go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 -format json -tags unit,integration ./... >"$out"

called="$(jq -r 'select(.finding != null and .finding.trace[0].function != null) | .finding.osv' "$out" | sort -u)"
allow="$(printf '%s\n' "${ALLOW[@]}")"
blocking="$(comm -23 <(printf '%s\n' "$called" | sed '/^$/d') <(printf '%s\n' "$allow" | sort -u))"

if [ -n "$blocking" ]; then
  echo "govulncheck: called vulnerabilities not on the allowlist:"
  while read -r id; do
    fixed="$(jq -r --arg id "$id" 'select(.finding.osv == $id) | .finding.fixed_version // "none" ' "$out" | sort -u | paste -sd, -)"
    echo "  $id (fixed in: $fixed) https://pkg.go.dev/vuln/$id"
  done <<<"$blocking"
  exit 1
fi
echo "govulncheck: no unallowlisted called vulnerabilities"
