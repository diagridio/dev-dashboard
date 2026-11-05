#!/usr/bin/env bash
# Reset the running Enterprise diagnostics demo to its seeded scenario.
#
# POSTs /demo/reset to every app, then polls each app's /demo/status until all
# report seeded, within a deadline. Exits non-zero naming any app that did not
# accept the reset or did not finish reseeding.
#
# Env: RESET_DEADLINE (seconds, default 120), RESET_POLL_INTERVAL (seconds, default 1).
set -uo pipefail

DEADLINE="${RESET_DEADLINE:-120}"
INTERVAL="${RESET_POLL_INTERVAL:-1}"
# Order matters: sickbay first, so it reports seeded=false before bridge's reseed
# polls it. Otherwise bridge can publish its alerts before sickbay's reset
# deletes the alert/result keys, and those records go missing.
APPS=("sickbay:6003" "engineering:6001" "bridge:6002")

for entry in "${APPS[@]}"; do
  name="${entry%%:*}"; port="${entry##*:}"
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:${port}/demo/reset")
  if [[ "$code" != "202" ]]; then
    echo "reset: ${name} (localhost:${port}) did not accept the reset (HTTP ${code}). Is 'make demo' running?" >&2
    exit 1
  fi
  echo "reset: ${name} accepted"
done

start=$(date +%s)
pending=("${APPS[@]}")
while ((${#pending[@]} > 0)); do
  still=()
  for entry in "${pending[@]}"; do
    name="${entry%%:*}"; port="${entry##*:}"
    body=$(curl -s --max-time 5 "http://localhost:${port}/demo/status" || true)
    if [[ "$body" =~ \"seeded\"[[:space:]]*:[[:space:]]*true ]]; then
      echo "reset: ${name} seeded"
    else
      still+=("$entry")
    fi
  done
  pending=("${still[@]+"${still[@]}"}")
  ((${#pending[@]} == 0)) && break
  if (( $(date +%s) - start >= DEADLINE )); then
    for entry in "${pending[@]}"; do
      name="${entry%%:*}"; port="${entry##*:}"
      body=$(curl -s --max-time 5 "http://localhost:${port}/demo/status" || true)
      echo "reset: ${name} not seeded after ${DEADLINE}s (last status: ${body:-no response})" >&2
    done
    exit 1
  fi
  sleep "$INTERVAL"
done
echo "reset: all apps seeded"
