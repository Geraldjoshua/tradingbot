#!/usr/bin/env bash
# Run every test AND prove the live config survived it.
#
# Three of the test scripts call flow.saveConfig(), which writes
# server/autotrader.config.json for real. One of them silently reset
# entry.requireTag back to CONFIRMED-only and the next packaged build would have
# shipped it. A reminder to "check the file afterwards" is not a fix — this is.
set -uo pipefail
cd "$(dirname "$0")/.."
CFG=server/autotrader.config.json
BEFORE=$(mktemp); cp "$CFG" "$BEFORE"

fail=0
run() { echo "--- $1"; shift; "$@" >/tmp/_t.out 2>&1 || fail=1; tail -2 /tmp/_t.out; }

run "unit: playbook / sizing / ratchet"  node tools/vd_selftest.mjs
for f in /tmp/gateorder.mjs /tmp/pending.mjs /tmp/sharestops.mjs /tmp/stop2.mjs \
         /tmp/dupe_pnl.mjs /tmp/budgettest.mjs /tmp/gridtest.mjs /tmp/verdict.mjs; do
  [ -f "$f" ] && run "integration: $(basename "$f")" node --import /tmp/stub.mjs "$f"
done
[ -f scanner/test_core.py ] && run "scanner" python3 scanner/test_core.py

echo "--- typecheck"
./node_modules/.bin/tsc --noEmit -p tsconfig.json && echo "  tsc clean" || fail=1

echo "--- config integrity"
if diff -q "$BEFORE" "$CFG" >/dev/null; then
  echo "  OK: $CFG unchanged by the test run"
else
  echo "  !! $CFG WAS MODIFIED BY A TEST — restoring"
  diff "$BEFORE" "$CFG" | head -20
  cp "$BEFORE" "$CFG"
  echo "  restored. (a test called saveConfig against the live file)"
  fail=1
fi
rm -f "$BEFORE"
echo
[ $fail -eq 0 ] && echo "ALL GREEN" || echo "SOMETHING FAILED — see above"
exit $fail
