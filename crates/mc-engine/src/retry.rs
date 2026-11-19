//! ASR recovery: failed chunks are kept in `asr_failures` and retried from the FLAC archive every
//! 30 s (and immediately on "retry"). Works from the database, so stopped sessions are retried too.
//! When a session's last failure clears, it gets "asr_recovered", and a stopped session gets its
//! key points updated and its report regenerated.

use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Weak};
use std::time::Duration;

use mc_asr::Pass;
use mc_core::{EngineEvent, SummaryMode};
use mc_recorder::SegmentInfo;
use mc_store::AsrFailure;
use serde::Serialize;

use crate::session::{record_asr_failure, store_segments};
use crate::Engine;

pub const RETRY_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AsrHealth {
    /// "ok" or "degraded"
    pub state: &'static str,
    pub failed_chunks: i64,
    pub failed_ms: i64,
}

impl AsrHealth {
    pub fn from_counts(n: i64, ms: i64) -> Self {
        Self { state: if n > 0 { "degraded" } else { "ok" }, failed_chunks: n, failed_ms: ms }
    }
}

fn pass_of(s: &str) -> Pass {
    match s {
        "after" => Pass::After,
        "backfill" => Pass::Backfill,
        _ => Pass::Live,
    }
}

pub(crate) fn segments_of(engine: &Engine, id: &str) -> Vec<SegmentInfo> {
    engine
        .store
        .segments(id)
        .unwrap_or_default()
        .into_iter()
        .map(|(seq, start_ms, end_ms, path, bytes, sha256)| SegmentInfo { seq, start_ms, end_ms, path: path.into(), bytes, sha256 })
        .collect()
}

pub(crate) fn spawn_loop(engine: Weak<Engine>, notify: Arc<tokio::sync::Notify>) {
    tokio::spawn(async move {
        loop {
            let _ = tokio::time::timeout(RETRY_INTERVAL, notify.notified()).await;
            let Some(engine) = engine.upgrade() else { return };
            run_pass(&engine);
        }
    });
}

/// One retry pass over every failed range whose audio is archived. Each session runs on its own task.
pub(crate) fn run_pass(engine: &Arc<Engine>) {
    let failures = match engine.store.asr_failures(None) {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!(error = %e, "reading asr failures");
            return;
        }
    };
    let mut by_session: BTreeMap<String, Vec<AsrFailure>> = BTreeMap::new();
    for f in failures {
        by_session.entry(f.session_id.clone()).or_default().push(f);
    }
    for (id, list) in by_session {
        {
            let mut busy = engine.retrying.lock().unwrap();
            if busy.contains(&id) {
                continue;
            }
            busy.insert(id.clone());
        }
        let engine = engine.clone();
        tokio::spawn(async move {
            retry_session(&engine, &id, list).await;
            engine.retrying.lock().unwrap().remove(&id);
        });
    }
}

async fn retry_session(engine: &Arc<Engine>, id: &str, list: Vec<AsrFailure>) {
    let segs = segments_of(engine, id);
    let archived_end = segs.last().map(|s| s.end_ms).unwrap_or(0);
    let has_live_text = engine.store.transcript(id).map(|t| t.iter().any(|e| e.state == "final")).unwrap_or(false);
    let mut waiting = Vec::new();
    let mut seen = HashSet::new();
    for f in list {
        // Still in the minute being recorded: wait until it is archived.
        if f.end_ms > archived_end || !seen.insert((f.start_ms, f.pass.clone())) {
            continue;
        }
        let audio = mc_recorder::read_range(&segs, f.start_ms, f.end_ms).unwrap_or_default();
        if audio.is_empty() {
            let _ = engine.store.delete_asr_failure(id, f.start_ms, &f.pass);
            continue;
        }
        let rx = engine.scheduler().submit(id, Pass::Backfill, f.start_ms, audio, None);
        waiting.push((f, rx));
    }
    if waiting.is_empty() {
        return;
    }
    let mut added = Vec::new();
    for (f, rx) in waiting {
        let pass = pass_of(&f.pass);
        match rx.await.unwrap_or_else(|_| Err(anyhow::anyhow!("scheduler dropped job"))) {
            Ok(segments) => {
                let correct = pass == Pass::After && has_live_text;
                added.extend(store_segments(engine, id, f.start_ms, f.end_ms, segments, pass, correct));
                let _ = engine.store.delete_asr_failure(id, f.start_ms, &f.pass);
            }
            Err(e) => record_asr_failure(engine, id, f.start_ms, f.end_ms, pass, &e),
        }
    }
    let remaining = engine.store.asr_failures(Some(id)).map(|v| v.len()).unwrap_or(1);
    if remaining > 0 {
        return;
    }
    let session = engine.store.session(id).ok().flatten();
    let status = session.as_ref().map(|s| s.status.clone()).unwrap_or_else(|| "stopped".into());
    engine.emit(EngineEvent::Status { session_id: id.to_string(), status, detail: Some("asr_recovered".into()) });
    let Some(session) = session else { return };
    let stopped = !engine.is_active(id) && (session.status == "stopped" || session.status == "failed");
    if !stopped || SummaryMode::parse(&session.summary_mode) == Some(SummaryMode::Off) {
        return;
    }
    let Some(llm) = engine.llm() else { return };
    let lang = engine.config().output_lang;
    added.sort_by_key(|e| e.start_ms);
    for part in added.chunks(40) {
        if let Ok((outcome, usage)) = mc_insight::reduce(&engine.store, &llm, id, part, &lang).await {
            if let Some(u) = usage {
                let _ = engine.store.add_usage(Some(id), &format!("{}:{}", u.provider, u.model), "tokens", (u.input_tokens + u.output_tokens) as f64, u.usd);
            }
            for i in outcome.applied {
                engine.emit(EngineEvent::Insight { session_id: id.to_string(), insight: i });
            }
        }
    }
    match mc_insight::report(&engine.store, &llm, id, &lang, &session.title).await {
        Ok(usage) => {
            if let Some(u) = usage {
                let _ = engine.store.add_usage(Some(id), &format!("{}:{}", u.provider, u.model), "tokens", (u.input_tokens + u.output_tokens) as f64, u.usd);
            }
            engine.emit(EngineEvent::Report { session_id: id.to_string(), is_final: true });
        }
        Err(e) => tracing::warn!(session = %id, error = %e, "report after recovery failed"),
    }
}
