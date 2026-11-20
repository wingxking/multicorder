//! Everything a host process needs: engine + local API + pairing socket. Used by the desktop app
//! and by `mcd`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use mc_engine::Engine;
use serde_json::json;

pub struct Runtime {
    pub engine: Arc<Engine>,
    pub port: u16,
    pub token: String,
    pub browser_sources: Arc<crate::BrowserSources>,
    _api: tokio::task::JoinHandle<()>,
    _pairing: tokio::task::JoinHandle<()>,
}

pub async fn start(data_dir: &Path, port: u16) -> anyhow::Result<Runtime> {
    let engine = Engine::start(data_dir)?;
    start_with_engine(engine, data_dir, port).await
}

pub async fn start_with_engine(engine: Arc<Engine>, data_dir: &Path, port: u16) -> anyhow::Result<Runtime> {
    let token = crate::new_token();
    let running = crate::serve(engine.clone(), token.clone(), port).await?;
    let pairing = crate::pairing::serve(data_dir, running.addr.port(), token.clone()).await?;
    Ok(Runtime { engine, port: running.addr.port(), token, browser_sources: running.browser_sources, _api: running.task, _pairing: pairing })
}

pub const HOST_NAME: &str = "com.multicorder.host";

/// Browser folders that hold native messaging host manifests on macOS.
pub fn host_manifest_dirs() -> Vec<PathBuf> {
    let Some(base) = dirs_home().map(|h| h.join("Library/Application Support")) else { return vec![] };
    [
        "Google/Chrome",
        "Google/Chrome Beta",
        "Google/Chrome for Testing",
        "Chromium",
        "Microsoft Edge",
        "BraveSoftware/Brave-Browser",
        "Arc/User Data",
    ]
    .iter()
    .map(|b| base.join(b).join("NativeMessagingHosts"))
    .collect()
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Writes the host manifest into every installed browser's folder. Returns the files written.
pub fn install_native_host(host_binary: &Path, extension_ids: &[String]) -> anyhow::Result<Vec<PathBuf>> {
    let manifest = json!({
        "name": HOST_NAME,
        "description": "Multicorder pairing host",
        "path": host_binary,
        "type": "stdio",
        "allowed_origins": extension_ids.iter().map(|id| format!("chrome-extension://{id}/")).collect::<Vec<_>>(),
    });
    let mut written = vec![];
    for dir in host_manifest_dirs() {
        // Only for browsers that exist (their support folder is present).
        if dir.parent().is_some_and(|p| p.exists()) {
            std::fs::create_dir_all(&dir)?;
            let file = dir.join(format!("{HOST_NAME}.json"));
            std::fs::write(&file, serde_json::to_vec_pretty(&manifest)?)?;
            written.push(file);
        }
    }
    Ok(written)
}
