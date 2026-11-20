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

/// Link that opens the source video at `media_ms` (`youtube:<id>`, `bilibili:<BV…>` keys only).
pub fn video_link(video_key: Option<&str>, media_ms: Option<i64>) -> Option<String> {
    let (platform, vid) = video_key?.split_once(':')?;
    let secs = media_ms?.max(0) / 1000;
    match platform {
        "youtube" => Some(format!("https://www.youtube.com/watch?v={vid}&t={secs}s")),
        "bilibili" => Some(format!("https://www.bilibili.com/video/{vid}?t={secs}")),
        _ => None,
    }
}

/// Adds `media_ms` (video time) and `link` to each `evidence` entry of serialized insights.
fn with_video_time(engine: &Engine, id: &str, video_key: Option<&str>, mut insights: serde_json::Value) -> serde_json::Value {
    for insight in insights.as_array_mut().into_iter().flatten() {
        for ev in insight["evidence"].as_array_mut().into_iter().flatten() {
            let media = ev["start_ms"].as_i64().and_then(|ms| engine.store.media_time_at(id, ms).ok().flatten());
            ev["media_ms"] = json!(media);
            ev["link"] = json!(video_link(video_key, media));
        }
    }
    insights
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
            let vk = session.video_key.as_deref();
            let transcript: Vec<serde_json::Value> = transcript
                .iter()
                .map(|e| {
                    let mut v = json!(e);
                    v["link"] = json!(video_link(vk, e.media_start_ms));
                    v
                })
                .collect();
            let markers: Vec<serde_json::Value> = engine
                .store
                .markers(id)?
                .into_iter()
                .map(|m| {
                    let media = engine.store.media_time_at(id, m.at_ms).ok().flatten();
                    json!({"id": m.id, "at_ms": m.at_ms, "label": m.label, "media_ms": media, "link": video_link(vk, media)})
                })
                .collect();
            let body = json!({
                "session": session,
                "video": {"url": session.url, "video_key": vk},
                "transcript": transcript,
                "insights": with_video_time(engine, id, vk, json!(engine.store.latest_insights(id, false)?)),
                "report": engine.store.report(id)?,
                "gaps": engine.store.gaps(id)?,
                "markers": markers,
            });
            ("application/json".into(), serde_json::to_vec_pretty(&body)?)
        }
        ExportFormat::Markdown => {
            let mut out = match engine.store.report(id)? {
                Some(r) => r.body,
                None => format!("# {}\n\n", session.title),
            };
            out.push_str(&format!("\n---\n\nSource: {} ({})  \n", session.title, session.kind));
            if let Some(url) = &session.url {
                out.push_str(&format!("URL: <{url}>  \n"));
            }
            out.push_str(&format!("Started: {}\n\n## Transcript\n\n", session.started_at));
            let vk = session.video_key.as_deref();
            for e in &transcript {
                // Video time and a link back to that moment when the source is a public video.
                match (e.media_start_ms, video_link(vk, e.media_start_ms)) {
                    (Some(m), Some(link)) => out.push_str(&format!("[`[{}]`]({link}) {}\n\n", fmt_ts(m), e.text)),
                    _ => out.push_str(&format!("`[{}]` {}\n\n", fmt_ts(e.start_ms), e.text)),
                }
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

    #[test]
    fn video_links() {
        assert_eq!(video_link(Some("youtube:abc"), Some(62_900)).as_deref(), Some("https://www.youtube.com/watch?v=abc&t=62s"));
        assert_eq!(video_link(Some("bilibili:BV1x"), Some(5_000)).as_deref(), Some("https://www.bilibili.com/video/BV1x?t=5"));
        assert_eq!(video_link(Some("youtube:abc"), None), None);
        assert_eq!(video_link(None, Some(1)), None);
        assert_eq!(video_link(Some("other:x"), Some(1)), None);
    }
}
