//! One supervised pipeline per source. The capture side never waits on transcription:
//! archive writing runs on its own thread, transcription is queued, model calls run on their own task.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicI64, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use mc_asr::Pass;
use mc_core::{new_id, samples_to_ms, EngineEvent, RecordingFormat, SourceKind, SummaryMode, TranscriptEvent, SAMPLE_RATE};
use mc_recorder::{SegmentInfo, SegmentWriter};
use mc_vad::{Chunker, SpeechChunk};
use tokio::sync::{mpsc, oneshot, Notify};

use crate::Engine;

/// Tab frames are 100 ms (1600 samples).
pub const TAB_FRAME_SAMPLES: usize = 1600;
/// Longest silence inserted for a seq gap before the frame is treated as a new stream position.
/// `transcript_events.pass` for platform subtitle text.
pub(crate) const CAPTIONS_PASS: &str = "captions";
const MAX_GAP_FILL_FRAMES: u32 = 600;
const AUDIO_START_DB: f32 = -55.0;

pub enum SessionMsg {
    Audio(Vec<f32>),
    Mode(SummaryMode),
    Pause(bool),
    Preview(oneshot::Sender<anyhow::Result<PausedAudio>>),
    Gap { start_ms: i64, end_ms: i64, cause: String },
    Status(String, Option<String>),
    Stop { reason: String },
    /// A platform subtitle line at session time `at_ms`.
    Caption { at_ms: i64, dur_ms: i64, text: String, source: mc_core::CaptionSource },
    /// Subtitles playing (`active`) at session time `at_ms`.
    CaptionState { at_ms: i64, active: bool, source: Option<mc_core::CaptionSource>, policy: TextPolicy },
}

/// What happens to speech recognition while platform subtitles are available (extension setting).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextPolicy {
    /// Subtitles where the video has them, speech recognition for everything else.
    Auto,
    /// Subtitles only: speech recognition never runs for this recording.
    CaptionsOnly,
}

/// A chunk counts as covered by subtitles when they were playing for this share of it.
const CAPTION_COVERAGE: f64 = 0.8;
/// Each "subtitles playing" heartbeat (about once a second) covers this much session time around it.
const CAPTION_HEARTBEAT_BEFORE_MS: i64 = 1500;
const CAPTION_HEARTBEAT_AFTER_MS: i64 = 500;

/// Session-time ranges during which platform subtitles were playing (merged, sorted).
#[derive(Debug, Default)]
pub(crate) struct Coverage(Vec<(i64, i64)>);

impl Coverage {
    pub(crate) fn add(&mut self, start: i64, end: i64) {
        if end <= start {
            return;
        }
        if let Some(last) = self.0.last_mut() {
            if start <= last.1 && start >= last.0 {
                last.1 = last.1.max(end);
                return;
            }
        }
        self.0.push((start, end));
        self.0.sort_unstable();
        let mut merged: Vec<(i64, i64)> = Vec::with_capacity(self.0.len());
        for (s, e) in self.0.drain(..) {
            match merged.last_mut() {
                Some(m) if s <= m.1 => m.1 = m.1.max(e),
                _ => merged.push((s, e)),
            }
        }
        self.0 = merged;
    }

    /// Share of `[start, end)` that is covered.
    pub(crate) fn share(&self, start: i64, end: i64) -> f64 {
        if end <= start {
            return 0.0;
        }
        let covered: i64 = self.0.iter().map(|&(s, e)| (e.min(end) - s.max(start)).max(0)).sum();
        covered as f64 / (end - start) as f64
    }
}

#[allow(dead_code)]
pub struct SessionHandle {
    pub id: String,
    pub kind: SourceKind,
    pub capture_source_id: Option<String>,
    /// Browser bundle id for tab sessions.
    pub browser: Option<String>,
    pub tx: mpsc::Sender<SessionMsg>,
    /// Samples accepted so far (the session clock).
    samples: Arc<AtomicU64>,
    wait_for_audio: bool,
    format: RecordingFormat,
    input: Mutex<CaptureInput>,
    /// Tab ingest: next expected seq and wall clock of the last frame.
    next_seq: AtomicU32,
    seq_started: std::sync::atomic::AtomicBool,
    last_wall_ms: AtomicI64,
    last_wall_session_ms: AtomicI64,
    dropped: AtomicUsize,
    #[cfg(target_os = "macos")]
    capture: Mutex<Option<mc_capture_macos::AppCapture>>,
    #[cfg(target_os = "macos")]
    microphone: Mutex<Option<mc_capture_macos::MicCapture>>,
}

struct CaptureInput {
    pre_roll: Option<Vec<f32>>,
    paused: bool,
    closed: bool,
}

impl SessionHandle {
    pub fn session_ms(&self) -> i64 {
        self.format.duration_ms(self.samples.load(Ordering::Relaxed) as usize)
    }

    pub fn waiting_for_audio(&self) -> bool {
        self.wait_for_audio && self.samples.load(Ordering::Relaxed) == 0
    }

    pub fn paused(&self) -> bool {
        self.input.lock().unwrap().paused
    }

    /// Whether an app recording is silenced on the speakers (`None` for other sources).
    pub fn mute_playback(&self) -> Option<bool> {
        #[cfg(target_os = "macos")]
        if let Some(capture) = self.capture.lock().unwrap().as_ref() {
            return Some(capture.mute_playback());
        }
        None
    }

    pub fn set_mute_playback(&self, mute_playback: bool) -> anyhow::Result<()> {
        #[cfg(target_os = "macos")]
        if let Some(capture) = self.capture.lock().unwrap().as_ref() {
            capture.set_mute_playback(mute_playback);
            return Ok(());
        }
        let _ = mute_playback;
        anyhow::bail!("This source has no playback to mute")
    }

    pub fn capture_closed(&self) -> bool {
        self.input.lock().unwrap().closed
    }

    pub fn set_paused(&self, paused: bool) -> anyhow::Result<()> {
        let mut input = self.input.lock().unwrap();
        anyhow::ensure!(!input.closed, "Recording is finishing");
        if input.paused != paused {
            self.tx.try_send(SessionMsg::Pause(paused)).map_err(|e| anyhow::anyhow!("session busy: {e}"))?;
            input.paused = paused;
            if paused {
                if let Some(pre_roll) = &mut input.pre_roll {
                    pre_roll.clear();
                }
            }
        }
        Ok(())
    }

    pub fn session_ms_at_wall(&self, wall_ms: f64) -> i64 {
        let last_wall = self.last_wall_ms.load(Ordering::Relaxed);
        if last_wall == 0 {
            return self.session_ms();
        }
        (self.last_wall_session_ms.load(Ordering::Relaxed) + (wall_ms as i64 - last_wall)).max(0)
    }

    fn push_audio(&self, mut samples: Vec<f32>) {
        let mut input = self.input.lock().unwrap();
        if input.paused || input.closed {
            return;
        }
        if let Some(pre_roll) = input.pre_roll.as_mut() {
            if mc_audio::rms_db(&samples) < AUDIO_START_DB {
                let pre_roll_samples = self.format.sample_rate as usize / 5;
                let tail = samples.len().saturating_sub(pre_roll_samples);
                pre_roll.extend_from_slice(&samples[tail..]);
                let excess = pre_roll.len().saturating_sub(pre_roll_samples);
                pre_roll.drain(..excess);
                return;
            }
            pre_roll.append(&mut samples);
            samples = std::mem::take(pre_roll);
        }
        let n = samples.len() as u64;
        match self.tx.try_send(SessionMsg::Audio(samples)) {
            Ok(()) => {
                self.samples.fetch_add(n, Ordering::Relaxed);
                input.pre_roll = None;
            }
            Err(_) => {
                // Session task is behind: count it; the gap is recorded when it catches up.
                self.dropped.fetch_add(n as usize, Ordering::Relaxed);
            }
        }
    }

    /// Accepts one tab frame; fills seq gaps with silence (recorded as a gap) and drops duplicates.
    pub fn ingest(&self, seq: u32, wall_ms: f64, pcm: &[i16]) -> anyhow::Result<u32> {
        anyhow::ensure!(!self.capture_closed(), "Recording has ended");
        if !self.seq_started.swap(true, Ordering::AcqRel) {
            self.next_seq.store(seq, Ordering::Release);
        }
        let expected = self.next_seq.load(Ordering::Acquire);
        if seq < expected {
            return Ok(expected.saturating_sub(1));
        }
        if seq > expected && !self.waiting_for_audio() && !self.paused() {
            let missing = (seq - expected).min(MAX_GAP_FILL_FRAMES);
            let start_ms = self.session_ms();
            self.push_audio(vec![0.0; missing as usize * TAB_FRAME_SAMPLES]);
            let _ = self.tx.try_send(SessionMsg::Gap { start_ms, end_ms: self.session_ms(), cause: "ws_gap".into() });
        }
        let samples: Vec<f32> = pcm.iter().map(|s| mc_audio::i16_to_f32(*s)).collect();
        self.push_audio(samples);
        self.next_seq.store(seq + 1, Ordering::Release);
        if wall_ms > 0.0 && !self.waiting_for_audio() && !self.paused() {
            self.last_wall_ms.store(wall_ms as i64, Ordering::Relaxed);
            self.last_wall_session_ms.store(self.session_ms(), Ordering::Relaxed);
        }
        Ok(seq)
    }

    #[cfg(target_os = "macos")]
    pub fn attach_app_capture(self: &Arc<Self>, app_id: String, mute_playback: bool) -> anyhow::Result<()> {
        let sink = self.capture_sink();
        let me = Arc::downgrade(self);
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
        let cap = mc_capture_macos::AppCapture::start(app_id, mute_playback, self.format.sample_rate, sink, events)?;
        *self.capture.lock().unwrap() = Some(cap);
        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn capture_sink(self: &Arc<Self>) -> mc_capture_macos::AudioSink {
        let handle = Arc::downgrade(self);
        Arc::new(move |samples: &[f32]| {
            if let Some(handle) = handle.upgrade() {
                handle.push_audio(samples.to_vec());
            }
        })
    }

    #[cfg(target_os = "macos")]
    pub fn attach_microphone(self: &Arc<Self>, id: &str) -> anyhow::Result<()> {
        let handle = Arc::downgrade(self);
        let events = Arc::new(move |event| {
            if let (Some(handle), mc_capture_macos::CaptureEvent::Error(error)) = (handle.upgrade(), event) {
                let _ = handle.tx.try_send(SessionMsg::Stop { reason: format!("capture_failed: {error}") });
            }
        });
        let mic = mc_capture_macos::MicCapture::start(id, self.format.sample_rate, self.capture_sink(), events)?;
        *self.microphone.lock().unwrap() = Some(mic);
        Ok(())
    }

    fn detach_capture(&self) {
        #[cfg(target_os = "macos")]
        {
            let cap = self.capture.lock().unwrap().take();
            drop(cap);
            let microphone = self.microphone.lock().unwrap().take();
            drop(microphone);
        }
    }
}

pub fn spawn(engine: Arc<Engine>, id: String, kind: SourceKind, title: String, mode: SummaryMode, (capture_source_id, browser): (Option<String>, Option<String>), (wait_for_audio, format): (bool, RecordingFormat)) -> anyhow::Result<Arc<SessionHandle>> {
    let (tx, rx) = mpsc::channel(4096);
    let handle = Arc::new(SessionHandle {
        id: id.clone(),
        kind,
        capture_source_id,
        browser,
        tx,
        samples: Arc::new(AtomicU64::new(0)),
        wait_for_audio,
        format,
        input: Mutex::new(CaptureInput { pre_roll: wait_for_audio.then(Vec::new), paused: false, closed: false }),
        next_seq: AtomicU32::new(0),
        seq_started: Default::default(),
        last_wall_ms: AtomicI64::new(0),
        last_wall_session_ms: AtomicI64::new(0),
        dropped: AtomicUsize::new(0),
        #[cfg(target_os = "macos")]
        capture: Mutex::new(None),
        #[cfg(target_os = "macos")]
        microphone: Mutex::new(None),
    });
    let dir = engine.session_dir(&id);
    let normalize = mc_audio::StreamResampler::new(format.sample_rate)?;
    let recorder = RecorderThread::start(engine.clone(), id.clone(), &dir, format)?;
    let h2 = handle.clone();
    tokio::spawn(async move {
        let task = SessionTask::new(engine.clone(), id.clone(), title, mode, recorder, h2.clone(), normalize);
        task.run(rx).await;
        h2.detach_capture();
        engine.forget(&id);
    });
    Ok(handle)
}

pub struct PausedAudio {
    segments: Vec<SegmentInfo>,
    tail: Vec<f32>,
    format: RecordingFormat,
}

impl PausedAudio {
    pub fn wav(self) -> anyhow::Result<Vec<u8>> {
        let (_, mut samples) = mc_recorder::read_archive(&self.segments, 0, None)?;
        samples.extend(self.tail);
        anyhow::ensure!(!samples.is_empty(), "No audio recorded yet");
        mc_audio::encode_wav_with_format(&samples, self.format)
    }
}

enum RecorderMsg {
    Audio(Vec<f32>),
    Preview(oneshot::Sender<anyhow::Result<PausedAudio>>),
    Finish,
}

/// Archive writer on its own OS thread so FLAC encoding never stalls the session loop.
struct RecorderThread {
    tx: std::sync::mpsc::Sender<RecorderMsg>,
    join: Option<std::thread::JoinHandle<Vec<SegmentInfo>>>,
}

impl RecorderThread {
    fn start(engine: Arc<Engine>, id: String, dir: &std::path::Path, format: RecordingFormat) -> anyhow::Result<Self> {
        let mut writer = SegmentWriter::new(dir, 0, 0, format)?;
        let (tx, rx) = std::sync::mpsc::channel();
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
            while let Ok(message) = rx.recv() {
                match message {
                    RecorderMsg::Audio(samples) => match writer.push(&samples) {
                        Ok(segs) => store(segs, &mut all),
                        Err(e) => {
                            tracing::error!(error = %e, "archive write failed");
                            engine.emit(EngineEvent::Status { session_id: id.clone(), status: "capturing".into(), detail: Some(format!("storage_error: {e}")) });
                        }
                    },
                    RecorderMsg::Preview(reply) => {
                        let _ = reply.send(Ok(PausedAudio { segments: all.clone(), tail: writer.buffered_audio().to_vec(), format }));
                    }
                    RecorderMsg::Finish => break,
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
        let _ = self.tx.send(RecorderMsg::Audio(samples));
    }

    fn finish(mut self) -> Vec<SegmentInfo> {
        let _ = self.tx.send(RecorderMsg::Finish);
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
    archive_samples: usize,
    normalize: mc_audio::StreamResampler,
    /// Audio since the start of the current archive minute (for backfill before the segment is written).
    recent: VecDeque<f32>,
    pending: Arc<AtomicUsize>,
    pending_done: Arc<Notify>,
    insight_tx: Option<mpsc::UnboundedSender<Vec<TranscriptEvent>>>,
    insight_task: Option<tokio::task::JoinHandle<()>>,
    level_acc: Vec<f32>,
    dropout: mc_audio::DropoutDetector,
    reported_drops: usize,
    paused: bool,
    peaks: Vec<f32>,
    peak: f32,
    peak_samples: usize,
    caption_source: Option<mc_core::CaptionSource>,
    caption_active: bool,
    caption_policy: TextPolicy,
    coverage: Coverage,
}

impl SessionTask {
    fn new(engine: Arc<Engine>, id: String, title: String, mode: SummaryMode, recorder: RecorderThread, handle: Arc<SessionHandle>, normalize: mc_audio::StreamResampler) -> Self {
        let mut t = Self {
            engine,
            id,
            title,
            mode,
            recorder: Some(recorder),
            handle,
            chunker: None,
            total_samples: 0,
            archive_samples: 0,
            normalize,
            recent: VecDeque::new(),
            pending: Arc::new(AtomicUsize::new(0)),
            pending_done: Arc::new(Notify::new()),
            insight_tx: None,
            insight_task: None,
            level_acc: Vec::new(),
            dropout: Default::default(),
            reported_drops: 0,
            paused: false,
            peaks: Vec::new(),
            peak: 0.0,
            peak_samples: 0,
            caption_source: None,
            caption_active: false,
            caption_policy: TextPolicy::Auto,
            coverage: Coverage::default(),
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
                    Some(SessionMsg::Pause(paused)) => self.set_paused(paused),
                    Some(SessionMsg::Preview(reply)) => {
                        if !self.paused {
                            let _ = reply.send(Err(anyhow::anyhow!("Pause this recording to review its audio")));
                        } else if let Some(recorder) = &self.recorder {
                            let _ = recorder.tx.send(RecorderMsg::Preview(reply));
                        }
                    }
                    Some(SessionMsg::Gap { start_ms, end_ms, cause }) => {
                        let _ = self.engine.store.add_gap(&self.id, start_ms, end_ms, &cause);
                        self.engine.emit(EngineEvent::Gap { session_id: self.id.clone(), start_ms, end_ms, cause });
                    }
                    Some(SessionMsg::Status(status, detail)) => {
                        let status = if self.paused || self.awaiting_audio() { self.status().into() } else { status };
                        self.engine.emit(EngineEvent::Status { session_id: self.id.clone(), status, detail });
                    }
                    Some(SessionMsg::Caption { at_ms, dur_ms, text, source }) => self.on_caption(at_ms, dur_ms, text, source),
                    Some(SessionMsg::CaptionState { at_ms, active, source, policy }) => self.on_caption_state(at_ms, active, source, policy),
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
            let ms = self.handle.format.duration_ms(dropped - self.reported_drops);
            let at = samples_to_ms(self.total_samples);
            let _ = self.engine.store.add_gap(&self.id, at, at + ms, "backpressure");
            self.reported_drops = dropped;
        }
        if !self.paused && !self.awaiting_audio() && self.mode == SummaryMode::Live && self.engine.over_budget() {
            self.engine.emit(EngineEvent::Status { session_id: self.id.clone(), status: "capturing".into(), detail: Some("budget_exceeded: switched to after".into()) });
            let _ = self.engine.store.set_summary_mode(&self.id, "after");
            self.set_mode(SummaryMode::After);
        }
        let backlog = self.engine.scheduler().pending(&self.id);
        if backlog > 0 {
            self.engine.emit(EngineEvent::Backlog { session_id: self.id.clone(), pending_chunks: backlog });
        }
    }

    fn awaiting_audio(&self) -> bool {
        self.handle.wait_for_audio && self.archive_samples == 0
    }

    fn status(&self) -> &'static str {
        if self.paused { "paused" } else if self.awaiting_audio() { "waiting" } else { "capturing" }
    }

    fn set_paused(&mut self, paused: bool) {
        self.paused = paused;
        if paused {
            if let Some(mut chunker) = self.chunker.take() {
                if let Some(chunk) = chunker.finish() {
                    self.submit(chunk, Pass::Live, false);
                }
            }
        } else if self.mode == SummaryMode::Live && self.chunker.is_none() {
            self.chunker = Some(Chunker::new(self.total_samples));
        }
        let status = self.status();
        let _ = self.engine.store.set_status(&self.id, status, None);
        self.engine.emit(EngineEvent::Status { session_id: self.id.clone(), status: status.into(), detail: None });
    }

    fn on_audio(&mut self, samples: Vec<f32>) {
        if self.awaiting_audio() {
            let _ = self.engine.store.set_status(&self.id, "capturing", None);
            self.engine.emit(EngineEvent::Status { session_id: self.id.clone(), status: "capturing".into(), detail: None });
        }
        self.archive_samples += samples.len();
        let normalized = self.normalize.push(&samples);
        if let Some(r) = &self.recorder {
            r.push(samples);
        }
        let samples = normalized;
        let seg_len = SAMPLE_RATE as usize * mc_recorder::SEGMENT_SECONDS;
        self.total_samples += samples.len();
        for sample in &samples {
            self.peak = self.peak.max(sample.abs());
            self.peak_samples += 1;
            if self.peak_samples == SAMPLE_RATE as usize / 40 {
                self.peaks.push(std::mem::take(&mut self.peak));
                self.peak_samples = 0;
            }
        }
        if self.peaks.len() >= 8 {
            self.engine.emit(EngineEvent::Waveform {
                session_id: self.id.clone(),
                peaks: std::mem::take(&mut self.peaks),
                audio_ms: samples_to_ms(self.total_samples),
            });
        }
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
        self.engine.emit(EngineEvent::Status { session_id: self.id.clone(), status: self.status().into(), detail: Some(format!("mode: {}", mode.as_str())) });
    }

    fn on_caption_state(&mut self, at_ms: i64, active: bool, source: Option<mc_core::CaptionSource>, policy: TextPolicy) {
        self.caption_policy = policy;
        if active && source.is_some() {
            self.coverage.add(at_ms - CAPTION_HEARTBEAT_BEFORE_MS, at_ms + CAPTION_HEARTBEAT_AFTER_MS);
        }
        let active = active && source.is_some();
        if source != self.caption_source || active != self.caption_active {
            self.caption_source = source.clone();
            self.caption_active = active;
            self.engine.emit(EngineEvent::TextSource { session_id: self.id.clone(), source, active });
        }
    }

    /// Stores a platform subtitle line as transcript text (no speech recognition cost).
    fn on_caption(&mut self, at_ms: i64, dur_ms: i64, text: String, source: mc_core::CaptionSource) {
        if self.paused || self.awaiting_audio() || self.mode == SummaryMode::Off {
            return;
        }
        let start = at_ms.clamp(0, samples_to_ms(self.total_samples).max(0) + 2000);
        let e = TranscriptEvent {
            id: new_id(),
            session_id: self.id.clone(),
            start_ms: start,
            end_ms: start + dur_ms.max(1),
            media_start_ms: self.engine.store.media_time_at(&self.id, start).ok().flatten(),
            revision: 1,
            state: "final".into(),
            supersedes: None,
            text,
            lang: source.lang.clone(),
            engine: source.engine_id(),
        };
        if let Err(err) = self.engine.store.insert_transcript(&e, CAPTIONS_PASS) {
            tracing::warn!(error = %err, "caption insert failed");
            return;
        }
        self.engine.emit(EngineEvent::Transcript { session_id: self.id.clone(), event: e.clone() });
        if let Some(tx) = &self.insight_tx {
            let _ = tx.send(vec![e]);
        }
    }

    /// Speech recognition is skipped where platform subtitles already give the text.
    fn covered_by_captions(&self, chunk: &SpeechChunk) -> bool {
        if self.caption_policy == TextPolicy::CaptionsOnly && self.caption_source.is_some() {
            return true;
        }
        self.coverage.share(chunk.start_ms, chunk.end_ms) >= CAPTION_COVERAGE
    }

    /// Queues one speech chunk; the result is stored and forwarded to the insight loop.
    fn submit(&self, chunk: SpeechChunk, pass: Pass, correct: bool) {
        if self.covered_by_captions(&chunk) {
            tracing::debug!(session = %self.id, start = chunk.start_ms, "chunk covered by platform subtitles; no ASR");
            return;
        }
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
                    let stored = store_segments(&engine, &id, chunk.start_ms, chunk.end_ms, segments, pass, correct);
                    tracing::debug!(session = %id, ms = started.elapsed().as_millis() as u64, n = stored.len(), "chunk transcribed");
                    if let (Some(tx), false) = (insight_tx, stored.is_empty()) {
                        let _ = tx.send(stored);
                    }
                }
                Err(e) => record_asr_failure(&engine, &id, chunk.start_ms, chunk.end_ms, pass, &e),
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

    async fn finish(mut self, mut reason: String, mut rx: mpsc::Receiver<SessionMsg>) {
        self.handle.input.lock().unwrap().closed = true;
        self.handle.detach_capture();
        // Drain audio already queued before the stop.
        while let Ok(msg) = rx.try_recv() {
            if let SessionMsg::Audio(s) = msg {
                self.on_audio(s);
            }
        }
        if reason == crate::CANCELLED {
            return self.discard().await;
        }
        if reason == "user" && self.awaiting_audio() {
            reason = "no_audio".into();
        }
        let failure = (reason != "user").then_some(reason.as_str());
        let _ = self.engine.store.set_status(&self.id, "stopping", failure);
        self.engine.emit(EngineEvent::Status { session_id: self.id.clone(), status: "stopping".into(), detail: Some(reason.clone()) });
        let _ = self.engine.store.set_audio_ms(&self.id, self.handle.format.duration_ms(self.archive_samples));
        if let Some(r) = self.recorder.take() {
            let _ = tokio::task::spawn_blocking(move || r.finish()).await;
        }
        if self.mode != SummaryMode::Off && self.total_samples > 0 {
            let _ = self.engine.store.set_status(&self.id, "processing", None);
            self.engine.emit(EngineEvent::Status { session_id: self.id.clone(), status: "processing".into(), detail: None });
        }
        if let Some(mut ch) = self.chunker.take() {
            if let Some(c) = ch.finish() {
                self.submit(c, Pass::Live, false);
            }
        }
        match if self.awaiting_audio() { SummaryMode::Off } else { self.mode } {
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
                    // Subtitle text stored during the recording feeds the key points too.
                    let captions: Vec<TranscriptEvent> = self.engine.store.transcript(&self.id).unwrap_or_default().into_iter().filter(|e| e.engine.starts_with("caption:")).collect();
                    if !captions.is_empty() {
                        let _ = tx.send(captions);
                    }
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
        if self.mode != SummaryMode::Off && !self.awaiting_audio() {
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

impl SessionTask {
    /// Ends a cancelled recording: closes the audio file, stops the summary, then deletes everything.
    async fn discard(mut self) {
        let _ = self.engine.store.set_status(&self.id, "stopping", Some(crate::CANCELLED));
        self.engine.emit(EngineEvent::Status { session_id: self.id.clone(), status: "stopping".into(), detail: Some(crate::CANCELLED.into()) });
        if let Some(r) = self.recorder.take() {
            let _ = tokio::task::spawn_blocking(move || r.finish()).await;
        }
        self.chunker = None;
        self.insight_tx = None;
        if let Some(task) = self.insight_task.take() {
            task.abort();
        }
        if let Err(e) = self.engine.remove_session_data(&self.id) {
            tracing::warn!(session = %self.id, error = %e, "could not delete a cancelled recording");
        }
        self.engine.emit(EngineEvent::Status { session_id: self.id.clone(), status: "stopped".into(), detail: Some(crate::CANCELLED.into()) });
    }
}

/// Stores the segments of one transcribed chunk as transcript events and emits them.
/// `correct` replaces live text over the same range (after-mode pass over a live session).
pub(crate) fn store_segments(engine: &Arc<Engine>, id: &str, chunk_start: i64, chunk_end: i64, segments: Vec<mc_asr::AsrSegment>, pass: Pass, correct: bool) -> Vec<TranscriptEvent> {
    // A chunk still in flight when its recording was cancelled and deleted.
    if engine.store.session(id).ok().flatten().is_none() {
        return Vec::new();
    }
    let adapter = engine.scheduler().adapter();
    let minutes = (chunk_end - chunk_start) as f64 / 60_000.0;
    let _ = engine.store.add_usage(Some(id), &adapter.id(), "minutes", minutes, adapter.usd_per_minute() * minutes);
    let superseded = if correct { engine.store.supersede_range(id, chunk_start, chunk_end).unwrap_or_default() } else { vec![] };
    let mut stored = Vec::new();
    for (i, s) in segments.into_iter().enumerate() {
        let start = chunk_start + s.start_ms;
        let end = (chunk_start + s.end_ms).max(start + 1);
        let e = TranscriptEvent {
            id: new_id(),
            session_id: id.to_string(),
            start_ms: start,
            end_ms: end,
            media_start_ms: engine.store.media_time_at(id, start).ok().flatten(),
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
        engine.emit(EngineEvent::Transcript { session_id: id.to_string(), event: e.clone() });
        stored.push(e);
    }
    stored
}

/// A failed chunk is kept for retry; recording is never affected (design: ASR is best-effort).
pub(crate) fn record_asr_failure(engine: &Arc<Engine>, id: &str, start_ms: i64, end_ms: i64, pass: Pass, err: &anyhow::Error) {
    if engine.store.session(id).ok().flatten().is_none() {
        return;
    }
    tracing::warn!(session = %id, error = %err, "transcription failed; will retry");
    let msg = err.to_string();
    let _ = engine.store.add_asr_failure(id, start_ms, end_ms, pass.as_str(), &msg);
    let short: String = msg.chars().take(160).collect();
    let status = engine.store.session(id).ok().flatten().map(|s| s.status).unwrap_or_else(|| "capturing".into());
    engine.emit(EngineEvent::Status { session_id: id.to_string(), status, detail: Some(format!("asr_unavailable: {short}")) });
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
