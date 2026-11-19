# Shared settings for the end-to-end tests. Keys are read from an env file outside the repo
# (default: the Catchup project's media/.env) and only exported to child processes.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/test-output"
export MC_DATA_DIR="$OUT/data"
KEYS_ENV="${MC_KEYS_ENV:-$HOME/x/catchup/media/.env}"
if [ ! -f "$KEYS_ENV" ]; then echo "keys file not found: $KEYS_ENV" >&2; exit 1; fi
set -a; . "$KEYS_ENV"; set +a
. "$HOME/.cargo/env"
mkdir -p "$OUT" "$MC_DATA_DIR"
EXT_ID="ileogemoijmhcnkcbanfaiolhdhoffbj"
write_config() {
  cat > "$MC_DATA_DIR/config.json" <<JSON
{
  "asr": {"provider": "moss", "protocol": "moss", "base_url": "https://api.mosi.cn/v1", "model": "moss-transcribe-diarize-pro",
          "api_key_env": "MOSS_API_KEY", "timestamps": "segment", "usd_per_minute": 0.005, "concurrency": 3},
  "llm": {"use": "moss", "fallback": ["zhipu", "deepseek"], "providers": {
    "moss": {"base_url": "https://api.mosi.cn/v1", "api_key_env": "MOSS_API_KEY", "model": "nex-n2.6", "prices": [0.55, 0.55, 2.8]},
    "zhipu": {"base_url": "https://open.bigmodel.cn/api/paas/v4", "api_key_env": "ZHIPU_LLM_KEY", "model": "glm-4.7-flash", "extra": {"thinking": {"type": "disabled"}}, "prices": [0, 0, 0]},
    "deepseek": {"base_url": "https://api.deepseek.com", "api_key_env": "DEEPSEEK_LLM_KEY", "model": "deepseek-flash", "extra": {"thinking": {"type": "disabled"}}, "prices": [0.3, 0.006, 1.2]}
  }},
  "output_lang": "zh",
  "allowed_extension_ids": ["$EXT_ID"],
  "daily_usd_cap": 2.0
}
JSON
  chmod 600 "$MC_DATA_DIR/config.json"
}
