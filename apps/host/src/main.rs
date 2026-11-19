//! Native messaging host (design 4.11), modelled on Anarlog's `chrome-native-host` (MIT):
//! stdin/stdout framing is 4-byte little-endian length + JSON, max 256 KB. It only forwards
//! pairing requests to the app's Unix socket — no audio passes through here.
//!
//! Messages from the extension: {type:'hello'}, {type:'pair'}, {type:'launch_app'}.

use std::time::Duration;

use mc_local_api::pairing::{read_msg, socket_path, write_msg};
use serde_json::{json, Value};

const APP_BUNDLE_ID: &str = "com.multicorder.desktop";

/// Bundle id of the browser that launched this host (our parent process), so the app can avoid
/// recording that browser twice (design 4.4.1).
fn browser_bundle_id() -> Option<String> {
    let ppid = std::os::unix::process::parent_id() as i32;
    mc_capture_macos::grouping::identify(ppid).bundle_id
}

/// Adds the browser identity to replies the extension uses for pairing.
fn with_browser(mut reply: Value, browser: Option<&str>) -> Value {
    if let Value::Object(map) = &mut reply {
        map.insert("browser_bundle_id".into(), browser.map(|b| Value::String(b.into())).unwrap_or(Value::Null));
    }
    reply
}

async fn ask_app(msg: &Value) -> anyhow::Result<Value> {
    let path = socket_path(&mc_core::default_data_dir());
    let mut stream = tokio::net::UnixStream::connect(&path).await?;
    write_msg(&mut stream, msg).await?;
    read_msg(&mut stream).await?.ok_or_else(|| anyhow::anyhow!("app closed the connection"))
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    let mut stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let browser = browser_bundle_id();
    while let Some(msg) = read_msg(&mut stdin).await? {
        let reply = match msg["type"].as_str() {
            Some("hello") | Some("pair") => with_browser(
                match ask_app(&msg).await {
                    Ok(v) => v,
                    Err(_) => json!({"type": msg["type"], "status": "app_not_running", "app_version": Value::Null}),
                },
                browser.as_deref(),
            ),
            Some("launch_app") => {
                let _ = std::process::Command::new("open").args(["-b", APP_BUNDLE_ID]).status();
                let mut status = "app_not_running";
                for _ in 0..40 {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    if ask_app(&json!({"type": "hello"})).await.is_ok() {
                        status = "ready";
                        break;
                    }
                }
                json!({"type": "launch_app", "status": status})
            }
            _ => json!({"type": "error", "error": "unknown message"}),
        };
        write_msg(&mut stdout, &reply).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replies_carry_the_browser() {
        let r = with_browser(json!({"type": "paired", "port": 1, "token": "t"}), Some("com.google.Chrome"));
        assert_eq!(r["browser_bundle_id"], "com.google.Chrome");
        assert_eq!(r["port"], 1);
        assert!(with_browser(json!({"type": "hello"}), None)["browser_bundle_id"].is_null());
    }

    #[test]
    fn parent_identity_resolves() {
        // Under `cargo test` the parent is cargo; the call must not panic.
        let _ = browser_bundle_id();
    }
}
