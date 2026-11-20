//! Volatile tab inventory and focus requests over the authenticated loopback API.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use mc_core::SummaryMode;
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
    focus: mpsc::Sender<Focus>,
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
            for (_, source) in &connection.sources {
                unique.insert(&source.source_id, source);
            }
        }
        let mut sources: Vec<_> = unique.into_values().cloned().collect();
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
                if connection
                    .focus
                    .try_send(Focus {
                        tab_id: *tab_id,
                        mode,
                        mute_playback,
                    })
                    .is_ok()
                {
                    return Ok(source.bundle_id.clone());
                }
            }
        }
        anyhow::bail!("This browser tab is no longer connected")
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
    let (tx, mut rx) = mpsc::channel(8);
    let idle = Duration::from_secs(45);
    let expiry = tokio::time::sleep(idle);
    tokio::pin!(expiry);
    loop {
        tokio::select! {
            _ = &mut expiry => break,
            received = socket.recv() => {
                let Some(Ok(Message::Text(data))) = received else { break; };
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
                        audible: tab.audible, standalone_recording: tab.standalone_recording, ordinal: i + 1 })
                }).collect();
                registry.connections.lock().unwrap().insert(id, Connection { sources, focus: tx.clone() });
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
    registry.connections.lock().unwrap().remove(&id);
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
