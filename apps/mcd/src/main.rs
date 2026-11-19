//! `mcd` — Multicorder without a window.
//!
//!   mcd serve [--port N]                    engine + local API + pairing socket until Ctrl-C
//!   mcd apps                                apps currently known to Core Audio (JSON)
//!   mcd install-host --extension-id ID…     write native messaging host manifests
//!   mcd record-app APP_ID [--seconds N] [--mode live|after|off]
//!                                           record one app, then print transcript and report
//!
//! Data folder: $MC_DATA_DIR or ~/Library/Application Support/Multicorder.

use std::time::Duration;

use mc_core::{SourceSpec, SummaryMode};

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,mc=debug".into()))
        .with_writer(std::io::stderr)
        .init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let data = mc_core::default_data_dir();
    match args.first().map(String::as_str) {
        Some("serve") => {
            let port = arg(&args, "--port").and_then(|p| p.parse().ok()).unwrap_or(0);
            let rt = mc_local_api::runtime::start(&data, port).await?;
            println!("{}", serde_json::json!({"port": rt.port, "api_file": data.join("run/api.json"), "status": rt.engine.status()}));
            tokio::signal::ctrl_c().await?;
            for s in rt.engine.sessions(true)? {
                let _ = rt.engine.stop_session(&s.id, "shutdown");
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        Some("apps") => {
            let engine = mc_engine::Engine::start(&data)?;
            println!("{}", serde_json::to_string_pretty(&engine.list_apps()?)?);
        }
        Some("install-host") => {
            let ids: Vec<String> = args.windows(2).filter(|w| w[0] == "--extension-id").map(|w| w[1].clone()).collect();
            if ids.is_empty() {
                anyhow::bail!("pass at least one --extension-id");
            }
            let host = arg(&args, "--host-path").map(std::path::PathBuf::from).unwrap_or_else(|| {
                std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join("multicorder-host"))).unwrap_or_default()
            });
            for f in mc_local_api::runtime::install_native_host(&host, &ids)? {
                println!("{}", f.display());
            }
        }
        Some("record-app") => {
            let app = args.get(1).cloned().ok_or_else(|| anyhow::anyhow!("record-app APP_ID"))?;
            let secs: u64 = arg(&args, "--seconds").and_then(|s| s.parse().ok()).unwrap_or(15);
            let mode = arg(&args, "--mode").and_then(|m| SummaryMode::parse(&m)).unwrap_or(SummaryMode::Live);
            let engine = mc_engine::Engine::start(&data)?;
            let mut events = engine.subscribe();
            let s = engine.start_session(SourceSpec::MacApp { app_id: app }, mode, None)?;
            eprintln!("recording {} ({}) for {secs}s", s.title, s.id);
            let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
            while tokio::time::Instant::now() < deadline {
                if let Ok(Ok(e)) = tokio::time::timeout(Duration::from_millis(500), events.recv()).await {
                    if !matches!(e, mc_core::EngineEvent::Level { .. }) {
                        eprintln!("{}", serde_json::to_string(&e)?);
                    }
                }
            }
            engine.stop_session(&s.id, "user")?;
            engine.wait_finished(&s.id, Duration::from_secs(300)).await;
            let out = serde_json::json!({
                "session": engine.store.session(&s.id)?,
                "transcript": engine.transcript(&s.id)?,
                "insights": engine.insights(&s.id)?,
                "report": engine.store.report(&s.id)?,
                "gaps": engine.store.gaps(&s.id)?,
            });
            println!("{}", serde_json::to_string_pretty(&out)?);
        }
        _ => {
            eprintln!("usage: mcd serve [--port N] | apps | install-host --extension-id ID [--host-path P] | record-app APP_ID [--seconds N] [--mode live|after|off]");
            std::process::exit(2);
        }
    }
    Ok(())
}
