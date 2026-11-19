use std::sync::Arc;

use mc_core::config::Config;
use serde_json::{json, Value};

async fn start() -> (crate::Running, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("mc-api-{}", mc_core::new_id()));
    let engine = mc_engine::Engine::start_with(&dir, Config::default(), Some(Arc::new(mc_asr::FakeAsr::default())), None).unwrap();
    (crate::serve(engine, "secret-token".into(), 0).await.unwrap(), dir)
}

#[tokio::test]
async fn auth_origin_and_session_flow() {
    let (api, dir) = start().await;
    let base = format!("http://{}", api.addr);
    let c = reqwest::Client::new();
    assert_eq!(c.get(format!("{base}/v1/health")).send().await.unwrap().status(), 200);
    assert_eq!(c.get(format!("{base}/v1/status")).send().await.unwrap().status(), 401);
    let web = c.get(format!("{base}/v1/status")).header("Origin", "https://evil.example").bearer_auth("secret-token").send().await.unwrap();
    assert_eq!(web.status(), 403);
    let ok = c.get(format!("{base}/v1/status")).header("Origin", "chrome-extension://abcdef").bearer_auth("secret-token").send().await.unwrap();
    assert_eq!(ok.status(), 200);
    assert_eq!(ok.headers()["access-control-allow-origin"], "chrome-extension://abcdef");

    let created: Value = c
        .post(format!("{base}/v1/sessions"))
        .bearer_auth("secret-token")
        .json(&json!({"source": {"kind": "chromium_tab", "url": "https://example.com", "title": "T"}, "summary_mode": "off"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = created["session"]["id"].as_str().unwrap().to_string();
    let list: Value = c.get(format!("{base}/v1/sessions?status=active")).bearer_auth("secret-token").send().await.unwrap().json().await.unwrap();
    assert_eq!(list.as_array().unwrap().len(), 1);
    let ticket: Value = c.post(format!("{base}/v1/sse-ticket")).bearer_auth("secret-token").send().await.unwrap().json().await.unwrap();
    let t = ticket["ticket"].as_str().unwrap();
    let sse = c.get(format!("{base}/v1/events?t={t}")).send().await.unwrap();
    assert_eq!(sse.status(), 200);
    // A ticket is single-use.
    assert_eq!(c.get(format!("{base}/v1/events?t={t}")).send().await.unwrap().status(), 401);
    assert_eq!(c.post(format!("{base}/v1/sessions/{id}/stop")).bearer_auth("secret-token").send().await.unwrap().status(), 200);
    std::fs::remove_dir_all(dir).ok();
}
