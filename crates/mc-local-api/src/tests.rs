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

#[tokio::test]
async fn duplicate_browser_recording_is_a_409() {
    let (api, dir) = start().await;
    let base = format!("http://{}", api.addr);
    let c = reqwest::Client::new();
    let tab: Value = c
        .post(format!("{base}/v1/sessions"))
        .bearer_auth("secret-token")
        .json(&json!({"source": {"kind": "chromium_tab", "title": "T", "browser": "com.google.Chrome"}, "summary_mode": "off"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(tab["warnings"], json!([]));
    let r = c
        .post(format!("{base}/v1/sessions"))
        .bearer_auth("secret-token")
        .json(&json!({"source": {"kind": "mac_app", "app_id": "com.google.Chrome"}}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 409);
    let body: Value = r.json().await.unwrap();
    assert_eq!(body["code"], "duplicate_browser_tabs");
    std::fs::remove_dir_all(dir).ok();
}

struct FakeLlm;

#[async_trait::async_trait]
impl mc_insight::Llm for FakeLlm {
    async fn chat_json(&self, _system: &str, user: &str, _max: u32) -> anyhow::Result<(Value, mc_insight::Usage)> {
        Ok((json!({"echo": user}), mc_insight::Usage { provider: "fake".into(), model: "m".into(), input_tokens: 3, output_tokens: 4, usd: 0.0 }))
    }
}

fn tone_wav(secs: f32) -> Vec<u8> {
    let pcm: Vec<f32> = (0..(16_000.0 * secs) as usize).map(|i| (i as f32 * 0.07).sin() * 0.3).collect();
    mc_audio::encode_wav(&pcm).unwrap()
}

async fn start_with(asr: Option<Arc<dyn mc_asr::AsrAdapter>>, llm: Option<Arc<dyn mc_insight::Llm>>) -> (crate::Running, std::path::PathBuf, Arc<mc_engine::Engine>) {
    let dir = std::env::temp_dir().join(format!("mc-api-{}", mc_core::new_id()));
    let mut cfg = Config::default();
    // No key: when no adapter is injected the engine falls back to "unconfigured".
    cfg.asr.api_key_env = "MC_TEST_NO_SUCH_KEY".into();
    cfg.asr.api_key = String::new();
    let engine = mc_engine::Engine::start_with(&dir, cfg, asr, llm).unwrap();
    (crate::serve(engine.clone(), "secret-token".into(), 0).await.unwrap(), dir, engine)
}

#[tokio::test]
async fn transcription_and_chat_service() {
    let (api, dir, _) = start_with(Some(Arc::new(mc_asr::FakeAsr::default())), Some(Arc::new(FakeLlm))).await;
    let base = format!("http://{}", api.addr);
    let c = reqwest::Client::new();
    let r = c.post(format!("{base}/v1/asr/transcribe?lang=en")).bearer_auth("secret-token").header("Content-Type", "audio/wav").body(tone_wav(1.0)).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["engine"], "fake");
    assert_eq!(v["segments"][0]["end_ms"], 1000);
    assert!(v["segments"][0]["text"].as_str().unwrap().contains("1000"));
    // Too long and not a WAV.
    let long = c.post(format!("{base}/v1/asr/transcribe")).bearer_auth("secret-token").body(tone_wav(31.0)).send().await.unwrap();
    assert_eq!(long.status(), 413);
    let bad = c.post(format!("{base}/v1/asr/transcribe")).bearer_auth("secret-token").body("nope").send().await.unwrap();
    assert_eq!(bad.status(), 400);
    // Unauthenticated callers are refused.
    assert_eq!(c.post(format!("{base}/v1/asr/transcribe")).body(tone_wav(1.0)).send().await.unwrap().status(), 401);
    let chat: Value = c.post(format!("{base}/v1/llm/chat")).bearer_auth("secret-token").json(&json!({"system": "s", "user": "u", "max_tokens": 9999})).send().await.unwrap().json().await.unwrap();
    assert_eq!(chat["out"]["echo"], "u");
    assert_eq!(chat["usage"]["tokens"], 7);
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test]
async fn service_reports_unavailable_without_keys() {
    let (api, dir, _) = start_with(None, None).await;
    let base = format!("http://{}", api.addr);
    let c = reqwest::Client::new();
    let r = c.post(format!("{base}/v1/asr/transcribe")).bearer_auth("secret-token").body(tone_wav(1.0)).send().await.unwrap();
    assert_eq!(r.status(), 503);
    assert_eq!(r.json::<Value>().await.unwrap()["code"], "asr_unavailable");
    let r = c.post(format!("{base}/v1/llm/chat")).bearer_auth("secret-token").json(&json!({"system": "s", "user": "u"})).send().await.unwrap();
    assert_eq!(r.status(), 503);
    assert_eq!(r.json::<Value>().await.unwrap()["code"], "llm_unavailable");
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn retry_status_and_audio_export() {
    let (api, dir, engine) = start_with(Some(Arc::new(mc_asr::FakeAsr::default())), None).await;
    let base = format!("http://{}", api.addr);
    let c = reqwest::Client::new();
    let created: Value = c
        .post(format!("{base}/v1/sessions"))
        .bearer_auth("secret-token")
        .json(&json!({"source": {"kind": "chromium_tab", "title": "W"}, "summary_mode": "off"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = created["session"]["id"].as_str().unwrap().to_string();
    assert_eq!(created["session"]["summary_mode"], "off");
    // Default mode is live when not given.
    let live: Value = c.post(format!("{base}/v1/sessions")).bearer_auth("secret-token").json(&json!({"source": {"kind": "chromium_tab", "title": "L"}})).send().await.unwrap().json().await.unwrap();
    assert_eq!(live["session"]["summary_mode"], "live");
    c.post(format!("{base}/v1/sessions/{}/stop", live["session"]["id"].as_str().unwrap())).bearer_auth("secret-token").send().await.unwrap();
    // 2 s of tone, fed as tab frames.
    let pcm: Vec<i16> = (0..32_000).map(|i| (((i as f32) * 0.07).sin() * 9000.0) as i16).collect();
    for (seq, f) in pcm.chunks(1600).enumerate() {
        engine.ingest_tab_frame(&id, seq as u32, 0.0, f).unwrap();
    }
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    c.post(format!("{base}/v1/sessions/{id}/stop")).bearer_auth("secret-token").send().await.unwrap();
    for _ in 0..100 {
        let s: Value = c.get(format!("{base}/v1/sessions/{id}")).bearer_auth("secret-token").send().await.unwrap().json().await.unwrap();
        if s["session"]["status"] == "stopped" && !s["active"].as_bool().unwrap() {
            assert_eq!(s["asr"]["state"], "ok");
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let audio = c.get(format!("{base}/v1/sessions/{id}/audio")).bearer_auth("secret-token").send().await.unwrap();
    assert_eq!(audio.status(), 200);
    assert_eq!(audio.headers()["content-type"], "audio/wav");
    let bytes = audio.bytes().await.unwrap();
    assert_eq!(&bytes[..4], b"RIFF");
    assert!(bytes.len() > 60_000);
    let list: Value = c.get(format!("{base}/v1/sessions")).bearer_auth("secret-token").send().await.unwrap().json().await.unwrap();
    assert!(list.as_array().unwrap().iter().all(|r| r["asr"]["state"] == "ok"));
    let retry: Value = c.post(format!("{base}/v1/sessions/{id}/retry-asr")).bearer_auth("secret-token").send().await.unwrap().json().await.unwrap();
    assert_eq!(retry["queued"], 1);
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test]
async fn tab_inventory_keeps_parallel_sources_separate_and_routes_focus() {
    use futures::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

    let (api, dir) = start().await;
    let endpoint = format!("ws://{}/v1/browser-sources", api.addr);
    assert!(tokio_tungstenite::connect_async(&endpoint).await.is_err());

    let mut request = endpoint.into_client_request().unwrap();
    request.headers_mut().insert("Sec-WebSocket-Protocol", "mc.v1, secret-token".parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    let snapshot = json!({ "client_id": "chrome-fixture", "browser": "com.google.Chrome", "tabs": [
        {"id": 81, "title": "YouTube 1", "site": "www.youtube.com", "audible": true},
        {"id": 82, "title": "YouTube 1", "site": "www.youtube.com", "audible": true},
        {"id": 83, "title": "Bilibili 1", "site": "www.bilibili.com", "audible": true},
        {"id": 84, "title": "Bilibili 2", "site": "www.bilibili.com", "audible": true}
    ] });
    socket.send(Message::Text(snapshot.to_string().into())).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while api.browser_sources.list().len() != 4 {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }).await.unwrap();

    let list = serde_json::to_value(api.browser_sources.list()).unwrap();
    assert_ne!(list[0]["source_id"], list[1]["source_id"]);
    assert_eq!(list[0]["app"], "Google Chrome");
    assert_eq!(list[3]["title"], "Bilibili 2");
    let target = list[3]["source_id"].as_str().unwrap();
    api.browser_sources.focus(target, mc_core::SummaryMode::Off, true).unwrap();
    let response = tokio::time::timeout(std::time::Duration::from_secs(3), socket.next()).await.unwrap().unwrap().unwrap();
    assert_eq!(serde_json::from_str::<Value>(response.to_text().unwrap()).unwrap(),
        json!({"tab_id": 84, "mode": "off", "mute_playback": true}));

    let created: Value = reqwest::Client::new()
        .post(format!("http://{}/v1/sessions", api.addr)).bearer_auth("secret-token")
        .json(&json!({"source":{"kind":"chromium_tab","browser":"com.google.Chrome","tab_id":84}, "browser_client_id":"chrome-fixture","summary_mode":"off"}))
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(created["session"]["capture_source_id"], target);
    socket.close(None).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while !api.browser_sources.list().is_empty() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    api.task.abort();
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test]
async fn reconnecting_tab_resumes_from_the_session_position() {
    use futures::SinkExt;
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

    let (api, dir) = start().await;
    let created: Value = reqwest::Client::new()
        .post(format!("http://{}/v1/sessions", api.addr)).bearer_auth("secret-token")
        .json(&json!({"source": {"kind": "chromium_tab"}, "summary_mode": "off"}))
        .send().await.unwrap().json().await.unwrap();
    let endpoint = format!("ws://{}{}", api.addr, created["ingest_path"].as_str().unwrap());
    let connect = || async {
        let mut request = endpoint.clone().into_client_request().unwrap();
        request.headers_mut().insert("Sec-WebSocket-Protocol", "mc.v1, secret-token".parse().unwrap());
        tokio_tungstenite::connect_async(request).await.unwrap().0
    };
    let mut first = connect().await;
    assert_eq!(ws_hello(&mut first).await, 0);
    for seq in 0..5u32 {
        first.send(Message::Binary(crate::ws::encode_frame(seq, 0.0, &[1000; 1600]).into())).await.unwrap();
    }
    // Each frame is handled before the next message, so a hello after them sees all five.
    assert_eq!(ws_hello(&mut first).await, 5);
    first.close(None).await.unwrap();

    // A new connection must not report 0, or the client would resend its whole buffer.
    let mut second = connect().await;
    assert_eq!(ws_hello(&mut second).await, 5);
    second.close(None).await.unwrap();
    api.task.abort();
    std::fs::remove_dir_all(dir).ok();
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Sends `hello` on an ingest socket and returns the server's `next_seq`.
async fn ws_hello(socket: &mut Ws) -> u64 {
    use futures::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    socket.send(Message::Text(json!({"t": "hello"}).to_string().into())).await.unwrap();
    loop {
        let msg = tokio::time::timeout(std::time::Duration::from_secs(3), socket.next()).await.unwrap().unwrap().unwrap();
        let v: Value = serde_json::from_str(msg.to_text().unwrap()).unwrap();
        if v["t"] == "hello" {
            return v["next_seq"].as_u64().unwrap();
        }
    }
}
