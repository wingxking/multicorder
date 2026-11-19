//! One supervised pipeline per source. The capture side never waits on transcription:
//! archive writing runs on its own thread, transcription is queued, model calls run on their own task.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicI64, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use mc_asr::Pass;
use mc_core::{new_id, samples_to_ms, EngineEvent, SourceKind, SummaryMode, TranscriptEvent, SAMPLE_RATE};
use mc_recorder::{SegmentInfo, SegmentWriter};
use mc_vad::{Chunker, SpeechChunk};
use tokio::sync::{mpsc, Notify};

use crate::Engine;

/// Tab frames are 100 ms (1600 samples).
pub const TAB_FRAME_SAMPLES: usize = 1600;
/// Longest silence inserted for a seq gap before the frame is treated as a new stream position.
const MAX_GAP_FILL_FRAMES: u32 = 600;

pub enum SessionMsg {
    Audio(Vec<f32>),
    Mode(SummaryMode),
    Gap { start_ms: i64, end_ms: i64, cause: String },
    Status(String, Option<String>),
    Stop { reason: String },
}

#[allow(dead_code)]
pub struct SessionHandle {
    pub id: String,
    pub kind: SourceKind,
    pub app_id: Option<String>,
    pub tx: mpsc::Sender<SessionMsg>,
    /// Samples accepted so far (the session clock).
    samples: Arc<AtomicU64>,
    /// Tab ingest: next expected seq and wall clock of the last frame.
    next_seq: AtomicU32,
    seq_started: std::sync::atomic::AtomicBool,
    last_wall_ms: AtomicI64,
    last_wall_session_ms: AtomicI64,
    dropped: AtomicUsize,
    #[cfg(target_os = "macos")]
    capture: Mutex<Option<mc_capture_macos::AppCapture>>,
}

impl SessionHandle {
    pub fn session_ms(&self) -> i64 {
        samples_to_ms(self.samples.load(Ordering::Relaxed) as usize)
    }

    pub fn session_ms_at_wall(&self, wall_ms: f64) -> i64 {
        let last_wall = self.last_wall_ms.load(Ordering::Relaxed);
        if last_wall == 0 {
            return self.session_ms();
        }
        (self.last_wall_session_ms.load(Ordering::Relaxed) + (wall_ms as i64 - last_wall)).max(0)
    }

    fn push_audio(&self, samples: Vec<f32>) {
        let n = samples.len() as u64;
        match self.tx.try_send(SessionMsg::Audio(samples)) {
            Ok(()) => {
                self.samples.fetch_add(n, Ordering::Relaxed);
            }
            Err(_) => {
                // Session task is behind: count it; the gap is recorded when it catches up.
                self.dropped.fetch_add(n as usize, Ordering::Relaxed);
            }
        }
    }

    /// Accepts one tab frame; fills seq gaps with silence (recorded as a gap) and drops duplicates.
    pub fn ingest(&self, seq: u32, wall_ms: f64, pcm: &[i16]) -> anyhow::Result<u32> {
        if !self.seq_started.swap(true, Ordering::AcqRel) {
            self.next_seq.store(seq, Ordering::Release);
        }
        let expected = self.next_seq.load(Ordering::Acquire);
        if seq < expected {
            return Ok(expected.saturating_sub(1));
        }
        if seq > expected {
            let missing = (seq - expected).min(MAX_GAP_FILL_FRAMES);
            let start_ms = self.session_ms();
            self.push_audio(vec![0.0; missing as usize * TAB_FRAME_SAMPLES]);
            let _ = self.tx.try_send(SessionMsg::Gap { start_ms, end_ms: self.session_ms(), cause: "ws_gap".into() });
        }
        let samples: Vec<f32> = pcm.iter().map(|s| mc_audio::i16_to_f32(*s)).collect();
        self.push_audio(samples);
        self.next_seq.store(seq + 1, Ordering::Release);
        if wall_ms > 0.0 {
            self.last_wall_ms.store(wall_ms as i64, Ordering::Relaxed);
            self.last_wall_session_ms.store(self.session_ms(), Ordering::Relaxed);
        }
        Ok(seq)
    }

    #[cfg(target_os = "macos")]
    pub fn attach_app_capture(self: &Arc<Self>, app_id: String) -> anyhow::Result<()> {
        let me = Arc::downgrade(self);
        let sink: mc_capture_macos::Sink16k = {
            let me = me.clone();
            Arc::new(move |samples: &[f32]| {
                if let Some(h) = me.upgrade() {
                    h.push_audio(samples.to_vec());
                }
            })
        };
        let events: mc_capture_macos::EventSink = Arc::new(move |e| {
            let Some(h) = me.upgrade() else { return };
            use mc_capture_macos::CaptureEvent::*;
            let msg = match e {
                Started { .. } => return,
                Retapped { reason, .. } => SessionMsg::Status("capturing".into(), Some(format!("retap: {reason}"))),
                PermissionSuspected => SessionMsg::Status("capturing".into(), Some("permission_suspected".into())),
                AppGone => SessionMsg::Stop { reason: "app_gone".into() },
                Error(e) => SessionMsg::Status("capturing".into(), Some(format!("error: {e}"))),
            };
            let _ = h.tx.try_send(msg);
        });
        let cap = mc_capture_macos::AppCapture::start(app_id, sink, events)?;
        *self.capture.lock().unwrap() = Some(cap);
        Ok(())
    }

    fn detach_capture(&self) {
        #[cfg(target_os = "macos")]
        {
            let cap = self.capture.lock().unwrap().take();
            drop(cap);
        }
    }
}

pub fn spawn(engine: Arc<Engine>, id: String, kind: SourceKind, title: String, mode: SummaryMode, app_id: Option<String>) -> anyhow::Result<Arc<SessionHandle>> {
    let (tx, rx) = mpsc::channel(4096);
    let handle = Arc::new(SessionHandle {
        id: id.clone(),
        kind,
        app_id,
        tx,
        samples: Arc::new(AtomicU64::new(0)),
        next_seq: AtomicU32::new(0),
        seq_started: Default::default(),
        last_wall_ms: AtomicI64::new(0),
        last_wall_session_ms: AtomicI64::new(0),
        dropped: AtomicUsize::new(0),
        #[cfg(target_os = "macos")]
        capture: Mutex::new(None),
    });
    let dir = engine.session_dir(&id);
    let recorder = RecorderThread::start(engine.clone(), id.clone(), &dir)?;
    let h2 = handle.clone();
    tokio::spawn(async move {
        let task = SessionTask::new(engine.clone(), id.clone(), title, mode, recorder, h2.clone());
        task.run(rx).await;
        h2.detach_capture();
        engine.forget(&id);
    });
    Ok(handle)
}

/// Archive writer on its own OS thread so FLAC encoding never stalls the session loop.
struct RecorderThread {
    tx: std::sync::mpsc::Sender<Option<Vec<f32>>>,
    join: Option<std::thread::JoinHandle<Vec<SegmentInfo>>>,
}

impl RecorderThread {
    fn start(engine: Arc<Engine>, id: String, dir: &std::path::Path) -> anyhow::Result<Self> {
        let mut writer = SegmentWriter::new(dir, 0, 0)?;
        let (tx, rx) = std::sync::mpsc::channel::<Option<Vec<f32>>>();
        let join = std::thread::Builder::new().name(format!("mc-rec-{id}")).spawn(move || {
            let mut all = Vec::new();
            let store = |segs: Vec<SegmentInfo>, all: &mut Vec<SegmentInfo>| {
                for s in segs {
                    if let Err(e) = engine.store.add_segment(&id, s.seq, s.start_ms, s.end_ms, &s.path.to_string_lossy(), s.bytes, &s.sha256) {
                        tracing::error!(error = %e, "segment index failed");
                    }
                    all.push(s);
                }
            };
            while let Ok(Some(samples)) = rx.recv() {
                match writer.push(&samples) {
                    Ok(segs) => store(segs, &mut all),
                    Err(e) => {
                        tracing::error!(error = %e, "archive write failed");
                        engine.emit(EngineEvent::Status { session_id: id.clone(), status: "capturing".into(), detail: Some(format!("storage_error: {e}")) });
                    }
                }
            }
            if let Ok(Some(last)) = writer.finish() {
                store(vec![last], &mut all);
            }
            all
        })?;
        Ok(Self { tx, join: Some(join) })
    }

    fn push(&self, samples: Vec<f32>) {
        let _ = self.tx.send(Some(samples));
    }

    fn finish(mut self) -> Vec<SegmentInfo> {
        let _ = self.tx.send(None);
        self.join.take().and_then(|j| j.join().ok()).unwrap_or_default()
    }
}

struct SessionTask {
    engine: Arc<Engine>,
    id: String,
    title: String,
    mode: SummaryMode,
    recorder: Option<RecorderThread>,
    handle: Arc<SessionHandle>,
    chunker: Option<Chunker>,
    total_samples: usize,
    /// Audio since the start of the current archive minute (for backfill before the segment is written).
    recent: VecDeque<f32>,
    pending: Arc<AtomicUsize>,
    pending_done: Arc<Notify>,
    insight_tx: Option<mpsc::UnboundedSender<Vec<TranscriptEvent>>>,
    insight_task: Option<tokio::task::JoinHandle<()>>,
    level_acc: Vec<f32>,
    dropout: mc_audio::DropoutDetector,
    reported_drops: usize,
}

impl SessionTask {
    fn new(engine: Arc<Engine>, id: String, title: String, mode: SummaryMode, recorder: RecorderThread, handle: Arc<SessionHandle>) -> Self {
        let mut t = Self {
            engine,
            id,
            title,
            mode,
            recorder: Some(recorder),
            handle,
            chunker: None,
            total_samples: 0,
            recent: VecDeque::new(),
            pending: Arc::new(AtomicUsize::new(0)),
            pending_done: Arc::new(Notify::new()),
            insight_tx: None,
            insight_task: None,
            level_acc: Vec::new(),
            dropout: Default::default(),
            reported_drops: 0,
        };
        if mode == SummaryMode::Live {
            t.start_live(false);
        }
        t
    }

    async fn run(mut self, mut rx: mpsc::Receiver<SessionMsg>) {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        let mut stop_reason = String::from("user");
        loop {
            tokio::select! {
                msg = rx.recv() => match msg {
                    Some(SessionMsg::Audio(samples)) => self.on_audio(samples),
                    Some(SessionMsg::Mode(m)) => self.set_mode(m),
                    Some(SessionMsg::Gap { start_ms, end_ms, cause }) => {
                        let _ = self.engine.store.add_gap(&self.id, start_ms, end_ms, &cause);
                        self.engine.emit(EngineEvent::Gap { session_id: self.id.clone(), start_ms, end_ms, cause });
                    }
                    Some(SessionMsg::Status(status, detail)) => {
                        self.engine.emit(EngineEvent::Status { session_id: self.id.clone(), status, detail });
                    }
                    Some(SessionMsg::Stop { reason }) => { stop_reason = reason; break; }
                    None => break,
                },
                _ = tick.tick() => self.on_tick(),
            }
        }
        self.finish(stop_reason, rx).await;
    }

    fn on_tick(&mut self) {
        let dropped = self.handle.dropped.load(Ordering::Relaxed);
        if dropped > self.reported_drops {
            let ms = samples_to_ms(dropped - self.reported_drops);
            let at = samples_to_ms(self.total_samples);
            let _ = self.engine.store.add_gap(&self.id, at, at + ms, "backpressure");
            self.reported_drops = dropped;
        }
        if self.mode == SummaryMode::Live && self.engine.over_budget() {
            self.engine.emit(EngineEvent::Status { session_id: self.id.clone(), status: "capturing".into(), detail: Some("budget_exceeded: switched to after".into()) });
            let _ = self.engine.store.set_summary_mode(&self.id, "after");
            self.set_mode(SummaryMode::After);
        }
        let backlog = self.engine.scheduler().pending(&self.id);
        if backlog > 0 {
            self.engine.emit(EngineEvent::Backlog { session_id: self.id.clone(), pending_chunks: backlog });
        }
    }

    fn on_audio(&mut self, samples: Vec<f32>) {
        if let Some(r) = &self.recorder {
            r.push(samples.clone());
        }
        let seg_len = SAMPLE_RATE as usize * mc_recorder::SEGMENT_SECONDS;
        self.total_samples += samples.len();
        self.recent.extend(&samples);
        let keep = self.total_samples % seg_len;
        while self.recent.len() > keep {
            self.recent.pop_front();
        }
        // Level and dropout, once per second of audio.
        self.level_acc.extend_from_slice(&samples);
        if self.level_acc.len() >= SAMPLE_RATE as usize {
            let db = mc_audio::rms_db(&self.level_acc);
            if self.dropout.push(&self.level_acc) {
                self.engine.emit(EngineEvent::Status { session_id: self.id.clone(), status: "capturing".into(), detail: Some("source_silent".into()) });
            }
            self.engine.emit(EngineEvent::Level { session_id: self.id.clone(), rms_db: db, silent: db < -60.0 });
            self.level_acc.clear();
        }
        if let Some(ch) = self.chunker.as_mut() {
            let chunks = ch.push(&samples);
            for c in chunks {
                self.submit(c, Pass::Live, false);
            }
        }
    }

    fn start_live(&mut self, backfill: bool) {
        self.chunker = Some(Chunker::new(self.total_samples));
        if self.insight_tx.is_none() {
            let (tx, rx) = mpsc::unbounded_channel();
            self.insight_tx = Some(tx);
            self.insight_task = Some(tokio::spawn(insight_loop(self.engine.clone(), self.id.clone(), rx)));
        }
        if backfill && self.total_samples > 0 {
            // Everything recorded so far is transcribed at backfill priority.
            let upto = samples_to_ms(self.total_samples);
            let segs = self.archived_segments();
            let archived_end = segs.last().map(|s| s.end_ms).unwrap_or(0);
            let mut audio = mc_recorder::read_range(&segs, 0, archived_end).unwrap_or_default();
            audio.extend(self.recent.iter().copied());
            let audio_end = samples_to_ms(audio.len());
            let _ = upto;
            for c in mc_vad::chunk_all(&audio, 0) {
                if c.end_ms <= audio_end {
                    self.submit(c, Pass::Backfill, false);
                }
            }
        }
    }

    fn archived_segments(&self) -> Vec<SegmentInfo> {
        self.engine
            .store
            .segments(&self.id)
            .unwrap_or_default()
            .into_iter()
            .map(|(seq, start_ms, end_ms, path, bytes, sha256)| SegmentInfo { seq, start_ms, end_ms, path: path.into(), bytes, sha256 })
            .collect()
    }

    fn set_mode(&mut self, mode: SummaryMode) {
        if mode == self.mode {
            return;
        }
        let was_live = self.mode == SummaryMode::Live;
        self.mode = mode;
        if mode == SummaryMode::Live {
            self.start_live(true);
        } else if was_live {
            if let Some(mut ch) = self.chunker.take() {
                if let Some(c) = ch.finish() {
                    self.submit(c, Pass::Live, false);
                }
            }
        }
        self.engine.emit(EngineEvent::Status { session_id: self.id.clone(), status: "capturing".into(), detail: Some(format!("mode: {}", mode.as_str())) });
    }

    /// Queues one speech chunk; the result is stored and forwarded to the insight loop.
    fn submit(&self, chunk: SpeechChunk, pass: Pass, correct: bool) {
        let rx = self.engine.scheduler().submit(&self.id, pass, chunk.start_ms, chunk.samples.clone(), None);
        let engine = self.engine.clone();
        let id = self.id.clone();
        let pending = self.pending.clone();
        let done = self.pending_done.clone();
        let insight_tx = self.insight_tx.clone();
        pending.fetch_add(1, Ordering::AcqRel);
        tokio::spawn(async move {
            let started = Instant::now();
            let result = rx.await.unwrap_or_else(|_| Err(anyhow::anyhow!("scheduler dropped job")));
            match result {
                Ok(segments) => {
                    let adapter = engine.scheduler().adapter();
                    let minutes = (chunk.end_ms - chunk.start_ms) as f64 / 60_000.0;
                    let usd = adapter.usd_per_minute() * minutes;
                    let _ = engine.store.add_usage(Some(&id), &adapter.id(), "minutes", minutes, usd);
                    let superseded = if correct { engine.store.supersede_range(&id, chunk.start_ms, chunk.end_ms).unwrap_or_default() } else { vec![] };
                    let mut stored = Vec::new();
                    for (i, s) in segments.into_iter().enumerate() {
                        let start = chunk.start_ms + s.start_ms;
                        let end = (chunk.start_ms + s.end_ms).max(start + 1);
                        let e = TranscriptEvent {
                            id: new_id(),
                            session_id: id.clone(),
                            start_ms: start,
                            end_ms: end,
                            media_start_ms: engine.store.media_time_at(&id, start).ok().flatten(),
                            revision: 1,
                            state: if correct { "corrected".into() } else { "final".into() },
                            supersedes: if correct { superseded.get(i).cloned().or_else(|| superseded.first().cloned()) } else { None },
                            text: s.text,
                            lang: s.lang,
                            engine: adapter.id(),
                        };
                        if let Err(err) = engine.store.insert_transcript(&e, pass.as_str()) {
                            tracing::error!(error = %err, "transcript insert failed");
                            continue;
                        }
                        engine.emit(EngineEvent::Transcript { session_id: id.clone(), event: e.clone() });
                        stored.push(e);
                    }
                    tracing::debug!(session = %id, ms = started.elapsed().as_millis() as u64, n = stored.len(), "chunk transcribed");
                    if let (Some(tx), false) = (insight_tx, stored.is_empty()) {
                        let _ = tx.send(stored);
                    }
                }
                Err(e) => {
                    tracing::warn!(session = %id, error = %e, "transcription failed");
                    let _ = engine.store.add_gap(&id, chunk.start_ms, chunk.end_ms, "asr_failed");
                    engine.emit(EngineEvent::Status { session_id: id.clone(), status: "capturing".into(), detail: Some(format!("asr_error: {e}")) });
                }
            }
            pending.fetch_sub(1, Ordering::AcqRel);
            done.notify_waiters();
        });
    }

    async fn wait_pending(&self) {
        loop {
            let notified = self.pending_done.notified();
            if self.pending.load(Ordering::Acquire) == 0 {
                return;
            }
            let _ = tokio::time::timeout(Duration::from_secs(5), notified).await;
        }
    }

    async fn finish(mut self, reason: String, mut rx: mpsc::Receiver<SessionMsg>) {
        self.handle.detach_capture();
        // Drain audio already queued before the stop.
        while let Ok(msg) = rx.try_recv() {
            if let SessionMsg::Audio(s) = msg {
                self.on_audio(s);
            }
        }
        let failure = (reason != "user").then_some(reason.as_str());
        let _ = self.engine.store.set_status(&self.id, "stopping", failure);
        self.engine.emit(EngineEvent::Status { session_id: self.id.clone(), status: "stopping".into(), detail: Some(reason.clone()) });
        let _ = self.engine.store.set_audio_ms(&self.id, samples_to_ms(self.total_samples));
        if let Some(r) = self.recorder.take() {
            let _ = tokio::task::spawn_blocking(move || r.finish()).await;
        }
        if let Some(mut ch) = self.chunker.take() {
            if let Some(c) = ch.finish() {
                self.submit(c, Pass::Live, false);
            }
        }
        match self.mode {
            SummaryMode::Off => {}
            SummaryMode::Live => {
                self.wait_pending().await;
            }
            SummaryMode::After => {
                // Whole-recording pass; replaces any live text from before a mode switch.
                let had_live = !self.engine.store.transcript(&self.id).unwrap_or_default().is_empty();
                let segs = self.archived_segments();
                let end = segs.last().map(|s| s.end_ms).unwrap_or(0);
                let audio = mc_recorder::read_range(&segs, 0, end).unwrap_or_default();
                if self.insight_tx.is_none() {
                    let (tx, rx) = mpsc::unbounded_channel();
                    self.insight_tx = Some(tx);
                    self.insight_task = Some(tokio::spawn(insight_loop(self.engine.clone(), self.id.clone(), rx)));
                }
                for c in mc_vad::chunk_all(&audio, 0) {
                    self.submit(c, Pass::After, had_live);
                }
                self.wait_pending().await;
                let _ = mc_insight::demote_stale(&self.engine.store, &self.id);
            }
        }
        // Close the insight loop (it runs a final reduce on what it has) and write the report.
        self.insight_tx = None;
        if let Some(t) = self.insight_task.take() {
            let _ = t.await;
        }
        if self.mode != SummaryMode::Off {
            if let Some(llm) = self.engine.llm() {
                let lang = self.engine.config().output_lang;
                let title = self.engine.store.session(&self.id).ok().flatten().map(|s| s.title).unwrap_or(self.title.clone());
                match mc_insight::report(&self.engine.store, &llm, &self.id, &lang, &title).await {
                    Ok(usage) => {
                        if let Some(u) = usage {
                            let _ = self.engine.store.add_usage(Some(&self.id), &format!("{}:{}", u.provider, u.model), "tokens", (u.input_tokens + u.output_tokens) as f64, u.usd);
                        }
                        self.engine.emit(EngineEvent::Report { session_id: self.id.clone(), is_final: true });
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "report failed");
                        self.engine.emit(EngineEvent::Status { session_id: self.id.clone(), status: "stopping".into(), detail: Some(format!("report_error: {e}")) });
                    }
                }
            }
        }
        let final_status = if reason.starts_with("capture_failed") { "failed" } else { "stopped" };
        let _ = self.engine.store.set_status(&self.id, final_status, failure);
        self.engine.emit(EngineEvent::Status { session_id: self.id.clone(), status: final_status.into(), detail: Some(reason) });
    }
}

/// Rolling key points: every 45 s of transcript or 400 words / 800 CJK characters, whichever first.
async fn insight_loop(engine: Arc<Engine>, id: String, mut rx: mpsc::UnboundedReceiver<Vec<TranscriptEvent>>) {
    let mut buf: Vec<TranscriptEvent> = Vec::new();
    let mut last_run = Instant::now();
    let mut open = true;
    while open {
        let next = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await;
        match next {
            Ok(Some(events)) => buf.extend(events),
            Ok(None) => open = false,
            Err(_) => {}
        }
        let words: usize = buf.iter().map(|e| e.text.split_whitespace().count().max(e.text.chars().count() / 2)).sum();
        let due = !buf.is_empty() && (words >= 400 || last_run.elapsed() >= Duration::from_secs(45) || !open);
        if !due {
            continue;
        }
        let Some(llm) = engine.llm() else {
            buf.clear();
            continue;
        };
        if engine.over_budget() {
            buf.clear();
            continue;
        }
        buf.sort_by_key(|e| e.start_ms);
        let batch = std::mem::take(&mut buf);
        let lang = engine.config().output_lang;
        for part in batch.chunks(40) {
            match mc_insight::reduce(&engine.store, &llm, &id, part, &lang).await {
                Ok((outcome, usage)) => {
                    if let Some(u) = usage {
                        let _ = engine.store.add_usage(Some(&id), &format!("{}:{}", u.provider, u.model), "tokens", (u.input_tokens + u.output_tokens) as f64, u.usd);
                    }
                    for i in outcome.applied {
                        engine.emit(EngineEvent::Insight { session_id: id.clone(), insight: i });
                    }
                    if !outcome.rejected.is_empty() {
                        tracing::debug!(session = %id, rejected = ?outcome.rejected, "insight ops rejected");
                    }
                }
                Err(e) => {
                    tracing::warn!(session = %id, error = %e, "insight round failed");
                    engine.emit(EngineEvent::Status { session_id: id.clone(), status: "capturing".into(), detail: Some(format!("model_error: {e}")) });
                }
            }
        }
        last_run = Instant::now();
    }
}
