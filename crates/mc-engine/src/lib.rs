//! The engine: one supervised pipeline per audio source (design 4.2). Shared by the desktop app,
//! the headless daemon and the local API.
#![allow(clippy::too_many_arguments)]

mod export;
mod retry;
mod session;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use mc_asr::{AsrAdapter, AsrSegment, Scheduler};
use mc_core::config::Config;
use mc_core::{EngineEvent, Insight, SourceKind, SourceSpec, SummaryMode, TranscriptEvent};
use mc_insight::Llm;
use mc_store::{NewSource, SessionRow, Store};
use serde::Serialize;
use tokio::sync::broadcast;

pub use export::ExportFormat;
pub use retry::{AsrHealth, RETRY_INTERVAL};
use session::{SessionHandle, SessionMsg};

/// Clamps how many sessions may capture at once (design: MAX_APP_TAPS = 8, tabs similar).
pub const MAX_ACTIVE_SESSIONS: usize = 16;

pub struct Engine {
    pub store: Arc<Store>,
    pub data_dir: PathBuf,
    config: RwLock<Config>,
    asr: Arc<Scheduler>,
    llm: RwLock<Option<Arc<dyn Llm>>>,
    events: broadcast::Sender<EngineEvent>,
    sessions: Mutex<HashMap<String, Arc<SessionHandle>>>,
    retry_notify: Arc<tokio::sync::Notify>,
    /// Sessions whose failed chunks are being retried right now.
    pub(crate) retrying: Mutex<HashSet<String>>,
}

/// Non-fatal notice returned when a session starts (design 4.4.1).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Warning {
    pub code: String,
    pub session_id: String,
}

#[derive(Debug, Default)]
pub struct StartOptions {
    pub force: bool,
    pub wait_for_audio: bool,
    pub mute_playback: bool,
    pub format: mc_core::RecordingFormat,
    pub browser_client_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Status {
    pub version: &'static str,
    pub data_dir: String,
    pub asr: String,
    pub asr_ready: bool,
    pub llm_ready: bool,
    pub active_sessions: usize,
    pub spent_today_usd: f64,
    pub daily_cap_usd: f64,
}

/// ASR adapter used when no key is configured: every request fails with a clear message.
struct Unconfigured(String);

#[async_trait::async_trait]
impl AsrAdapter for Unconfigured {
    fn id(&self) -> String {
        "unconfigured".into()
    }
    fn usd_per_minute(&self) -> f64 {
        0.0
    }
    async fn transcribe(&self, _: &[f32], _: Option<&str>) -> anyhow::Result<Vec<AsrSegment>> {
        anyhow::bail!("{}", self.0)
    }
}

/// The transcription adapter `config` asks for: the Multicorder service or the user's provider.
fn asr_from(config: &Config) -> Arc<dyn AsrAdapter> {
    if config.service.uses_service() {
        let base = config.service.base_url();
        if base.is_empty() {
            return Arc::new(Unconfigured("No Multicorder service address is set".into()));
        }
        return Arc::new(mc_asr::ServiceAsr::new(&base, &config.service.token, &config.service.env));
    }
    match mc_asr::from_config(&config.asr) {
        Ok(adapter) => adapter,
        Err(e) => Arc::new(Unconfigured(e.to_string())),
    }
}

fn llm_from(config: &Config) -> Option<Arc<dyn Llm>> {
    if config.service.uses_service() {
        let base = config.service.base_url();
        return (!base.is_empty()).then(|| mc_insight::ServiceLlm::new(&base, &config.service.token).ok().map(|l| Arc::new(l) as Arc<dyn Llm>)).flatten();
    }
    mc_insight::HttpLlm::from_config(&config.llm).ok().map(|l| Arc::new(l) as Arc<dyn Llm>)
}

impl Engine {
    /// Opens the data folder, recovers interrupted sessions and starts the schedulers.
    /// Must run inside a tokio runtime.
    pub fn start(data_dir: &Path) -> anyhow::Result<Arc<Self>> {
        std::fs::create_dir_all(data_dir)?;
        let config = Config::load_or_init(data_dir)?;
        Self::start_with(data_dir, config, None, None)
    }

    /// Test seam: inject adapters instead of building them from the config.
    pub fn start_with(data_dir: &Path, config: Config, asr: Option<Arc<dyn AsrAdapter>>, llm: Option<Arc<dyn Llm>>) -> anyhow::Result<Arc<Self>> {
        std::fs::create_dir_all(data_dir.join("audio"))?;
        let store = Arc::new(Store::open(&data_dir.join("mc.db"))?);
        let recovered = store.recover_on_start()?;
        for id in &recovered {
            mc_recorder::clean_partial(&data_dir.join("audio").join(id));
        }
        let asr = asr.unwrap_or_else(|| asr_from(&config));
        let llm = llm.or_else(|| llm_from(&config));
        let (events, _) = broadcast::channel(4096);
        let engine = Arc::new(Self {
            store,
            data_dir: data_dir.to_path_buf(),
            asr: Scheduler::new(asr, config.asr.concurrency),
            config: RwLock::new(config),
            llm: RwLock::new(llm),
            events,
            sessions: Mutex::new(HashMap::new()),
            retry_notify: Arc::new(tokio::sync::Notify::new()),
            retrying: Mutex::new(HashSet::new()),
        });
        retry::spawn_loop(Arc::downgrade(&engine), engine.retry_notify.clone());
        tracing::info!(recovered = recovered.len(), dir = %data_dir.display(), "engine started");
        Ok(engine)
    }

    pub fn config(&self) -> Config {
        self.config.read().unwrap().clone()
    }

    /// Saves a changed `config.json` and switches transcription and summaries to it at once.
    /// Chunks already queued use the new adapter when their turn comes.
    pub fn update_config(&self, change: impl FnOnce(&mut Config)) -> anyhow::Result<Config> {
        let mut next = self.config();
        change(&mut next);
        next.save(&self.data_dir)?;
        self.asr.set_adapter(asr_from(&next));
        *self.llm.write().unwrap() = llm_from(&next);
        *self.config.write().unwrap() = next.clone();
        self.retry_notify.notify_one();
        Ok(next)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<EngineEvent> {
        self.events.subscribe()
    }

    pub(crate) fn emit(&self, e: EngineEvent) {
        let _ = self.events.send(e);
    }

    pub(crate) fn llm(&self) -> Option<Arc<dyn Llm>> {
        self.llm.read().unwrap().clone()
    }

    pub(crate) fn scheduler(&self) -> &Arc<Scheduler> {
        &self.asr
    }

    pub(crate) fn over_budget(&self) -> bool {
        let cap = self.config.read().unwrap().daily_usd_cap;
        cap > 0.0 && self.store.spent_today().unwrap_or(0.0) >= cap
    }

    pub fn status(&self) -> Status {
        let adapter = self.asr.adapter();
        Status {
            version: env!("CARGO_PKG_VERSION"),
            data_dir: self.data_dir.display().to_string(),
            asr: adapter.id(),
            asr_ready: adapter.id() != "unconfigured",
            llm_ready: self.llm().is_some(),
            active_sessions: self.sessions.lock().unwrap().len(),
            spent_today_usd: self.store.spent_today().unwrap_or(0.0),
            daily_cap_usd: self.config.read().unwrap().daily_usd_cap,
        }
    }

    pub fn session_dir(&self, id: &str) -> PathBuf {
        self.data_dir.join("audio").join(id)
    }

    pub fn list_apps(&self) -> anyhow::Result<Vec<serde_json::Value>> {
        #[cfg(target_os = "macos")]
        {
            let (active, browsers): (std::collections::HashMap<String, bool>, Vec<String>) = {
                let sessions = self.sessions.lock().unwrap();
                (
                    sessions.values().filter(|h| h.kind == SourceKind::MacApp && !h.capture_closed()).filter_map(|h| h.capture_source_id.clone().map(|id| (id, h.waiting_for_audio()))).collect(),
                    sessions.values().filter(|h| h.kind == SourceKind::ChromiumTab && !h.capture_closed()).filter_map(|h| h.browser.clone()).collect(),
                )
            };
            Ok(mc_capture_macos::list_apps()?
                .into_iter()
                .map(|a| {
                    let mut v = serde_json::to_value(&a).unwrap_or_default();
                    v["capturing"] = serde_json::Value::Bool(active.contains_key(&a.app_id));
                    v["waiting_for_audio"] = serde_json::Value::Bool(active.get(&a.app_id).copied().unwrap_or_default());
                    v["tab_recording"] = serde_json::Value::Bool(browsers.contains(&a.app_id));
                    v
                })
                .collect())
        }
        #[cfg(not(target_os = "macos"))]
        Ok(vec![])
    }

    pub fn list_microphones(&self) -> anyhow::Result<Vec<serde_json::Value>> {
        #[cfg(target_os = "macos")]
        {
            let active: HashMap<_, _> = self.sessions.lock().unwrap().values()
                .filter(|h| h.kind == SourceKind::Mic && !h.capture_closed())
                .filter_map(|h| h.capture_source_id.clone().map(|id| (id, h.waiting_for_audio())))
                .collect();
            Ok(mc_capture_macos::list_microphones()?.into_iter().map(|mic| serde_json::json!({
                "id": mic.id,
                "name": mic.name,
                "is_default": mic.is_default,
                "channel": mic.channel,
                "capturing": active.contains_key(&mic.id),
                "waiting_for_audio": active.get(&mic.id).copied().unwrap_or_default(),
            })).collect())
        }
        #[cfg(not(target_os = "macos"))]
        Ok(vec![])
    }

    /// Starts capturing a source. Tab sessions then receive frames through `ingest_tab_frame`.
    pub fn start_session(self: &Arc<Self>, spec: SourceSpec, mode: SummaryMode, title: Option<String>) -> anyhow::Result<SessionRow> {
        self.start_session_opts(spec, mode, title, StartOptions::default()).map(|(row, _)| row)
    }

    /// Active tab sessions whose browser is `app_id` (design 4.4.1).
    pub fn tab_sessions_in_browser(&self, app_id: &str) -> Vec<String> {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .filter(|h| h.kind == SourceKind::ChromiumTab && !h.capture_closed() && h.browser.as_deref() == Some(app_id))
            .map(|h| h.id.clone())
            .collect()
    }

    /// Like `start_session`, with the duplicate-recording guard (design 4.4.1):
    /// recording a browser as a whole app while the extension records its tabs fails with
    /// `duplicate_browser_tabs:` unless `force`; a tab session in a browser that is already
    /// recorded as an app starts with a `browser_recorded_by_app` warning.
    pub fn start_session_opts(self: &Arc<Self>, spec: SourceSpec, mode: SummaryMode, title: Option<String>, options: StartOptions) -> anyhow::Result<(SessionRow, Vec<Warning>)> {
        let mut warnings = Vec::new();
        match &spec {
            SourceSpec::MacApp { app_id } if !options.force => {
                let tabs = self.tab_sessions_in_browser(app_id);
                if !tabs.is_empty() {
                    anyhow::bail!(
                        "duplicate_browser_tabs: {app_id} has tabs being recorded by the extension ({}); recording the whole browser would record them twice",
                        tabs.join(", ")
                    );
                }
            }
            SourceSpec::ChromiumTab { browser: Some(b), .. } => {
                for h in self.sessions.lock().unwrap().values() {
                    if h.kind == SourceKind::MacApp && !h.capture_closed() && h.capture_source_id.as_deref() == Some(b.as_str()) {
                        warnings.push(Warning { code: "browser_recorded_by_app".into(), session_id: h.id.clone() });
                    }
                }
            }
            _ => {}
        }
        if !mc_recorder::has_disk_reserve(&self.data_dir) {
            anyhow::bail!("less than 256 MB of free disk space");
        }
        let kind = spec.kind();
        let format = options.format;
        format.validate()?;
        anyhow::ensure!(kind != SourceKind::ChromiumTab || format == Default::default(), "Chrome capture uses 16 kHz, 16-bit PCM");
        let wait_for_audio = options.wait_for_audio || kind == SourceKind::Mic;
        let (title, bundle, url, video_key, capture_source_id, browser) = match &spec {
            SourceSpec::ChromiumTab { tab_id, url, title: t, browser } => {
                let vk = url.as_deref().and_then(video_key_of);
                let identity = tab_id.map(|id| mc_core::chromium_source_id(browser.as_deref(), id, options.browser_client_id.as_deref()));
                (title.or(t.clone()).unwrap_or_else(|| "Browser tab".into()), browser.clone(), url.clone(), vk, identity, browser.clone())
            }
            SourceSpec::MacApp { app_id } => {
                #[cfg(target_os = "macos")]
                let name = mc_capture_macos::list_apps()?.into_iter().find(|a| &a.app_id == app_id).map(|a| a.name);
                #[cfg(not(target_os = "macos"))]
                let name: Option<String> = None;
                let bundle = (!app_id.starts_with("pid:")).then(|| app_id.clone());
                (title.or(name).unwrap_or_else(|| app_id.clone()), bundle, None, None, Some(app_id.clone()), None)
            }
            #[cfg(target_os = "macos")]
            SourceSpec::Mic { device } => {
                let mic = mc_capture_macos::microphone(device.as_deref())?;
                (title.unwrap_or(mic.name), None, None, None, Some(mic.id), None)
            }
            #[cfg(not(target_os = "macos"))]
            SourceSpec::Mic { .. } => anyhow::bail!("microphone capture requires macOS"),
        };
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.len() >= MAX_ACTIVE_SESSIONS {
            anyhow::bail!("too many active sessions (limit {MAX_ACTIVE_SESSIONS})");
        }
        if let Some(source) = &capture_source_id {
            if sessions.values().any(|h| h.kind == kind && !h.capture_closed() && h.capture_source_id.as_ref() == Some(source)) {
                anyhow::bail!("{title} is already being recorded");
            }
        }
        let source_id = self.store.create_source(&NewSource {
            kind: kind.as_str(),
            title: &title,
            app_bundle_id: bundle.as_deref(),
            capture_source_id: capture_source_id.as_deref(),
            url: url.as_deref(),
            video_key: video_key.as_deref(),
        })?;
        let id = self.store.create_session_with_format(&source_id, mode.as_str(), None, None, format)?;
        let initial_status = if wait_for_audio { "waiting" } else { "capturing" };
        self.store.set_status(&id, initial_status, None)?;
        let handle = session::spawn(self.clone(), id.clone(), kind, title, mode, (capture_source_id.clone(), browser), (wait_for_audio, format))?;
        sessions.insert(id.clone(), handle.clone());
        drop(sessions);
        self.emit(EngineEvent::Status { session_id: id.clone(), status: initial_status.into(), detail: None });
        #[cfg(target_os = "macos")]
        if let Some(source) = capture_source_id {
            let attached = match kind {
                SourceKind::Mic => handle.attach_microphone(&source),
                SourceKind::MacApp => handle.attach_app_capture(source, options.mute_playback),
                SourceKind::ChromiumTab => Ok(()),
            };
            if let Err(e) = attached {
                self.sessions.lock().unwrap().remove(&id);
                let _ = handle.tx.try_send(SessionMsg::Stop { reason: format!("capture_failed: {e}") });
                anyhow::bail!("could not start capture: {e}");
            }
        }
        let row = self.store.session(&id)?.ok_or_else(|| anyhow::anyhow!("session vanished"))?;
        Ok((row, warnings))
    }

    pub(crate) fn forget(&self, id: &str) {
        self.sessions.lock().unwrap().remove(id);
    }

    fn handle(&self, id: &str) -> anyhow::Result<Arc<SessionHandle>> {
        self.sessions.lock().unwrap().get(id).cloned().ok_or_else(|| anyhow::anyhow!("session {id} is not active"))
    }

    pub fn is_active(&self, id: &str) -> bool {
        self.sessions.lock().unwrap().contains_key(id)
    }

    /// One 100 ms PCM16 frame from the extension. Returns the highest contiguous seq received.
    pub fn ingest_tab_frame(&self, id: &str, seq: u32, wall_ms: f64, pcm: &[i16]) -> anyhow::Result<u32> {
        self.handle(id)?.ingest(seq, wall_ms, pcm)
    }

    pub fn media_mark(&self, id: &str, wall_ms: f64, media_ms: Option<i64>, paused: bool, rate: f64, live: bool, video_key: Option<String>) -> anyhow::Result<()> {
        let h = self.handle(id)?;
        if h.waiting_for_audio() || h.paused() || h.capture_closed() {
            return Ok(());
        }
        let at_ms = h.session_ms_at_wall(wall_ms);
        self.store.add_media_mark(id, at_ms, media_ms, paused, live, rate, video_key.as_deref())?;
        if let Some(vk) = video_key {
            self.store.set_video(id, None, Some(&vk))?;
        }
        Ok(())
    }

    pub fn navigation(&self, id: &str, url: Option<String>, title: Option<String>) -> anyhow::Result<()> {
        if let Some(t) = title.filter(|t| !t.is_empty()) {
            self.store.set_title(id, &t)?;
        }
        if let Some(u) = url {
            let vk = video_key_of(&u);
            self.store.set_video(id, Some(&u), vk.as_deref())?;
        }
        Ok(())
    }

    pub fn add_marker(&self, id: &str, label: Option<&str>) -> anyhow::Result<String> {
        let at = self.handle(id).map(|h| h.session_ms()).unwrap_or_else(|_| self.store.session(id).ok().flatten().map(|s| s.audio_ms).unwrap_or(0));
        self.store.add_marker(id, at, label)
    }

    pub fn set_mode(&self, id: &str, mode: SummaryMode) -> anyhow::Result<()> {
        self.store.set_summary_mode(id, mode.as_str())?;
        if let Ok(h) = self.handle(id) {
            h.tx.try_send(SessionMsg::Mode(mode)).map_err(|e| anyhow::anyhow!("session busy: {e}"))?;
        }
        Ok(())
    }

    pub fn set_paused(&self, id: &str, paused: bool) -> anyhow::Result<()> {
        self.handle(id)?.set_paused(paused)
    }

    /// Stops capture; transcription and the report continue in the background.
    pub fn stop_session(&self, id: &str, reason: &str) -> anyhow::Result<()> {
        let h = self.handle(id)?;
        h.tx.try_send(SessionMsg::Stop { reason: reason.into() }).map_err(|e| anyhow::anyhow!("session busy: {e}"))?;
        Ok(())
    }

    pub fn sessions(&self, active_only: bool) -> anyhow::Result<Vec<SessionRow>> {
        self.store.sessions(active_only, 200)
    }

    pub fn transcript(&self, id: &str) -> anyhow::Result<Vec<TranscriptEvent>> {
        self.store.transcript(id)
    }

    pub fn insights(&self, id: &str) -> anyhow::Result<Vec<Insight>> {
        self.store.latest_insights(id, false)
    }

    pub async fn missed(&self, id: &str, minutes: i64) -> anyhow::Result<mc_insight::Missed> {
        let lang = self.config().output_lang;
        let llm = self.llm();
        let (m, usage) = mc_insight::missed(&self.store, llm.as_ref(), id, minutes, &lang).await?;
        if let Some(u) = usage {
            self.store.add_usage(Some(id), &format!("{}:{}", u.provider, u.model), "tokens", (u.input_tokens + u.output_tokens) as f64, u.usd)?;
        }
        Ok(m)
    }

    /// Pending transcription chunks of a session (live backlog).
    pub fn backlog(&self, id: &str) -> usize {
        self.asr.pending(id)
    }

    pub fn export(&self, id: &str, format: ExportFormat) -> anyhow::Result<(String, Vec<u8>)> {
        export::export(self, id, format)
    }

    pub fn delete_session(&self, id: &str) -> anyhow::Result<()> {
        if self.is_active(id) {
            anyhow::bail!("stop the session before deleting it");
        }
        self.store.delete_session(id)?;
        let dir = self.session_dir(id);
        if dir.starts_with(self.data_dir.join("audio")) {
            let _ = std::fs::remove_dir_all(dir);
        }
        Ok(())
    }

    /// Transcription health of one session (failed chunks still waiting for retry).
    pub fn asr_health(&self, id: &str) -> AsrHealth {
        let f = self.store.asr_failures(Some(id)).unwrap_or_default();
        AsrHealth::from_counts(f.len() as i64, f.iter().map(|x| x.end_ms - x.start_ms).sum())
    }

    /// Session rows with their transcription health (`asr` object), newest first.
    pub fn sessions_json(&self, active_only: bool) -> anyhow::Result<Vec<serde_json::Value>> {
        self.sessions_json_with_limit(active_only, 200)
    }

    pub fn sessions_json_with_limit(&self, active_only: bool, limit: i64) -> anyhow::Result<Vec<serde_json::Value>> {
        let summary = self.store.asr_failure_summary()?;
        Ok(self.store
            .sessions(active_only, limit)?
            .into_iter()
            .map(|row| {
                let (n, ms) = summary.get(&row.id).copied().unwrap_or((0, 0));
                let mut v = serde_json::to_value(&row).unwrap_or_default();
                v["asr"] = serde_json::to_value(AsrHealth::from_counts(n, ms)).unwrap_or_default();
                v
            })
            .collect())
    }

    /// Retries every failed chunk of a session now. A stopped session that has audio but no text
    /// and no recorded failures (e.g. transcription was off or down for the whole pass) gets its
    /// whole recording queued. Returns the number of ranges queued.
    pub fn retry_asr(self: &Arc<Self>, id: &str) -> anyhow::Result<usize> {
        let session = self.store.session(id)?.ok_or_else(|| anyhow::anyhow!("no session {id}"))?;
        let mut failures = self.store.asr_failures(Some(id))?;
        if failures.is_empty() && !self.is_active(id) && self.store.transcript(id)?.is_empty() {
            let segs = retry::segments_of(self, id);
            let end = segs.last().map(|s| s.end_ms).unwrap_or(0);
            if end > 0 {
                let audio = mc_recorder::read_range(&segs, 0, end)?;
                let pass = if session.summary_mode == "after" { "after" } else { "backfill" };
                for c in mc_vad::chunk_all(&audio, 0) {
                    self.store.add_asr_failure(id, c.start_ms, c.end_ms, pass, "queued by retry")?;
                }
                failures = self.store.asr_failures(Some(id))?;
            }
        }
        let n = failures.len();
        if n > 0 {
            retry::run_pass(self);
        }
        Ok(n)
    }

    /// Wakes the retry loop now (e.g. after keys were added).
    pub fn retry_all(&self) {
        self.retry_notify.notify_one();
    }

    /// Service API: transcribes one WAV chunk with the configured adapter (no session).
    /// Returns the engine id and segments; errors when transcription is unavailable.
    pub async fn transcribe_direct(&self, pcm16k: &[f32], lang: Option<&str>) -> anyhow::Result<(String, Vec<AsrSegment>)> {
        let adapter = self.asr.adapter();
        let id = adapter.id();
        let segments = adapter.transcribe(pcm16k, lang).await?;
        let minutes = pcm16k.len() as f64 / mc_core::SAMPLE_RATE as f64 / 60.0;
        let _ = self.store.add_usage(None, &id, "minutes", minutes, adapter.usd_per_minute() * minutes);
        Ok((id, segments))
    }

    /// Service API: one JSON chat call with the configured model providers.
    /// Returns (parsed output, provider, model, tokens).
    pub async fn chat_direct(&self, system: &str, user: &str, max_tokens: u32) -> anyhow::Result<(serde_json::Value, String, String, u64)> {
        let llm = self.llm().ok_or_else(|| anyhow::anyhow!("no model provider with an API key is configured"))?;
        let (out, u) = llm.chat_json(system, user, max_tokens.min(4000)).await?;
        let _ = self.store.add_usage(None, &format!("{}:{}", u.provider, u.model), "tokens", (u.input_tokens + u.output_tokens) as f64, u.usd);
        Ok((out, u.provider, u.model, u.input_tokens + u.output_tokens))
    }

    /// Reads the committed FLAC segments and the current buffer at a paused capture boundary.
    pub async fn paused_audio_wav(&self, id: &str) -> anyhow::Result<Vec<u8>> {
        let handle = self.handle(id)?;
        let (reply, audio) = tokio::sync::oneshot::channel();
        handle.tx.try_send(SessionMsg::Preview(reply)).map_err(|error| anyhow::anyhow!("Could not review this recording: {error}"))?;
        let snapshot = audio.await??;
        tokio::task::spawn_blocking(move || snapshot.wav()).await?
    }

    /// The archived audio of a session at its original rate and bit depth.
    pub fn audio_wav(&self, id: &str) -> anyhow::Result<Vec<u8>> {
        self.audio_wav_range(id, 0, None)
    }

    pub fn audio_wav_range(&self, id: &str, start_ms: i64, end_ms: Option<i64>) -> anyhow::Result<Vec<u8>> {
        anyhow::ensure!(start_ms >= 0 && end_ms.is_none_or(|end| end > start_ms), "Invalid audio selection");
        let row = self.store.session(id)?.ok_or_else(|| anyhow::anyhow!("no session {id}"))?;
        if row.status == "waiting" || row.failure.as_deref() == Some("no_audio") {
            anyhow::bail!("no audio detected");
        }
        let segs = retry::segments_of(self, id);
        let (format, audio) = mc_recorder::read_archive(&segs, start_ms, end_ms)?;
        anyhow::ensure!(!audio.is_empty(), "No archived audio in this selection");
        mc_audio::encode_wav_with_format(&audio, format)
    }

    pub async fn generate_summary(&self, id: &str) -> anyhow::Result<()> {
        let row = self.store.session(id)?.ok_or_else(|| anyhow::anyhow!("no session {id}"))?;
        if self.is_active(id) {
            anyhow::bail!("End the recording before generating a summary");
        }
        if self.store.transcript(id)?.is_empty() {
            anyhow::bail!("Generate a transcript before generating a summary");
        }
        let llm = self.llm().ok_or_else(|| anyhow::anyhow!("No summary provider API key is configured"))?;
        if let Some(usage) = mc_insight::report(&self.store, &llm, id, &self.config().output_lang, &row.title).await? {
            let _ = self.store.add_usage(Some(id), &format!("{}:{}", usage.provider, usage.model), "tokens", (usage.input_tokens + usage.output_tokens) as f64, usage.usd);
        }
        self.emit(EngineEvent::Report { session_id: id.to_string(), is_final: true });
        Ok(())
    }

    /// Waits until a stopped session has its report (or `timeout`). Test and CLI helper.
    pub async fn wait_finished(&self, id: &str, timeout: std::time::Duration) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        while tokio::time::Instant::now() < deadline {
            let done = self.store.session(id).ok().flatten().is_some_and(|s| s.status == "stopped" || s.status == "failed");
            if done && !self.is_active(id) {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        false
    }
}

/// `youtube:<id>`, `bilibili:<BV…>` for public video pages (sharing eligibility, design 6).
pub fn video_key_of(url: &str) -> Option<String> {
    let u = url.trim();
    if let Some(i) = u.find("youtube.com/watch") {
        let q = &u[i..];
        let v = q.split(['?', '&']).find_map(|p| p.strip_prefix("v="))?;
        return Some(format!("youtube:{}", v.split('#').next()?));
    }
    if let Some(i) = u.find("youtube.com/live/") {
        let id = u[i + 17..].split(['?', '/', '#']).next()?;
        return Some(format!("youtube:{id}"));
    }
    if let Some(i) = u.find("youtu.be/") {
        let id = u[i + 9..].split(['?', '/', '#']).next()?;
        return Some(format!("youtube:{id}"));
    }
    if let Some(i) = u.find("bilibili.com/video/") {
        let id = u[i + 19..].split(['?', '/', '#']).next()?;
        return Some(format!("bilibili:{id}"));
    }
    None
}

#[cfg(test)]
mod tests;
