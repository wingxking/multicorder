//! Native messaging host (design 4.11), modelled on Anarlog's `chrome-native-host` (MIT):
//! stdin/stdout framing is 4-byte little-endian length + JSON, max 256 KB. It only forwards
//! pairing requests to the app's Unix socket — no audio passes through here.
//!
//! Messages from the extension: {type:'hello'}, {type:'pair'}, {type:'launch_app'}.

use std::time::Duration;

use mc_local_api::pairing::{read_msg, socket_path, write_msg};
use serde_json::{json, Value};

const APP_BUNDLE_ID: &str = "com.multicorder.desktop";

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
    while let Some(msg) = read_msg(&mut stdin).await? {
        let reply = match msg["type"].as_str() {
            Some("hello") | Some("pair") => match ask_app(&msg).await {
                Ok(v) => v,
                Err(_) => json!({"type": msg["type"], "status": "app_not_running", "app_version": Value::Null}),
            },
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
