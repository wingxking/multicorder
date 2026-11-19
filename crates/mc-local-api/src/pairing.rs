//! Pairing for the native messaging host (design 4.11): a Unix socket, owner-only, that hands out the
//! API port and token. Framing matches Chrome native messaging: 4-byte little-endian length + JSON.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const MAX_MESSAGE: usize = 256 * 1024;

pub fn socket_path(data_dir: &Path) -> PathBuf {
    data_dir.join("run").join("host.sock")
}

pub async fn read_msg<R: AsyncReadExt + Unpin>(r: &mut R) -> anyhow::Result<Option<Value>> {
    let mut len = [0u8; 4];
    if r.read_exact(&mut len).await.is_err() {
        return Ok(None);
    }
    let n = u32::from_le_bytes(len) as usize;
    if n > MAX_MESSAGE {
        anyhow::bail!("message too large: {n}");
    }
    let mut buf = vec![0u8; n];
    r.read_exact(&mut buf).await?;
    Ok(Some(serde_json::from_slice(&buf)?))
}

pub async fn write_msg<W: AsyncWriteExt + Unpin>(w: &mut W, v: &Value) -> anyhow::Result<()> {
    let b = serde_json::to_vec(v)?;
    w.write_all(&(b.len() as u32).to_le_bytes()).await?;
    w.write_all(&b).await?;
    w.flush().await?;
    Ok(())
}

/// Serves pairing requests until the task is dropped. Also writes `run/api.json` (owner-only)
/// for local tools.
pub async fn serve(data_dir: &Path, port: u16, token: String) -> anyhow::Result<tokio::task::JoinHandle<()>> {
    let run = data_dir.join("run");
    std::fs::create_dir_all(&run)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&run, std::fs::Permissions::from_mode(0o700))?;
    }
    let api = run.join("api.json");
    std::fs::write(&api, serde_json::to_vec(&json!({"port": port, "token": token, "pid": std::process::id()}))?)?;
    mc_core::config::set_private(&api);
    let path = socket_path(data_dir);
    let _ = std::fs::remove_file(&path);
    let listener = tokio::net::UnixListener::bind(&path)?;
    mc_core::config::set_private(&path);
    Ok(tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else { continue };
            let token = token.clone();
            tokio::spawn(async move {
                while let Ok(Some(msg)) = read_msg(&mut stream).await {
                    let reply = match msg["type"].as_str() {
                        Some("pair") => json!({"type": "paired", "port": port, "token": token}),
                        Some("hello") => json!({"type": "hello", "app_version": env!("CARGO_PKG_VERSION"), "protocol": crate::PROTOCOL, "status": "ready"}),
                        _ => json!({"type": "error", "error": "unknown message"}),
                    };
                    if write_msg(&mut stream, &reply).await.is_err() {
                        break;
                    }
                }
            });
        }
    }))
}
