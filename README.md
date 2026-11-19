# Multicorder

Record several browser tabs and Mac apps at the same time — each source gets its own recording,
live captions, rolling key points with timestamped evidence, and an end-of-session report.
Nothing from one source ever mixes into another.

- **Mac app** (Tauri 2 + Rust): one Core Audio process tap per app, archive, transcription,
  summaries, local API, menu-bar control.
- **Chrome extension** (MV3): one stream per tab via `tabCapture` → offscreen AudioWorklet →
  WebSocket to the Mac app on 127.0.0.1; side panel with one card per recording.

Docs: [plan](docs/plan.md) · [competitors](docs/01-competitor-features.md) ·
[source-code comparison](docs/02-architecture-comparison.md) ·
[technical design](docs/03-technical-design.md) · [implementation plan & test results](docs/implementation-plan.md)

## Layout

```
crates/mc-core           types, config, events
crates/mc-store          SQLite + FTS5 (per-session queries only)
crates/mc-audio          resampling, levels, dropout detection, WAV
crates/mc-recorder       60 s FLAC archive segments with SHA-256
crates/mc-vad            speech chunking (≤15 s chunks)
crates/mc-capture-macos  app discovery/grouping + per-app process taps (cidre)
crates/mc-asr            ASR adapters (MOSS, OpenAI-compatible) + fair scheduler
crates/mc-insight        model client, rolling key points with checked evidence, report
crates/mc-engine         one supervised pipeline per source; modes; exports
crates/mc-local-api      REST + WebSocket ingest + SSE, pairing socket, host manifests
apps/desktop             Tauri app (Rust shell + React UI)
apps/extension           Chrome extension
apps/host                native messaging host (pairing only)
apps/mcd                 headless daemon for development and tests
packages/ui              React components shared by the app and the side panel
scripts/e2e              end-to-end tests with real providers
```

## Develop

Requirements: macOS 14.4+, Apple silicon, Xcode, Rust (rustup), Node 22, pnpm.

```bash
pnpm install
cargo test --workspace
pnpm -r typecheck
pnpm --filter @multicorder/extension build         # → apps/extension/dist (load unpacked)
pnpm --filter @multicorder/desktop app:debug        # → target/debug/bundle/macos/Multicorder.app
```

Providers and keys live in `~/Library/Application Support/Multicorder/config.json`
(created on first run; keys may also come from the environment variable named by `api_key_env`).

Without the app installed, run the daemon and register the host for an unpacked extension:

```bash
cargo run -p mcd -- serve
cargo run -p mcd -- install-host --extension-id ileogemoijmhcnkcbanfaiolhdhoffbj
```

## End-to-end tests (real providers)

```bash
MC_KEYS_ENV=/path/to/keys.env scripts/e2e/run.sh all
```

Keys are read from the env file at run time and never written to the repository. Results go to
`test-output/` (ignored by git). Recording other apps needs the macOS "System Audio Recording"
permission for the process that runs the engine.
