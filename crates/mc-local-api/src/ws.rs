//! WebSocket audio ingest (protocol v1, design 6.1–6.2).
//!
//! Binary frame: `MCA1` | seq u32 LE | t_ms f64 LE | samples u16 LE | flags u16 LE | PCM16 LE mono 16 kHz.
//! Text frames: `{t:'hello', resume_from?}`, `{t:'media_mark', …}`, `{t:'navigation', …}`, `{t:'stop'}`.
//! Server → client: `{t:'hello', next_seq}` and `{t:'ack', upto_seq}` about once a second.

use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::response::Response;
use serde::Deserialize;
use serde_json::json;

use crate::ApiState;

pub const HEADER_LEN: usize = 20;

#[derive(Debug, PartialEq)]
pub struct Frame<'a> {
    pub seq: u32,
    pub t_ms: f64,
    pub pcm: Vec<i16>,
    pub flags: u16,
    _raw: std::marker::PhantomData<&'a ()>,
}

pub fn parse_frame(b: &[u8]) -> Option<Frame<'_>> {
    if b.len() < HEADER_LEN || &b[0..4] != b"MCA1" {
        return None;
    }
    let seq = u32::from_le_bytes(b[4..8].try_into().ok()?);
    let t_ms = f64::from_le_bytes(b[8..16].try_into().ok()?);
    let samples = u16::from_le_bytes(b[16..18].try_into().ok()?) as usize;
    let flags = u16::from_le_bytes(b[18..20].try_into().ok()?);
    let body = &b[HEADER_LEN..];
    if body.len() != samples * 2 || samples == 0 || samples > 16_000 {
        return None;
    }
    let pcm = body.as_chunks::<2>().0.iter().map(|c| i16::from_le_bytes([c[0], c[1]])).collect();
    Some(Frame { seq, t_ms, pcm, flags, _raw: Default::default() })
}

#[cfg(test)]
pub fn encode_frame(seq: u32, t_ms: f64, pcm: &[i16]) -> Vec<u8> {
    let mut b = Vec::with_capacity(HEADER_LEN + pcm.len() * 2);
    b.extend_from_slice(b"MCA1");
    b.extend_from_slice(&seq.to_le_bytes());
    b.extend_from_slice(&t_ms.to_le_bytes());
    b.extend_from_slice(&(pcm.len() as u16).to_le_bytes());
    b.extend_from_slice(&0u16.to_le_bytes());
    for s in pcm {
        b.extend_from_slice(&s.to_le_bytes());
    }
    b
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
enum Control {
    Hello {
        #[allow(dead_code)]
        resume_from: Option<u32>,
    },
    MediaMark {
        wall_ms: f64,
        media_ms: Option<f64>,
        #[serde(default)]
        paused: bool,
        #[serde(default = "one")]
        rate: f64,
        #[serde(default)]
        live: bool,
        video_key: Option<String>,
    },
    Navigation {
        url: Option<String>,
        title: Option<String>,
    },
    Stop {
        reason: Option<String>,
    },
    /// One subtitle line from the page, timed by the browser's wall clock.
    Caption {
        wall_ms: f64,
        dur_ms: f64,
        text: String,
        source: mc_core::CaptionSource,
    },
    /// Whether subtitles are playing right now (sent about once a second), and the text policy.
    CaptionState {
        active: bool,
        source: Option<mc_core::CaptionSource>,
        policy: Option<String>,
    },
}

fn one() -> f64 {
    1.0
}

pub async fn ingest(State(state): State<ApiState>, Path(id): Path<String>, ws: WebSocketUpgrade) -> Response {
    ws.protocols(["mc.v1"]).max_message_size(256 * 1024).on_upgrade(move |socket| run(state, id, socket))
}

async fn run(state: ApiState, id: String, mut socket: WebSocket) {
    let engine = state.engine.clone();
    if !engine.is_active(&id) {
        let _ = socket.send(Message::Text(json!({"t": "close", "reason": "session_not_active"}).to_string().into())).await;
        return;
    }
    let mut last_ack = Instant::now();
    let mut upto: Option<u32> = None;
    let mut frames_this_sec = 0u32;
    let mut sec_start = Instant::now();
    loop {
        let msg = match tokio::time::timeout(Duration::from_secs(30), socket.recv()).await {
            Ok(Some(Ok(m))) => m,
            Ok(Some(Err(_))) | Ok(None) => break,
            Err(_) => {
                if !engine.is_active(&id) {
                    break;
                }
                continue;
            }
        };
        match msg {
            Message::Binary(bytes) => {
                if sec_start.elapsed() >= Duration::from_secs(1) {
                    sec_start = Instant::now();
                    frames_this_sec = 0;
                }
                frames_this_sec += 1;
                // Live is 10 frames/s; resend after a reconnect may burst, cap generously.
                if frames_this_sec > 400 {
                    continue;
                }
                let Some(f) = parse_frame(&bytes) else { continue };
                match engine.ingest_tab_frame(&id, f.seq, f.t_ms, &f.pcm) {
                    Ok(s) => upto = Some(s),
                    Err(_) => {
                        let _ = socket.send(Message::Text(json!({"t": "close", "reason": "session_not_active"}).to_string().into())).await;
                        break;
                    }
                }
            }
            Message::Text(text) => match serde_json::from_str::<Control>(&text) {
                Ok(Control::Hello { .. }) => {
                    let next = upto.map(|u| u + 1).unwrap_or(0);
                    let _ = socket.send(Message::Text(json!({"t": "hello", "next_seq": next, "protocol": crate::PROTOCOL}).to_string().into())).await;
                }
                Ok(Control::MediaMark { wall_ms, media_ms, paused, rate, live, video_key }) => {
                    let _ = engine.media_mark(&id, wall_ms, media_ms.map(|m| m as i64), paused, rate, live, video_key);
                }
                Ok(Control::Navigation { url, title }) => {
                    let _ = engine.navigation(&id, url, title);
                }
                Ok(Control::Caption { wall_ms, dur_ms, text, source }) => {
                    let _ = engine.caption(&id, wall_ms, dur_ms, &text, source);
                }
                Ok(Control::CaptionState { active, source, policy }) => {
                    let _ = engine.caption_state(&id, active, source, policy.as_deref());
                }
                Ok(Control::Stop { reason }) => {
                    let _ = if reason.as_deref() == Some(mc_engine::CANCELLED) { engine.cancel_session(&id) } else { engine.stop_session(&id, "user") };
                    break;
                }
                Err(_) => {}
            },
            Message::Close(_) => break,
            _ => {}
        }
        if last_ack.elapsed() >= Duration::from_secs(1) {
            last_ack = Instant::now();
            if let Some(u) = upto {
                if socket.send(Message::Text(json!({"t": "ack", "upto_seq": u}).to_string().into())).await.is_err() {
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_round_trip() {
        let pcm: Vec<i16> = (0..1600).map(|i| i as i16).collect();
        let b = encode_frame(7, 1234.5, &pcm);
        let f = parse_frame(&b).unwrap();
        assert_eq!(f.seq, 7);
        assert_eq!(f.t_ms, 1234.5);
        assert_eq!(f.pcm, pcm);
        assert!(parse_frame(&b[..10]).is_none());
        let mut bad = b.clone();
        bad[0] = b'X';
        assert!(parse_frame(&bad).is_none());
    }
}
