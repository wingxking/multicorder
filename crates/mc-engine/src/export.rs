//! Per-session exports: Markdown, SRT, VTT, JSON (design 4.10).

use mc_insight::fmt_ts;
use serde_json::json;

use crate::Engine;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ExportFormat {
    Markdown,
    Srt,
    Vtt,
    Json,
}

impl ExportFormat {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "md" | "markdown" => Self::Markdown,
            "srt" => Self::Srt,
            "vtt" => Self::Vtt,
            "json" => Self::Json,
            _ => return None,
        })
    }
}

fn cue_time(ms: i64, sep: char) -> String {
    let ms = ms.max(0);
    format!("{:02}:{:02}:{:02}{}{:03}", ms / 3_600_000, (ms / 60_000) % 60, (ms / 1000) % 60, sep, ms % 1000)
}

/// Returns (content type, bytes).
pub fn export(engine: &Engine, id: &str, format: ExportFormat) -> anyhow::Result<(String, Vec<u8>)> {
    let session = engine.store.session(id)?.ok_or_else(|| anyhow::anyhow!("no session {id}"))?;
    let transcript = engine.store.transcript(id)?;
    Ok(match format {
        ExportFormat::Srt => {
            let mut out = String::new();
            for (i, e) in transcript.iter().enumerate() {
                out.push_str(&format!("{}\n{} --> {}\n{}\n\n", i + 1, cue_time(e.start_ms, ','), cue_time(e.end_ms, ','), e.text));
            }
            ("application/x-subrip".into(), out.into_bytes())
        }
        ExportFormat::Vtt => {
            let mut out = String::from("WEBVTT\n\n");
            for e in &transcript {
                out.push_str(&format!("{} --> {}\n{}\n\n", cue_time(e.start_ms, '.'), cue_time(e.end_ms, '.'), e.text));
            }
            ("text/vtt".into(), out.into_bytes())
        }
        ExportFormat::Json => {
            let body = json!({
                "session": session,
                "transcript": transcript,
                "insights": engine.store.latest_insights(id, false)?,
                "report": engine.store.report(id)?,
                "gaps": engine.store.gaps(id)?,
                "markers": engine.store.markers(id)?,
            });
            ("application/json".into(), serde_json::to_vec_pretty(&body)?)
        }
        ExportFormat::Markdown => {
            let mut out = match engine.store.report(id)? {
                Some(r) => r.body,
                None => format!("# {}\n\n", session.title),
            };
            out.push_str(&format!("\n---\n\nSource: {} ({})  \nStarted: {}\n\n## Transcript\n\n", session.title, session.kind, session.started_at));
            for e in &transcript {
                out.push_str(&format!("`[{}]` {}\n\n", fmt_ts(e.start_ms), e.text));
            }
            ("text/markdown; charset=utf-8".into(), out.into_bytes())
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cue_times() {
        assert_eq!(cue_time(3_725_042, ','), "01:02:05,042");
        assert_eq!(ExportFormat::parse("vtt"), Some(ExportFormat::Vtt));
    }
}
