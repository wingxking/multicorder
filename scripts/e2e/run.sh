#!/usr/bin/env bash
# Full local end-to-end run with real ASR and model keys (see docs/implementation-plan.md §2).
#   scripts/e2e/run.sh [ws|extension|app|all]
. "$(dirname "$0")/env.sh"
WHAT="${1:-all}"
cd "$ROOT"
cargo build -q -p mcd -p multicorder-host
pnpm --filter @multicorder/extension build >/dev/null
[ -f "$OUT/a.wav" ] || "$ROOT/scripts/e2e/prepare-audio.sh"
rm -rf "$MC_DATA_DIR"; mkdir -p "$MC_DATA_DIR"; write_config
"$ROOT/target/debug/mcd" serve > "$OUT/mcd.out" 2> "$OUT/mcd.log" &
MCD=$!
trap 'kill $MCD 2>/dev/null; wait $MCD 2>/dev/null' EXIT
for _ in $(seq 1 50); do [ -f "$MC_DATA_DIR/run/api.json" ] && break; sleep 0.2; done
echo "mcd running: $(cat "$OUT/mcd.out")"
STATUS=0
if [ "$WHAT" = ws ] || [ "$WHAT" = all ]; then node scripts/e2e/ws-two-tabs.mjs || STATUS=1; fi
if [ "$WHAT" = extension ] || [ "$WHAT" = all ]; then node scripts/e2e/extension.mjs || STATUS=1; fi
if [ "$WHAT" = app ] || [ "$WHAT" = all ]; then node scripts/e2e/app-tap.mjs || STATUS=1; fi
echo "e2e status: $STATUS (details in $OUT)"
exit $STATUS
