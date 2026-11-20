//! Multicorder desktop app (Tauri 2): hosts the engine, the local API for the extension and the
//! pairing socket; the React UI talks to the engine through commands and receives engine events.

use std::sync::Arc;

use mc_core::{RecordingFormat, SourceSpec, SummaryMode};
use mc_engine::{Engine, ExportFormat, StartOptions};
use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, State, WindowEvent};

mod mac;
mod recording_files;
use recording_files::{RecordingPreview, TextFormat, TextPart};

/// Extension IDs allowed to pair (the published key and the unpacked development key).
const EXTENSION_IDS: &[&str] = &["ileogemoijmhcnkcbanfaiolhdhoffbj"];

struct AppState {
    engine: Arc<Engine>,
    port: u16,
    browser_sources: Arc<mc_local_api::BrowserSources>,
}

type Res<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
fn status(s: State<AppState>, app: tauri::AppHandle) -> Value {
    let mut v = serde_json::to_value(s.engine.status()).unwrap_or_default();
    v["api_port"] = json!(s.port);
    v["app_version"] = json!(app.package_info().version.to_string());
    v
}

/// Transcription and summary settings for the Settings page. Keys never leave the backend: the
/// page only learns whether one is saved.
#[tauri::command]
fn ai_settings(s: State<AppState>) -> Value {
    let c = s.engine.config();
    let llm = c.llm.providers.get(&c.llm.use_);
    json!({
        "mode": if c.service.uses_service() { "service" } else { "custom" },
        "env": if c.service.env == "local" { "local" } else { "cloud" },
        "local_url": c.service.local_url,
        "cloud_url": mc_core::config::CLOUD_SERVICE_URL,
        "service_url": c.service.base_url(),
        "token_set": !c.service.token.trim().is_empty(),
        "asr": {
            "provider": c.asr.provider, "protocol": c.asr.protocol, "base_url": c.asr.base_url,
            "model": c.asr.model, "language": c.asr.language, "key_set": !c.asr.key().is_empty(),
        },
        "llm": {
            "provider": c.llm.use_,
            "base_url": llm.map(|p| p.base_url.clone()).unwrap_or_default(),
            "model": llm.map(|p| p.model.clone()).unwrap_or_default(),
            "key_set": llm.is_some_and(|p| !p.key().is_empty()),
        },
    })
}

#[derive(serde::Deserialize)]
struct AsrInput { provider: String, protocol: String, base_url: String, model: String, #[serde(default)] language: String, api_key: Option<String> }

#[derive(serde::Deserialize)]
struct LlmInput { provider: String, base_url: String, model: String, api_key: Option<String> }

#[derive(serde::Deserialize)]
struct AiInput { mode: String, env: String, local_url: String, token: Option<String>, asr: AsrInput, llm: LlmInput }

/// Saves the Settings page's choices to config.json and applies them at once. A key left out
/// (`null`) keeps the saved one; an empty string removes it.
#[tauri::command]
fn save_ai_settings(s: State<AppState>, settings: AiInput) -> Res<Value> {
    let AiInput { mode, env, local_url, token, asr, llm } = settings;
    anyhow_ok(matches!(mode.as_str(), "service" | "custom") && matches!(env.as_str(), "cloud" | "local"), "Unknown service choice")?;
    let local_url = local_url.trim().trim_end_matches('/').to_string();
    if env == "local" {
        let url = local_url.strip_suffix("/v1").unwrap_or(&local_url);
        anyhow_ok(url.starts_with("http://") || url.starts_with("https://"), "The local service address must start with http:// or https://")?;
        // This app's own API forwards to the service, so pointing the service at it would loop.
        anyhow_ok(!url.ends_with(&format!(":{}", s.port)), "That address is this app's own extension service. Use the address of a separately running Multicorder service.")?;
    }
    if mode == "custom" {
        anyhow_ok(matches!(asr.protocol.as_str(), "moss" | "openai"), "Unknown transcription protocol")?;
        anyhow_ok(!asr.base_url.trim().is_empty() && !asr.model.trim().is_empty(), "Enter the transcription provider's address and model")?;
        anyhow_ok(!llm.provider.trim().is_empty() && !llm.base_url.trim().is_empty() && !llm.model.trim().is_empty(), "Enter the summary provider's address and model")?;
    }
    s.engine.update_config(|c| {
        c.service.mode = mode;
        c.service.env = env;
        if !local_url.is_empty() {
            c.service.local_url = local_url;
        }
        if let Some(token) = token {
            c.service.token = token.trim().to_string();
        }
        if c.service.mode == "custom" {
            c.asr.provider = asr.provider.trim().to_string();
            c.asr.protocol = asr.protocol;
            c.asr.base_url = asr.base_url.trim().to_string();
            c.asr.model = asr.model.trim().to_string();
            c.asr.language = asr.language.trim().to_string();
            c.asr.timestamps = "segment".into();
            if let Some(key) = asr.api_key {
                // A key typed here wins over an environment variable.
                c.asr.api_key = key.trim().to_string();
                c.asr.api_key_env.clear();
            }
            let name = llm.provider.trim().to_string();
            let entry = c.llm.providers.entry(name.clone()).or_insert_with(|| mc_core::config::LlmProvider {
                base_url: String::new(), api_key_env: String::new(), api_key: String::new(), model: String::new(), extra: None, prices: [0.0; 3], json_mode: true,
            });
            entry.base_url = llm.base_url.trim().to_string();
            entry.model = llm.model.trim().to_string();
            if let Some(key) = llm.api_key {
                entry.api_key = key.trim().to_string();
                entry.api_key_env.clear();
            }
            c.llm.use_ = name;
        }
    }).map_err(err)?;
    Ok(ai_settings(s))
}

fn anyhow_ok(ok: bool, message: &str) -> Res<()> {
    if ok { Ok(()) } else { Err(message.to_string()) }
}

#[tauri::command]
fn list_apps(s: State<AppState>) -> Res<Value> {
    s.engine.list_apps().map(|a| json!(a)).map_err(err)
}

#[tauri::command]
fn list_browser_sources(s: State<AppState>) -> Value {
    json!(s.browser_sources.list())
}

/// Brings the tab forward with a recording request, then sends the extension's record command
/// so Chrome grants it capture of that tab.
#[tauri::command]
async fn open_browser_source(s: State<'_, AppState>, source_id: String, mode: String, mute_playback: bool) -> Res<mac::Gesture> {
    let bundle = s.browser_sources.focus(&source_id, SummaryMode::parse(&mode).unwrap_or_default(), mute_playback).map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || mac::send_record_shortcut(bundle.as_deref())).await.map_err(err)
}

#[tauri::command]
async fn app_icon(app: tauri::AppHandle, bundle_path: String) -> Res<tauri::ipc::Response> {
    let cache = app.path().app_cache_dir().map_err(err)?.join("icons");
    tauri::async_runtime::spawn_blocking(move || mac::app_icon_png(&bundle_path, &cache)).await.map_err(err)?
        .map(tauri::ipc::Response::new).map_err(err)
}

#[tauri::command]
fn list_microphones(s: State<AppState>) -> Res<Value> {
    s.engine.list_microphones().map(|inputs| json!(inputs)).map_err(err)
}

#[tauri::command]
async fn start_mic_session(s: State<'_, AppState>, device_id: String, mode: String, format: Option<RecordingFormat>) -> Res<Value> {
    let mode = SummaryMode::parse(&mode).unwrap_or_default();
    let options = StartOptions { format: format.unwrap_or_default(), ..Default::default() };
    s.engine.start_session_opts(SourceSpec::Mic { device: Some(device_id) }, mode, None, options)
        .map(|(session, _)| json!({"session": session})).map_err(err)
}

#[tauri::command]
fn list_sessions(s: State<AppState>) -> Res<Value> {
    s.engine.sessions_json_with_limit(false, -1).map(|v| json!(v)).map_err(err)
}

/// Retries every failed transcription chunk of a session now.
#[tauri::command]
async fn retry_asr(s: State<'_, AppState>, id: String) -> Res<Value> {
    s.engine.retry_asr(&id).map(|n| json!({"queued": n})).map_err(err)
}

/// Shows the macOS save panel, starting in Downloads with a cleaned-up `name.extension`, and
/// returns the chosen path (with the extension added if the user removed it), or `None` when the
/// user cancels. Blocks, so call it off the main thread.
fn ask_save_path(app: &tauri::AppHandle, name: &str, filter: &str, extension: &str, title: Option<String>) -> Res<Option<std::path::PathBuf>> {
    use tauri_plugin_dialog::DialogExt;
    let mut dialog = app.dialog().file().set_file_name(recording_files::file_name(name, extension)).add_filter(filter, &[extension]);
    if let Some(title) = title {
        dialog = dialog.set_title(title);
    }
    if let Ok(dir) = app.path().download_dir() {
        dialog = dialog.set_directory(dir);
    }
    let Some(picked) = dialog.blocking_save_file() else { return Ok(None) };
    let mut path = picked.into_path().map_err(err)?;
    if path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case(extension)) != Some(true) {
        path.as_mut_os_string().push(format!(".{extension}"));
    }
    Ok(Some(path))
}

/// The suggested file name: what the UI shows for the recording, else its stored title.
fn save_name(engine: &Engine, id: &str, name: Option<String>) -> Res<String> {
    match name.filter(|n| !n.trim().is_empty()) {
        Some(name) => Ok(name),
        None => Ok(engine.store.session(id).map_err(err)?.ok_or("Recording unavailable")?.title),
    }
}

/// Asks where to save the session's recording as one WAV file and writes it there. Returns the
/// path, or `None` when the user cancels.
#[tauri::command]
async fn export_audio(s: State<'_, AppState>, app: tauri::AppHandle, id: String, name: Option<String>, title: Option<String>) -> Res<Option<String>> {
    let engine = s.engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let name = save_name(&engine, &id, name)?;
        let wav = engine.audio_wav(&id).map_err(err)?;
        let Some(path) = ask_save_path(&app, &name, "WAV", "wav", title)? else { return Ok(None) };
        std::fs::write(&path, wav).map_err(err)?;
        Ok(Some(path.display().to_string()))
    }).await.map_err(err)?
}

#[tauri::command]
async fn start_app_session(s: State<'_, AppState>, app_id: String, mode: String, force: Option<bool>, wait_for_audio: Option<bool>, mute_playback: Option<bool>, format: Option<RecordingFormat>) -> Res<Value> {
    let mode = SummaryMode::parse(&mode).unwrap_or_default();
    let options = StartOptions {
        force: force.unwrap_or(false),
        wait_for_audio: wait_for_audio.unwrap_or(false),
        mute_playback: mute_playback.unwrap_or(true),
        format: format.unwrap_or_default(),
        ..Default::default()
    };
    s.engine
        .start_session_opts(SourceSpec::MacApp { app_id }, mode, None, options)
        .map(|(row, warnings)| json!({"session": row, "warnings": warnings}))
        .map_err(err)
}

/// Tab recordings are captured by the Chrome extension: it owns pause, playback and stop for
/// them, so those requests go to it (it forwards to this engine when it streams here).
fn tab_control(s: &AppState, id: &str, action: &str, extra: Value) -> Option<Res<()>> {
    s.browser_sources.recording(id)?;
    Some(if s.browser_sources.control(id, action, extra) { Ok(()) } else { Err("The browser is not responding. Try again from Chrome.".into()) })
}

#[tauri::command]
fn stop_session(s: State<AppState>, id: String) -> Res<()> {
    if let Some(done) = tab_control(&s, &id, "stop", json!({})) {
        return done;
    }
    s.engine.stop_session(&id, "user").map_err(err)
}

/// Stops a recording and discards it (asked for confirmation in the UI first).
#[tauri::command]
fn cancel_session(s: State<AppState>, id: String) -> Res<()> {
    if let Some(done) = tab_control(&s, &id, "cancel", json!({})) {
        return done;
    }
    s.engine.cancel_session(&id).map_err(err)
}

#[tauri::command]
fn pause_session(s: State<AppState>, id: String, paused: bool) -> Res<()> {
    if let Some(done) = tab_control(&s, &id, if paused { "pause" } else { "resume" }, json!({})) {
        return done;
    }
    s.engine.set_paused(&id, paused).map_err(err)
}

/// "Record silently" while recording: silences the source on the speakers, or plays it again.
#[tauri::command]
fn set_session_muted(s: State<AppState>, id: String, muted: bool) -> Res<()> {
    let action = if muted { "mute" } else { "unmute" };
    if let Some(done) = tab_control(&s, &id, action, json!({})) {
        return done;
    }
    // A tab recording always plays through the extension, even before Chrome reports its state.
    if s.engine.store.session(&id).map_err(err)?.is_some_and(|row| row.kind == "chromium_tab") {
        return if s.browser_sources.broadcast_control(&id, action) { Ok(()) } else {
            Err("Chrome is not connected to Multicorder. Reload the Multicorder extension in Chrome and try again.".into())
        };
    }
    s.engine.set_mute_playback(&id, muted).map_err(err)
}

#[tauri::command]
async fn load_recording_audio(s: State<'_, AppState>, id: String) -> Res<tauri::ipc::Response> {
    let engine = s.engine.clone();
    tauri::async_runtime::spawn_blocking(move || engine.audio_wav(&id))
        .await.map_err(err)?.map(tauri::ipc::Response::new).map_err(err)
}

#[tauri::command]
async fn load_paused_audio(s: State<'_, AppState>, id: String) -> Res<tauri::ipc::Response> {
    s.engine.paused_audio_wav(&id).await.map(tauri::ipc::Response::new).map_err(err)
}

#[tauri::command]
async fn export_recording_selection(s: State<'_, AppState>, app: tauri::AppHandle, id: String, start_ms: i64, end_ms: i64, name: Option<String>, title: Option<String>) -> Res<Option<String>> {
    let engine = s.engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let clock = |ms: i64| format!("{:02}.{:02}", ms / 60_000, (ms / 1000) % 60);
        let name = format!("{} ({}-{})", save_name(&engine, &id, name)?, clock(start_ms), clock(end_ms));
        let wav = engine.audio_wav_range(&id, start_ms, Some(end_ms)).map_err(err)?;
        let Some(path) = ask_save_path(&app, &name, "WAV", "wav", title)? else { return Ok(None) };
        std::fs::write(&path, wav).map_err(err)?;
        Ok(Some(path.display().to_string()))
    }).await.map_err(err)?
}

#[tauri::command]
fn recording_preview(s: State<AppState>, id: String) -> Res<RecordingPreview> {
    recording_files::preview(&s.engine, &id).map_err(err)
}

#[tauri::command]
async fn generate_recording_transcript(s: State<'_, AppState>, id: String) -> Res<Value> {
    if !s.engine.status().asr_ready {
        return Err("Configure a transcription API key in Settings first".into());
    }
    // Reuse the retry engine for audio-only recordings and any missed speech chunks.
    retry_asr(s, id).await
}

/// Replaces a recording's text (platform subtitles) with speech recognition of its audio.
#[tauri::command]
fn transcribe_with_asr(s: State<AppState>, id: String) -> Res<usize> {
    if !s.engine.status().asr_ready {
        return Err("Configure a transcription API key in Settings first".into());
    }
    s.engine.transcribe_with_asr(&id).map_err(err)
}

#[tauri::command]
async fn generate_recording_summary(s: State<'_, AppState>, id: String) -> Res<()> {
    s.engine.generate_summary(&id).await.map_err(err)
}

#[tauri::command]
fn copy_recording_text(s: State<AppState>, id: String, part: TextPart) -> Res<()> {
    let text = recording_files::text(&s.engine, &id, part).map_err(err)?;
    recording_files::copy(&text).map_err(err)
}

/// Asks where to save the transcript or summary and writes it there in `format`. Returns the
/// path, or `None` when the user cancels.
#[tauri::command]
async fn export_recording_text(s: State<'_, AppState>, app: tauri::AppHandle, id: String, part: TextPart, format: String, name: Option<String>, title: Option<String>) -> Res<Option<String>> {
    let engine = s.engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let format = TextFormat::parse(&format).ok_or("Unsupported text export format")?;
        let row = engine.store.session(&id).map_err(err)?.ok_or("Recording unavailable")?;
        let text = recording_files::text(&engine, &id, part).map_err(err)?;
        let heading = format!("{} - {}", row.title, part.label());
        let Some(path) = ask_save_path(&app, name.as_deref().unwrap_or(&heading), format.filter_name(), format.extension(), title)? else { return Ok(None) };
        recording_files::write_text(&path, format, &heading, &text).map_err(err)?;
        Ok(Some(path.display().to_string()))
    }).await.map_err(err)?
}

#[tauri::command]
fn set_mode(s: State<AppState>, id: String, mode: String) -> Res<()> {
    let m = SummaryMode::parse(&mode).ok_or("bad mode")?;
    match s.browser_sources.recording(&id) {
        Some(recording) if recording.backend == "local" => tab_control(&s, &id, "mode", json!({ "mode": m })).unwrap_or(Ok(())),
        _ => s.engine.set_mode(&id, m).map_err(err),
    }
}

#[tauri::command]
fn transcript(s: State<AppState>, id: String) -> Res<Value> {
    s.engine.transcript(&id).map(|v| json!(v)).map_err(err)
}

#[tauri::command]
fn insights(s: State<AppState>, id: String) -> Res<Value> {
    s.engine.insights(&id).map(|v| json!(v)).map_err(err)
}

#[tauri::command]
fn report(s: State<AppState>, id: String) -> Res<Value> {
    s.engine.store.report(&id).map(|v| json!(v)).map_err(err)
}

#[tauri::command]
async fn missed(s: State<'_, AppState>, id: String, minutes: i64) -> Res<Value> {
    s.engine.missed(&id, minutes).await.map(|v| json!(v)).map_err(err)
}

/// Asks where to save the transcript as Markdown, SRT, VTT or JSON and writes it there. Returns
/// the path, or `None` when the user cancels.
#[tauri::command]
async fn export(s: State<'_, AppState>, app: tauri::AppHandle, id: String, format: String, name: Option<String>, title: Option<String>) -> Res<Option<String>> {
    let engine = s.engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let f = ExportFormat::parse(&format).ok_or("bad format")?;
        let (extension, filter) = match f {
            ExportFormat::Markdown => ("md", "Markdown"),
            ExportFormat::Srt => ("srt", "SubRip subtitles"),
            ExportFormat::Vtt => ("vtt", "WebVTT subtitles"),
            ExportFormat::Json => ("json", "JSON"),
        };
        let name = save_name(&engine, &id, name)?;
        let (_, bytes) = engine.export(&id, f).map_err(err)?;
        let Some(path) = ask_save_path(&app, &name, filter, extension, title)? else { return Ok(None) };
        std::fs::write(&path, bytes).map_err(err)?;
        Ok(Some(path.display().to_string()))
    }).await.map_err(err)?
}

#[tauri::command]
fn add_marker(s: State<AppState>, id: String) -> Res<String> {
    s.engine.add_marker(&id, None).map_err(err)
}

#[tauri::command]
fn recording_markers(s: State<AppState>, id: String) -> Res<Value> {
    Ok(json!(s.engine.store.markers(&id).map_err(err)?))
}

/// Renames a recording; an empty name goes back to the source's title.
#[tauri::command]
fn rename_session(s: State<AppState>, id: String, name: Option<String>) -> Res<()> {
    if s.browser_sources.recording(&id).is_some_and(|r| r.backend == "local") {
        return tab_control(&s, &id, "rename", json!({ "name": name })).unwrap_or(Ok(()));
    }
    s.engine.store.set_name(&id, name.as_deref()).map_err(err)
}

#[tauri::command]
fn delete_session(s: State<AppState>, id: String) -> Res<()> {
    s.engine.delete_session(&id).map_err(err)
}

fn install_host() {
    let Ok(exe) = std::env::current_exe() else { return };
    let host = exe.with_file_name("multicorder-host");
    if host.exists() {
        let ids: Vec<String> = EXTENSION_IDS.iter().map(|s| s.to_string()).collect();
        match mc_local_api::runtime::install_native_host(&host, &ids) {
            Ok(files) => tracing::info!(n = files.len(), "native messaging host registered"),
            Err(e) => tracing::warn!(error = %e, "could not register native messaging host"),
        }
    }
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data = mc_core::default_data_dir();
            let rt = tauri::async_runtime::block_on(mc_local_api::runtime::start(&data, 0))?;
            install_host();
            let engine = rt.engine.clone();
            let port = rt.port;
            // Keep the runtime (API + pairing tasks) alive for the life of the app.
            app.manage(AppState { engine: engine.clone(), port, browser_sources: rt.browser_sources.clone() });
            app.manage(rt);
            let handle = app.handle().clone();
            let mut rx = engine.subscribe();
            tauri::async_runtime::spawn(async move {
                while let Ok(e) = rx.recv().await {
                    let _ = handle.emit("engine", &e);
                }
            });
            let show = MenuItem::with_id(app, "show", "Show Multicorder", true, None::<&str>)?;
            let stop = MenuItem::with_id(app, "stop_all", "Stop all recordings", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &stop, &quit])?;
            let eng = engine.clone();
            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().expect("icon"))
                .tooltip("Multicorder")
                .menu(&menu)
                .on_menu_event(move |app, ev| match ev.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "stop_all" => {
                        for s in eng.sessions(true).unwrap_or_default() {
                            let _ = eng.stop_session(&s.id, "user");
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps recording in the menu bar.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            status, ai_settings, save_ai_settings, list_apps, list_browser_sources, open_browser_source, app_icon, list_microphones, list_sessions, start_app_session, start_mic_session, stop_session, cancel_session, pause_session, set_session_muted, set_mode, transcript, insights, report, missed, export, add_marker, recording_markers, rename_session, delete_session, retry_asr, export_audio,
            load_recording_audio, load_paused_audio, export_recording_selection, recording_preview, generate_recording_transcript, transcribe_with_asr, generate_recording_summary, copy_recording_text, export_recording_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running Multicorder");
}
