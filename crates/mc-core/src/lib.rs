//! Shared types for Multicorder: identifiers, session vocabulary, configuration and engine events.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub mod config;

/// Every audio frame inside the engine is 16 kHz mono f32.
pub const SAMPLE_RATE: u32 = 16_000;
/// Samples per engine frame (20 ms).
pub const FRAME_SAMPLES: usize = 320;

pub fn new_id() -> String {
    ulid::Ulid::new().to_string().to_lowercase()
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn ms_to_samples(ms: i64) -> usize {
    (ms.max(0) as u64 * SAMPLE_RATE as u64 / 1000) as usize
}

pub fn samples_to_ms(samples: usize) -> i64 {
    (samples as u64 * 1000 / SAMPLE_RATE as u64) as i64
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    ChromiumTab,
    MacApp,
    Mic,
}

impl SourceKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            SourceKind::ChromiumTab => "chromium_tab",
            SourceKind::MacApp => "mac_app",
            SourceKind::Mic => "mic",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "chromium_tab" => Some(Self::ChromiumTab),
            "mac_app" => Some(Self::MacApp),
            "mic" => Some(Self::Mic),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SummaryMode {
    Off,
    Live,
    #[default]
    After,
}

impl SummaryMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            SummaryMode::Off => "off",
            SummaryMode::Live => "live",
            SummaryMode::After => "after",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "off" => Some(Self::Off),
            "live" => Some(Self::Live),
            "after" => Some(Self::After),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Starting,
    Capturing,
    Reconnecting,
    Stopping,
    Stopped,
    Failed,
}

impl SessionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Capturing => "capturing",
            Self::Reconnecting => "reconnecting",
            Self::Stopping => "stopping",
            Self::Stopped => "stopped",
            Self::Failed => "failed",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "starting" => Self::Starting,
            "capturing" => Self::Capturing,
            "reconnecting" => Self::Reconnecting,
            "stopping" => Self::Stopping,
            "stopped" => Self::Stopped,
            "failed" => Self::Failed,
            _ => return None,
        })
    }
    pub fn is_active(&self) -> bool {
        matches!(self, Self::Starting | Self::Capturing | Self::Reconnecting | Self::Stopping)
    }
}

/// What a client asks to capture.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SourceSpec {
    ChromiumTab {
        tab_id: Option<i64>,
        url: Option<String>,
        title: Option<String>,
    },
    MacApp {
        /// `AppAudioInfo::app_id` from the app list.
        app_id: String,
    },
    Mic {
        device: Option<String>,
    },
}

impl SourceSpec {
    pub fn kind(&self) -> SourceKind {
        match self {
            SourceSpec::ChromiumTab { .. } => SourceKind::ChromiumTab,
            SourceSpec::MacApp { .. } => SourceKind::MacApp,
            SourceSpec::Mic { .. } => SourceKind::Mic,
        }
    }
}

/// Events pushed to UIs (SSE for the extension, Tauri events for the desktop app).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EngineEvent {
    Status { session_id: String, status: String, detail: Option<String> },
    Level { session_id: String, rms_db: f32, silent: bool },
    Transcript { session_id: String, event: TranscriptEvent },
    Insight { session_id: String, insight: Insight },
    Gap { session_id: String, start_ms: i64, end_ms: i64, cause: String },
    Report { session_id: String, is_final: bool },
    Backlog { session_id: String, pending_chunks: usize },
}

impl EngineEvent {
    pub fn session_id(&self) -> &str {
        match self {
            EngineEvent::Status { session_id, .. }
            | EngineEvent::Level { session_id, .. }
            | EngineEvent::Transcript { session_id, .. }
            | EngineEvent::Insight { session_id, .. }
            | EngineEvent::Gap { session_id, .. }
            | EngineEvent::Report { session_id, .. }
            | EngineEvent::Backlog { session_id, .. } => session_id,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TranscriptEvent {
    pub id: String,
    pub session_id: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub media_start_ms: Option<i64>,
    pub revision: i64,
    /// partial | final | corrected | retracted
    pub state: String,
    pub supersedes: Option<String>,
    pub text: String,
    pub lang: Option<String>,
    pub engine: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Evidence {
    pub event_id: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Insight {
    pub id: String,
    pub session_id: String,
    pub key: String,
    pub revision: i64,
    /// key_point | claim | number | decision | question | action | quote | topic
    pub kind: String,
    /// tentative | confirmed | retracted
    pub state: String,
    pub text: String,
    pub evidence: Vec<Evidence>,
    pub created_at: String,
}

/// Root folder for the database, audio and runtime files.
pub fn default_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("MC_DATA_DIR") {
        return PathBuf::from(dir);
    }
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Multicorder")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_math_round_trips() {
        assert_eq!(ms_to_samples(1000), 16_000);
        assert_eq!(samples_to_ms(320), 20);
    }

    #[test]
    fn enums_round_trip() {
        for m in [SummaryMode::Off, SummaryMode::Live, SummaryMode::After] {
            assert_eq!(SummaryMode::parse(m.as_str()), Some(m));
        }
        for k in [SourceKind::ChromiumTab, SourceKind::MacApp, SourceKind::Mic] {
            assert_eq!(SourceKind::parse(k.as_str()), Some(k));
        }
    }
}
