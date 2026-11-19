//! Per-session insights (design 4.9): rolling key points as upsert/confirm/retract operations with
//! evidence checked in code, "what did I miss", and the end-of-session report. Every function works
//! on exactly one session (isolation invariant).

pub mod llm;
pub mod numbers;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use mc_core::{new_id, now_iso, Evidence, Insight, TranscriptEvent};
use mc_store::Store;
use serde::Serialize;
use serde_json::{json, Value};

pub use llm::{HttpLlm, Llm, Usage};

const KINDS: &[&str] = &["key_point", "claim", "number", "decision", "question", "action", "quote", "topic"];

fn lang_name(code: &str) -> &'static str {
    match code {
        "zh" | "zh-CN" => "Simplified Chinese",
        "en" => "English",
        "ja" => "Japanese",
        _ => "the same language as the transcript",
    }
}

pub fn fmt_ts(ms: i64) -> String {
    let s = ms.max(0) / 1000;
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, (s / 60) % 60, s % 60)
    } else {
        format!("{:02}:{:02}", s / 60, s % 60)
    }
}

fn reducer_system(lang: &str) -> String {
    format!(
        "You maintain the rolling key points of ONE audio source (a single livestream, video, app or meeting). \
Return only JSON: {{\"ops\":[...]}}. Each op is one of:\n\
{{\"op\":\"upsert\",\"key\":\"<existing key or new short id>\",\"type\":\"key_point|claim|number|decision|question|action|quote|topic\",\"text\":\"...\",\"evidence\":[\"<segment id>\",...]}}\n\
{{\"op\":\"confirm\",\"key\":\"<existing key>\"}}\n\
{{\"op\":\"retract\",\"key\":\"<existing key>\",\"reason\":\"...\"}}\n\
Rules: write \"text\" in {}; one concrete point per op, at most 25 words; every upsert cites at least one segment id from the input; \
copy numbers exactly as they appear in the cited segments (same digits and units, never convert); do not invent facts; \
skip greetings, filler and ads; do not repeat points that already exist (update them with upsert instead); \
confirm an existing point when new segments support it; retract one that new segments contradict. \
Emit at most 5 ops. If nothing new is worth noting, return {{\"ops\":[]}}.",
        lang_name(lang)
    )
}

#[derive(Debug, Default, Serialize, PartialEq)]
pub struct ReduceOutcome {
    pub applied: Vec<Insight>,
    pub rejected: Vec<String>,
}

/// One reducer round over `new_events`. `context` are earlier events kept for reference.
pub async fn reduce(
    store: &Store,
    llm: &Arc<dyn Llm>,
    session_id: &str,
    new_events: &[TranscriptEvent],
    lang: &str,
) -> anyhow::Result<(ReduceOutcome, Option<Usage>)> {
    if new_events.is_empty() {
        return Ok((ReduceOutcome::default(), None));
    }
    let transcript = store.transcript(session_id)?;
    let by_id: HashMap<&str, &TranscriptEvent> = transcript.iter().map(|e| (e.id.as_str(), e)).collect();
    let current = store.latest_insights(session_id, false)?;
    let new_ids: HashSet<&str> = new_events.iter().map(|e| e.id.as_str()).collect();
    let context: Vec<&TranscriptEvent> = transcript
        .iter()
        .filter(|e| !new_ids.contains(e.id.as_str()) && e.end_ms <= new_events[0].start_ms)
        .rev()
        .take(12)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let seg = |e: &TranscriptEvent| json!({"id": e.id, "t": fmt_ts(e.start_ms), "text": e.text});
    let input = json!({
        "current_points": current.iter().rev().take(40).map(|i| json!({
            "key": i.key, "type": i.kind, "state": i.state, "text": i.text,
            "evidence": i.evidence.iter().map(|e| e.event_id.clone()).collect::<Vec<_>>()
        })).collect::<Vec<_>>(),
        "earlier_segments": context.iter().map(|e| seg(e)).collect::<Vec<_>>(),
        "new_segments": new_events.iter().map(seg).collect::<Vec<_>>(),
    });
    let (out, usage) = llm.chat_json(&reducer_system(lang), &input.to_string(), 2000).await?;
    let outcome = apply_ops(store, session_id, &out, &by_id, &current)?;
    Ok((outcome, Some(usage)))
}

/// Validates and stores reducer operations. Pure enough to test without a model.
pub fn apply_ops(
    store: &Store,
    session_id: &str,
    out: &Value,
    by_id: &HashMap<&str, &TranscriptEvent>,
    current: &[Insight],
) -> anyhow::Result<ReduceOutcome> {
    let mut outcome = ReduceOutcome::default();
    let existing: HashMap<&str, &Insight> = current.iter().map(|i| (i.key.as_str(), i)).collect();
    let ops = out["ops"].as_array().cloned().unwrap_or_default();
    for op in ops.iter().take(8) {
        let kind_op = op["op"].as_str().unwrap_or("");
        let key = op["key"].as_str().unwrap_or("").trim().to_string();
        match kind_op {
            "upsert" => {
                let text = op["text"].as_str().unwrap_or("").trim().to_string();
                let kind = op["type"].as_str().filter(|t| KINDS.contains(t)).unwrap_or("key_point").to_string();
                let ids: Vec<String> = op["evidence"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
                let evidence: Vec<Evidence> = ids
                    .iter()
                    .filter_map(|id| by_id.get(id.as_str()))
                    .map(|e| Evidence { event_id: e.id.clone(), start_ms: e.start_ms, end_ms: e.end_ms })
                    .collect();
                if text.is_empty() {
                    outcome.rejected.push("empty text".into());
                    continue;
                }
                if evidence.is_empty() || evidence.len() != ids.len() {
                    outcome.rejected.push(format!("unknown evidence for: {text}"));
                    continue;
                }
                let evidence_text: String = evidence.iter().filter_map(|e| by_id.get(e.event_id.as_str())).map(|e| e.text.as_str()).collect::<Vec<_>>().join(" ");
                if let Err(n) = numbers::check(&text, &evidence_text) {
                    outcome.rejected.push(format!("number {n} not in evidence: {text}"));
                    continue;
                }
                if kind == "quote" && text.split_whitespace().count() > 25 {
                    outcome.rejected.push("quote too long".into());
                    continue;
                }
                let prev = existing.get(key.as_str());
                if prev.is_some_and(|p| p.text == text) {
                    continue;
                }
                let insight = Insight {
                    id: new_id(),
                    session_id: session_id.to_string(),
                    key: if key.is_empty() || (prev.is_none() && existing.contains_key(key.as_str())) { format!("k{}", &new_id()[20..]) } else { key.clone() },
                    revision: prev.map(|p| p.revision + 1).unwrap_or(1),
                    kind,
                    state: prev.map(|p| p.state.clone()).unwrap_or_else(|| "tentative".into()),
                    text,
                    evidence,
                    created_at: now_iso(),
                };
                store.insert_insight(&insight)?;
                outcome.applied.push(insight);
            }
            "confirm" | "retract" => {
                let Some(prev) = existing.get(key.as_str()) else {
                    outcome.rejected.push(format!("{kind_op} of unknown key {key}"));
                    continue;
                };
                let state = if kind_op == "confirm" { "confirmed" } else { "retracted" };
                if prev.state == state {
                    continue;
                }
                let insight = Insight { id: new_id(), revision: prev.revision + 1, state: state.into(), created_at: now_iso(), ..(*prev).clone() };
                store.insert_insight(&insight)?;
                outcome.applied.push(insight);
            }
            _ => outcome.rejected.push(format!("unknown op {kind_op}")),
        }
    }
    Ok(outcome)
}

/// Demotes insights whose evidence was superseded (corrected or retracted transcript).
pub fn demote_stale(store: &Store, session_id: &str) -> anyhow::Result<Vec<Insight>> {
    let live: HashSet<String> = store.transcript(session_id)?.into_iter().map(|e| e.id).collect();
    let mut changed = Vec::new();
    for i in store.latest_insights(session_id, false)? {
        if i.state != "tentative" && i.evidence.iter().any(|e| !live.contains(&e.event_id)) {
            let demoted = Insight { id: new_id(), revision: i.revision + 1, state: "tentative".into(), created_at: now_iso(), ..i };
            store.insert_insight(&demoted)?;
            changed.push(demoted);
        }
    }
    Ok(changed)
}

#[derive(Debug, Serialize)]
pub struct Missed {
    pub minutes: i64,
    pub from_ms: i64,
    pub to_ms: i64,
    pub points: Vec<MissedPoint>,
    pub source: &'static str,
}

#[derive(Debug, Serialize)]
pub struct MissedPoint {
    pub text: String,
    pub evidence: Vec<Evidence>,
}

/// "What did I miss" over the last `minutes` of a session.
pub async fn missed(store: &Store, llm: Option<&Arc<dyn Llm>>, session_id: &str, minutes: i64, lang: &str) -> anyhow::Result<(Missed, Option<Usage>)> {
    let transcript = store.transcript(session_id)?;
    let to_ms = transcript.last().map(|e| e.end_ms).unwrap_or(0);
    let from_ms = (to_ms - minutes * 60_000).max(0);
    let points: Vec<MissedPoint> = store
        .latest_insights(session_id, false)?
        .into_iter()
        .filter(|i| i.evidence.iter().any(|e| e.start_ms >= from_ms))
        .map(|i| MissedPoint { text: i.text, evidence: i.evidence })
        .collect();
    if points.len() >= 2 || minutes < 15 || llm.is_none() {
        return Ok((Missed { minutes, from_ms, to_ms, points, source: "insights" }, None));
    }
    let window: Vec<&TranscriptEvent> = transcript.iter().filter(|e| e.start_ms >= from_ms).collect();
    if window.is_empty() {
        return Ok((Missed { minutes, from_ms, to_ms, points, source: "insights" }, None));
    }
    let by_id: HashMap<&str, &TranscriptEvent> = window.iter().map(|e| (e.id.as_str(), *e)).collect();
    let system = format!(
        "Summarise what was said in this window of ONE audio source as at most 5 bullet points in {}. \
Return only JSON {{\"points\":[{{\"text\":\"...\",\"evidence\":[\"<segment id>\"]}}]}}. Cite segment ids; copy numbers exactly.",
        lang_name(lang)
    );
    let input = json!({"segments": window.iter().map(|e| json!({"id": e.id, "t": fmt_ts(e.start_ms), "text": e.text})).collect::<Vec<_>>()});
    let (out, usage) = llm.unwrap().chat_json(&system, &input.to_string(), 1200).await?;
    let mut pts = Vec::new();
    for p in out["points"].as_array().cloned().unwrap_or_default() {
        let text = p["text"].as_str().unwrap_or("").trim().to_string();
        let ev: Vec<Evidence> = p["evidence"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str()).filter_map(|id| by_id.get(id)).map(|e| Evidence { event_id: e.id.clone(), start_ms: e.start_ms, end_ms: e.end_ms }).collect())
            .unwrap_or_default();
        if !text.is_empty() && !ev.is_empty() {
            pts.push(MissedPoint { text, evidence: ev });
        }
    }
    Ok((Missed { minutes, from_ms, to_ms, points: pts, source: "model" }, Some(usage)))
}

/// End-of-session report. Sections without valid evidence are dropped.
pub async fn report(store: &Store, llm: &Arc<dyn Llm>, session_id: &str, lang: &str, title: &str) -> anyhow::Result<Option<Usage>> {
    let transcript = store.transcript(session_id)?;
    if transcript.is_empty() {
        store.upsert_report(session_id, &format!("# {title}\n\n_No speech was transcribed._\n"), &json!([]), true, None)?;
        return Ok(None);
    }
    let by_id: HashMap<&str, &TranscriptEvent> = transcript.iter().map(|e| (e.id.as_str(), e)).collect();
    let mut segs: Vec<Value> = transcript.iter().map(|e| json!({"id": e.id, "t": fmt_ts(e.start_ms), "text": e.text})).collect();
    // Keep requests bounded: very long sessions keep the start and the most recent part.
    let total: usize = transcript.iter().map(|e| e.text.len()).sum();
    if total > 60_000 {
        let keep = segs.len() / 3;
        let tail: Vec<Value> = segs.split_off(segs.len() - keep);
        segs.truncate(keep);
        segs.extend(tail);
    }
    let points: Vec<Value> = store.latest_insights(session_id, false)?.iter().map(|i| json!({"type": i.kind, "text": i.text})).collect();
    let system = format!(
        "Write the final report for ONE audio source in {}. Return only JSON: \
{{\"summary\":\"2-3 sentences\",\"sections\":[{{\"heading\":\"...\",\"bullets\":[{{\"text\":\"...\",\"evidence\":[\"<segment id>\"]}}]}}]}}. \
Use 3-6 sections such as key points, numbers and announcements, decisions, open questions, action items. \
Every bullet cites segment ids from the input; copy numbers exactly as in the cited segments; do not invent facts.",
        lang_name(lang)
    );
    let input = json!({"title": title, "rolling_points": points, "segments": segs});
    let (out, usage) = llm.chat_json(&system, &input.to_string(), 4000).await?;
    let mut md = format!("# {title}\n\n");
    if let Some(s) = out["summary"].as_str() {
        md.push_str(s.trim());
        md.push_str("\n\n");
    }
    let mut kept = Vec::new();
    for sec in out["sections"].as_array().cloned().unwrap_or_default() {
        let heading = sec["heading"].as_str().unwrap_or("").trim().to_string();
        let mut bullets = Vec::new();
        for b in sec["bullets"].as_array().cloned().unwrap_or_default() {
            let text = b["text"].as_str().unwrap_or("").trim().to_string();
            let ev: Vec<&TranscriptEvent> = b["evidence"].as_array().map(|a| a.iter().filter_map(|v| v.as_str()).filter_map(|id| by_id.get(id).copied()).collect()).unwrap_or_default();
            if text.is_empty() || ev.is_empty() {
                continue;
            }
            let evidence_text = ev.iter().map(|e| e.text.as_str()).collect::<Vec<_>>().join(" ");
            if numbers::check(&text, &evidence_text).is_err() {
                continue;
            }
            bullets.push(json!({"text": text, "evidence": ev.iter().map(|e| json!({"event_id": e.id, "start_ms": e.start_ms, "end_ms": e.end_ms})).collect::<Vec<_>>()}));
        }
        if heading.is_empty() || bullets.is_empty() {
            continue;
        }
        md.push_str(&format!("## {heading}\n\n"));
        for b in &bullets {
            let first = b["evidence"][0]["start_ms"].as_i64().unwrap_or(0);
            md.push_str(&format!("- {} `[{}]`\n", b["text"].as_str().unwrap_or(""), fmt_ts(first)));
        }
        md.push('\n');
        kept.push(json!({"heading": heading, "bullets": bullets}));
    }
    store.upsert_report(session_id, &md, &Value::Array(kept), true, Some(&format!("{}:{}", usage.provider, usage.model)))?;
    Ok(Some(usage))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mc_store::NewSource;

    fn setup() -> (Store, String, Vec<TranscriptEvent>) {
        let store = Store::open_memory().unwrap();
        let src = store.create_source(&NewSource { kind: "chromium_tab", title: "t", app_bundle_id: None, url: None, video_key: None }).unwrap();
        let s = store.create_session(&src, "live", None, None).unwrap();
        let mut evs = Vec::new();
        for (i, text) in ["The Falcon budget is 42 million dollars.", "Launch is planned for March."].iter().enumerate() {
            let e = TranscriptEvent {
                id: format!("ev{i}"),
                session_id: s.clone(),
                start_ms: i as i64 * 5000,
                end_ms: i as i64 * 5000 + 4000,
                media_start_ms: None,
                revision: 1,
                state: "final".into(),
                supersedes: None,
                text: text.to_string(),
                lang: Some("en".into()),
                engine: "fake".into(),
            };
            store.insert_transcript(&e, "live").unwrap();
            evs.push(e);
        }
        (store, s, evs)
    }

    #[test]
    fn ops_are_validated_in_code() {
        let (store, s, evs) = setup();
        let by_id: HashMap<&str, &TranscriptEvent> = evs.iter().map(|e| (e.id.as_str(), e)).collect();
        let out = json!({"ops": [
            {"op":"upsert","key":"a","type":"number","text":"Falcon 预算为 42 million 美元","evidence":["ev0"]},
            {"op":"upsert","key":"b","type":"number","text":"Falcon 预算为 43 million","evidence":["ev0"]},
            {"op":"upsert","key":"c","type":"key_point","text":"made up","evidence":["nope"]},
            {"op":"confirm","key":"zzz"}
        ]});
        let r = apply_ops(&store, &s, &out, &by_id, &[]).unwrap();
        assert_eq!(r.applied.len(), 1);
        assert_eq!(r.rejected.len(), 3);
        let current = store.latest_insights(&s, false).unwrap();
        let confirm = json!({"ops":[{"op":"confirm","key":"a"}]});
        let r2 = apply_ops(&store, &s, &confirm, &by_id, &current).unwrap();
        assert_eq!(r2.applied[0].state, "confirmed");
        assert_eq!(r2.applied[0].revision, 2);
    }

    #[tokio::test]
    async fn missed_lists_recent_points_without_model() {
        let (store, s, evs) = setup();
        let by_id: HashMap<&str, &TranscriptEvent> = evs.iter().map(|e| (e.id.as_str(), e)).collect();
        apply_ops(&store, &s, &json!({"ops":[{"op":"upsert","key":"a","type":"key_point","text":"Launch in March","evidence":["ev1"]}]}), &by_id, &[]).unwrap();
        let (m, _) = missed(&store, None, &s, 5, "en").await.unwrap();
        assert_eq!(m.points.len(), 1);
    }

    #[test]
    fn timestamps_format() {
        assert_eq!(fmt_ts(65_000), "01:05");
        assert_eq!(fmt_ts(3_725_000), "1:02:05");
    }
}
