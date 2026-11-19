//! Per-app audio capture on macOS with Core Audio process taps (design 4.3–4.4).
//!
//! Adapted from: Fader (MIT, pantafive) for process grouping, polling and tap rebuilds;
//! AudioCap (BSD-2, Guilherme Rambo) for the tap/aggregate sequence; Anarlog (MIT, Fastrepl)
//! for the cidre IO proc. See THIRD_PARTY_NOTICES.md.

use serde::Serialize;

pub mod grouping;
#[cfg(target_os = "macos")]
mod tap;
#[cfg(target_os = "macos")]
mod capture;
#[cfg(target_os = "macos")]
mod mic;

#[cfg(target_os = "macos")]
pub use capture::{AppCapture, CaptureEvent, EventSink, AudioSink};
#[cfg(target_os = "macos")]
pub use mic::{list_microphones, microphone, MicCapture};

#[derive(Debug, Clone, Serialize)]
pub struct MicrophoneInfo {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub channel: Option<u32>,
}

/// Prefix of every aggregate device we create: device lists filter it, startup cleanup uses it.
pub const DEVICE_PREFIX: &str = "Multicorder-";

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AppAudioInfo {
    /// Bundle id, or `pid:<n>` for a process outside any app bundle.
    pub app_id: String,
    pub bundle_id: Option<String>,
    pub name: String,
    pub bundle_path: Option<String>,
    pub pids: Vec<i32>,
    /// Core Audio process object ids of every process grouped under this app.
    pub process_objs: Vec<u32>,
    pub is_emitting: bool,
    pub is_recording: bool,
}

/// Apps (grouped processes) currently known to Core Audio, playing ones first.
#[cfg(target_os = "macos")]
pub fn list_apps() -> anyhow::Result<Vec<AppAudioInfo>> {
    capture::list_apps()
}

#[cfg(not(target_os = "macos"))]
pub fn list_apps() -> anyhow::Result<Vec<AppAudioInfo>> {
    Ok(vec![])
}
