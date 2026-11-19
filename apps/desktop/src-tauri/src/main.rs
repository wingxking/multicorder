//! Multicorder desktop app (Tauri 2): hosts the engine, the local API for the extension and the
//! pairing socket; the React UI talks to the engine through commands and receives engine events.

use std::sync::Arc;

use mc_core::{SourceSpec, SummaryMode};
use mc_engine::{Engine, ExportFormat};
use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, State, WindowEvent};

/// Extension IDs allowed to pair (the published key and the unpacked development key).
const EXTENSION_IDS: &[&str] = &["ileogemoijmhcnkcbanfaiolhdhoffbj"];

struct AppState {
    engine: Arc<Engine>,
    port: u16,
}

type Res<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
fn status(s: State<AppState>) -> Value {
    let mut v = serde_json::to_value(s.engine.status()).unwrap_or_default();
    v["api_port"] = json!(s.port);
    v
}

#[tauri::command]
fn list_apps(s: State<AppState>) -> Res<Value> {
    s.engine.list_apps().map(|a| json!(a)).map_err(err)
}

#[tauri::command]
fn list_sessions(s: State<AppState>) -> Res<Value> {
    s.engine.sessions(false).map(|v| json!(v)).map_err(err)
}

#[tauri::command]
fn start_app_session(s: State<AppState>, app_id: String, mode: String) -> Res<Value> {
    let mode = SummaryMode::parse(&mode).unwrap_or_default();
    s.engine.start_session(SourceSpec::MacApp { app_id }, mode, None).map(|r| json!(r)).map_err(err)
}

#[tauri::command]
fn stop_session(s: State<AppState>, id: String) -> Res<()> {
    s.engine.stop_session(&id, "user").map_err(err)
}

#[tauri::command]
fn set_mode(s: State<AppState>, id: String, mode: String) -> Res<()> {
    let m = SummaryMode::parse(&mode).ok_or("bad mode")?;
    s.engine.set_mode(&id, m).map_err(err)
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

#[tauri::command]
fn export(s: State<AppState>, id: String, format: String) -> Res<String> {
    let f = ExportFormat::parse(&format).ok_or("bad format")?;
    let (_, bytes) = s.engine.export(&id, f).map_err(err)?;
    let downloads = std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join("Downloads")).unwrap_or_default();
    let path = downloads.join(format!("multicorder-{id}.{format}"));
    std::fs::write(&path, bytes).map_err(err)?;
    Ok(path.display().to_string())
}

#[tauri::command]
fn add_marker(s: State<AppState>, id: String) -> Res<String> {
    s.engine.add_marker(&id, None).map_err(err)
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
        .setup(|app| {
            let data = mc_core::default_data_dir();
            let rt = tauri::async_runtime::block_on(mc_local_api::runtime::start(&data, 0))?;
            install_host();
            let engine = rt.engine.clone();
            let port = rt.port;
            // Keep the runtime (API + pairing tasks) alive for the life of the app.
            app.manage(rt);
            app.manage(AppState { engine: engine.clone(), port });
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
            status, list_apps, list_sessions, start_app_session, stop_session, set_mode, transcript, insights, report, missed, export, add_marker, delete_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running Multicorder");
}
