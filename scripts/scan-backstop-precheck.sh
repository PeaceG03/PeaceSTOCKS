#!/usr/bin/env bash
# Cheap pre-check for scan-backstop.yml (bash + gh only, no checkout/install). Prints due=true|false to
# $GITHUB_OUTPUT (or stdout). due=false only when planOpenScanAt (src/scan-backstop.ts) would certainly not
# dispatch: inside a guard window, under 30 min after the last slot, or a scheduled "Scanner" run exists since
# the slot. Anything else (incl. any API error) => due=true, so the full backstop decides (fail open to the check).
# NOW_EPOCH overrides the clock in tests.
set -uo pipefail
now="${NOW_EPOCH:-$(date -u +%s)}"
out="${GITHUB_OUTPUT:-/dev/stdout}"
emit() { echo "due=$1" >> "$out"; echo "scan-backstop-precheck: due=$1 ($2)" >&2; exit 0; }
mins=$(( (now % 86400) / 60 ))
if { [ "$mins" -ge 315 ] && [ "$mins" -lt 375 ]; } || { [ "$mins" -ge 555 ] && [ "$mins" -lt 615 ]; }; then emit false "guard window"; fi
slot=""
for d in 0 1 2 3 4; do
  day=$(( now / 86400 * 86400 - d * 86400 ))
  dow=$(date -u -d "@$day" +%u)   # 1=Mon..7=Sun; slots Tue-Sat (2..6)
  [ "$dow" -ge 2 ] && [ "$dow" -le 6 ] || continue
  for s in 570 330; do t=$(( day + s * 60 )); if [ "$t" -le "$now" ]; then slot=$t; break 2; fi; done
done
[ -n "$slot" ] || emit true "no slot found"
[ $(( now - slot )) -ge 1800 ] || emit false "under 30 min after slot"
since=$(date -u -d "@$(( slot - 300 ))" +%Y-%m-%dT%H:%M:%SZ)
n=$(gh api "repos/${GITHUB_REPOSITORY}/actions/workflows/scanner.yml/runs?event=schedule&created=%3E%3D${since}&per_page=100" \
  --jq '[.workflow_runs[] | select(.display_title == "Scanner")] | length' 2>/dev/null) || emit true "api error"
[[ "$n" =~ ^[0-9]+$ ]] || emit true "api error"
[ "$n" -eq 0 ] || emit false "scheduled scan ran since slot"
emit true "no scheduled scan since slot"
