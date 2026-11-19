#!/usr/bin/env bash
# Full local end-to-end run with real ASR and model keys (see docs/implementation-plan.md §2).
#   scripts/e2e/run.sh [ws|extension|standalone|dup|service|app|all]
# "all" runs everything except "app", which needs the System Audio Recording permission for the
# process running the engine (run it through Multicorder.app, see docs/implementation-plan.md §4).
. "$(dirname "$0")/env.sh"
WHAT="${1:-all}"
cd "$ROOT"
cargo build -q -p mcd -p multicorder-host
pnpm --filter @multicorder/extension build >/dev/null
[ -f "$OUT/a.wav" ] || "$ROOT/scripts/e2e/prepare-audio.sh"
rm -rf "$MC_DATA_DIR"; mkdir -p "$MC_DATA_DIR"; write_config
"$ROOT/target/debug/mcd" serve > "$OUT/mcd.out" 2> "$OUT/mcd.log" &
MCD=$!
STATUS=0
trap 'kill "$MCD" 2>/dev/null || true; wait "$MCD" 2>/dev/null || true; exit "$STATUS"' EXIT
for _ in $(seq 1 50); do [ -f "$MC_DATA_DIR/run/api.json" ] && break; sleep 0.2; done
echo "mcd running: $(cat "$OUT/mcd.out")"
STATUS=0
if [ "$WHAT" = ws ] || [ "$WHAT" = all ]; then node scripts/e2e/ws-two-tabs.mjs || STATUS=1; fi
if [ "$WHAT" = extension ] || [ "$WHAT" = all ]; then node scripts/e2e/extension.mjs || STATUS=1; fi
if [ "$WHAT" = dup ] || [ "$WHAT" = all ]; then node scripts/e2e/dup-guard.mjs || STATUS=1; fi
if [ "$WHAT" = standalone ] || [ "$WHAT" = all ]; then node scripts/e2e/extension-standalone.mjs || STATUS=1; fi
if [ "$WHAT" = service ] || [ "$WHAT" = all ]; then node scripts/e2e/service-outage.mjs || STATUS=1; fi
if [ "$WHAT" = app ]; then node scripts/e2e/app-tap.mjs || STATUS=1; fi
echo "e2e status: $STATUS (details in $OUT)"
exit $STATUS
