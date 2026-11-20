//! Volatile tab inventory, focus requests and live tab-recording sync over the authenticated
//! loopback API. The extension captures every tab recording itself, so it reports their state
//! here (`{t:"recordings"}`, a few times a second) and takes control requests back
//! (`{t:"control"}`): pause, resume, mute, stop, mode and rename work from either side.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use mc_core::{EngineEvent, SummaryMode};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::ApiState;

#[derive(Clone, Serialize)]
pub struct BrowserSource {
    source_id: String,
    bundle_id: Option<String>,
    app: String,
    title: String,
    site: String,
    audible: bool,
    standalone_recording: bool,
    ordinal: usize,
    /// The tab's recording, when the extension is recording it.
    recording: Option<TabRecording>,
}

/// A tab recording as the extension reports it. `backend` is `local` when the browser processes
/// it (this app has no session for it) or `app` when it streams to this app.
#[derive(Clone, Serialize, Deserialize)]
pub struct TabRecording {
    pub tab_id: i64,
    pub session_id: String,
    pub backend: String,
    pub status: String,
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub mode: Option<SummaryMode>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub started_at: String,
    #[serde(default)]
    pub elapsed_ms: i64,
    #[serde(default)]
    pub level_db: Option<f32>,
    #[serde(default, skip_serializing)]
    peaks: Vec<f32>,
}

#[derive(Deserialize)]
struct RecordingsUpdate {
    recordings: Vec<TabRecording>,
}

#[derive(Deserialize)]
struct Tab {
    id: i64,
    title: String,
    site: String,
    audible: bool,
    #[serde(default)]
    standalone_recording: bool,
}

#[derive(Deserialize)]
struct Snapshot {
    client_id: String,
    browser: Option<String>,
    tabs: Vec<Tab>,
}

#[derive(Serialize)]
struct Focus {
    tab_id: i64,
    mode: SummaryMode,
    mute_playback: bool,
}

struct Connection {
    sources: Vec<(i64, BrowserSource)>,
    recordings: Vec<TabRecording>,
    outgoing: mpsc::Sender<serde_json::Value>,
}

#[derive(Default)]
pub struct BrowserSources {
    next_id: AtomicU64,
    connections: Mutex<HashMap<u64, Connection>>,
}

impl BrowserSources {
    pub fn list(&self) -> Vec<BrowserSource> {
        let connections = self.connections.lock().unwrap();
        let mut unique = HashMap::new();
        for connection in connections.values() {
            for (tab_id, source) in &connection.sources {
                let mut source = source.clone();
                source.recording = connection.recordings.iter().find(|r| r.tab_id == *tab_id).cloned();
                source.standalone_recording |= source.recording.as_ref().is_some_and(|r| r.backend == "local");
                unique.insert(source.source_id.clone(), source);
            }
        }
        let mut sources: Vec<_> = unique.into_values().collect();
        sources.sort_by(|a, b| {
            (&a.app, a.ordinal, &a.source_id).cmp(&(&b.app, b.ordinal, &b.source_id))
        });
        sources
    }

    pub fn focus(
        &self,
        source_id: &str,
        mode: SummaryMode,
        mute_playback: bool,
    ) -> anyhow::Result<Option<String>> {
        let connections = self.connections.lock().unwrap();
        for connection in connections.values() {
            if let Some((tab_id, source)) = connection
                .sources
                .iter()
                .find(|(_, source)| source.source_id == source_id)
            {
                let focus = Focus { tab_id: *tab_id, mode, mute_playback };
                if connection
                    .outgoing
                    .try_send(serde_json::to_value(focus).unwrap_or_default())
                    .is_ok()
                {
                    return Ok(source.bundle_id.clone());
                }
            }
        }
        anyhow::bail!("This browser tab is no longer connected")
    }

    /// The live state of a tab recording the extension is capturing, if any.
    pub fn recording(&self, session_id: &str) -> Option<TabRecording> {
        let connections = self.connections.lock().unwrap();
        connections.values().flat_map(|c| c.recordings.iter()).find(|r| r.session_id == session_id).cloned()
    }

    /// Sends a control request to every connected browser; only the one capturing `session_id`
    /// acts on it. For tab recordings whose live state has not been reported (yet). Returns
    /// false when no browser is connected.
    pub fn broadcast_control(&self, session_id: &str, action: &str) -> bool {
        let connections = self.connections.lock().unwrap();
        let message = serde_json::json!({ "t": "control", "action": action, "session_id": session_id });
        connections.values().filter(|c| c.outgoing.try_send(message.clone()).is_ok()).count() > 0
    }

    /// Asks the extension that captures `session_id` to `pause`, `resume`, `mute`, `unmute`,
    /// `stop`, change `mode` or `rename` it. Returns false when no connected browser has it.
    pub fn control(&self, session_id: &str, action: &str, extra: serde_json::Value) -> bool {
        let connections = self.connections.lock().unwrap();
        for connection in connections.values() {
            if let Some(recording) = connection.recordings.iter().find(|r| r.session_id == session_id) {
                let mut message = serde_json::json!({ "t": "control", "action": action, "session_id": session_id, "tab_id": recording.tab_id });
                if let (Some(target), serde_json::Value::Object(fields)) = (message.as_object_mut(), extra) {
                    target.extend(fields);
                }
                return connection.outgoing.try_send(message).is_ok();
            }
        }
        false
    }
}

pub(crate) async fn upgrade(State(state): State<ApiState>, ws: WebSocketUpgrade) -> Response {
    ws.protocols(["mc.v1"])
        .max_message_size(512 * 1024)
        .on_upgrade(move |socket| run(state, socket))
}

async fn run(state: ApiState, mut socket: WebSocket) {
    let registry = &state.browser_sources;
    let id = registry.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, mut rx) = mpsc::channel::<serde_json::Value>(16);
    let idle = Duration::from_secs(45);
    let expiry = tokio::time::sleep(idle);
    tokio::pin!(expiry);
    loop {
        tokio::select! {
            _ = &mut expiry => break,
            received = socket.recv() => {
                let Some(Ok(Message::Text(data))) = received else { break; };
                if data.starts_with("{\"t\":\"recordings\"") {
                    let Ok(update) = serde_json::from_str::<RecordingsUpdate>(&data) else { break; };
                    let mut connections = registry.connections.lock().unwrap();
                    let Some(connection) = connections.get_mut(&id) else { continue; };
                    let recordings: Vec<TabRecording> = update.recordings.into_iter().take(64).collect();
                    for recording in recordings.iter().filter(|r| r.backend == "local") {
                        // This app has no engine session for browser-processed recordings: replay
                        // their meter, waveform and status as engine events for the UI.
                        let previous = connection.recordings.iter().find(|r| r.session_id == recording.session_id);
                        if previous.map(|p| p.status.as_str()) != Some(recording.status.as_str()) {
                            state.engine.emit(EngineEvent::Status { session_id: recording.session_id.clone(), status: recording.status.clone(), detail: None });
                        }
                        if let Some(rms_db) = recording.level_db {
                            state.engine.emit(EngineEvent::Level { session_id: recording.session_id.clone(), rms_db, silent: rms_db < -60.0 });
                        }
                        if !recording.peaks.is_empty() {
                            state.engine.emit(EngineEvent::Waveform { session_id: recording.session_id.clone(), peaks: recording.peaks.iter().take(400).copied().collect(), audio_ms: recording.elapsed_ms });
                        }
                    }
                    for gone in connection.recordings.iter().filter(|r| r.backend == "local" && !recordings.iter().any(|n| n.session_id == r.session_id)) {
                        state.engine.emit(EngineEvent::Status { session_id: gone.session_id.clone(), status: "stopped".into(), detail: None });
                    }
                    connection.recordings = recordings;
                    expiry.as_mut().reset(tokio::time::Instant::now() + idle);
                    continue;
                }
                let Ok(snapshot) = serde_json::from_str::<Snapshot>(&data) else { break; };
                if snapshot.client_id.is_empty() || snapshot.client_id.len() > 64 ||
                    !snapshot.client_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') {
                    break;
                }
                let browser = snapshot.browser.filter(|name| name.len() <= 128);
                let app = browser_label(browser.as_deref());
                let sources = snapshot.tabs.into_iter().take(1000).enumerate().map(|(i, tab)| {
                    let source_id = mc_core::chromium_source_id(browser.as_deref(), tab.id, Some(&snapshot.client_id));
                    (tab.id, BrowserSource { source_id, app: app.into(), bundle_id: browser.clone(),
                        title: tab.title.chars().take(240).collect(), site: tab.site.chars().take(128).collect(),
                        audible: tab.audible, standalone_recording: tab.standalone_recording, ordinal: i + 1, recording: None })
                }).collect();
                let mut connections = registry.connections.lock().unwrap();
                let recordings = connections.remove(&id).map(|c| c.recordings).unwrap_or_default();
                connections.insert(id, Connection { sources, recordings, outgoing: tx.clone() });
                drop(connections);
                expiry.as_mut().reset(tokio::time::Instant::now() + idle);
            }
            Some(request) = rx.recv() => {
                let Ok(data) = serde_json::to_string(&request) else { continue; };
                if !matches!(tokio::time::timeout(Duration::from_secs(3), socket.send(Message::Text(data.into()))).await, Ok(Ok(()))) {
                    break;
                }
            }
        }
    }
    if let Some(connection) = registry.connections.lock().unwrap().remove(&id) {
        for gone in connection.recordings.iter().filter(|r| r.backend == "local") {
            state.engine.emit(EngineEvent::Status { session_id: gone.session_id.clone(), status: "stopped".into(), detail: None });
        }
    }
}

fn browser_label(bundle: Option<&str>) -> &'static str {
    match bundle.unwrap_or_default().to_ascii_lowercase().as_str() {
        "com.google.chrome.beta" => "Google Chrome Beta",
        "com.google.chrome.canary" => "Google Chrome Canary",
        "com.google.chrome.for.testing" => "Google Chrome for Testing",
        "com.microsoft.edgemac" => "Microsoft Edge",
        "com.brave.browser" => "Brave",
        "company.thebrowser.browser" => "Arc",
        "org.chromium.chromium" => "Chromium",
        _ => "Google Chrome",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recording(session_id: &str, backend: &str) -> TabRecording {
        TabRecording {
            tab_id: 7, session_id: session_id.into(), backend: backend.into(), status: "capturing".into(), paused: false, muted: true,
            mode: None, title: "Talk".into(), started_at: String::new(), elapsed_ms: 1200, level_db: None, peaks: vec![],
        }
    }

    #[test]
    fn controls_reach_the_browser_that_captures_the_recording() {
        let registry = BrowserSources::default();
        let (tx, mut rx) = mpsc::channel(4);
        let source = BrowserSource {
            source_id: "s".into(), bundle_id: None, app: "Google Chrome".into(), title: "Talk".into(), site: "example.com".into(),
            audible: true, standalone_recording: false, ordinal: 1, recording: None,
        };
        registry.connections.lock().unwrap().insert(1, Connection { sources: vec![(7, source)], recordings: vec![recording("abc", "local")], outgoing: tx });

        assert!(registry.recording("abc").is_some_and(|r| r.muted));
        let listed = registry.list();
        assert!(listed[0].standalone_recording, "browser-processed recordings count as recording in the browser");
        assert_eq!(listed[0].recording.as_ref().map(|r| r.session_id.as_str()), Some("abc"));

        assert!(registry.control("abc", "mode", serde_json::json!({ "mode": "after" })));
        let sent = rx.try_recv().unwrap();
        assert_eq!((sent["t"].as_str(), sent["action"].as_str(), sent["tab_id"].as_i64(), sent["mode"].as_str()), (Some("control"), Some("mode"), Some(7), Some("after")));

        assert!(!registry.control("unknown", "pause", serde_json::json!({})));
        assert!(registry.recording("unknown").is_none());
    }

    #[test]
    fn recordings_update_parses_extension_reports() {
        let update: RecordingsUpdate = serde_json::from_str(r#"{"t":"recordings","recordings":[{"tab_id":3,"session_id":"x","backend":"app","status":"paused","paused":true,"muted":false,"mode":"live","title":"T","started_at":"2026-11-20T00:00:00Z","elapsed_ms":5000,"level_db":-30.5,"peaks":[0.1,0.2]}]}"#).unwrap();
        let r = &update.recordings[0];
        assert_eq!((r.tab_id, r.paused, r.elapsed_ms, r.peaks.len()), (3, true, 5000, 2));
        assert_eq!(r.mode, Some(SummaryMode::Live));
    }
}
