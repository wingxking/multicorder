//! The engine: one supervised pipeline per audio source (design 4.2). Shared by the desktop app,
//! the headless daemon and the local API.
#![allow(clippy::too_many_arguments)]

mod export;
mod session;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use mc_asr::{AsrAdapter, AsrSegment, Scheduler};
use mc_core::config::Config;
use mc_core::{EngineEvent, Insight, SourceSpec, SummaryMode, TranscriptEvent};
use mc_insight::Llm;
use mc_store::{NewSource, SessionRow, Store};
use serde::Serialize;
use tokio::sync::broadcast;

pub use export::ExportFormat;
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
        let asr = asr.unwrap_or_else(|| match mc_asr::from_config(&config.asr) {
            Ok(a) => a,
            Err(e) => Arc::new(Unconfigured(e.to_string())),
        });
        let llm = llm.or_else(|| mc_insight::HttpLlm::from_config(&config.llm).ok().map(|l| Arc::new(l) as Arc<dyn Llm>));
        let (events, _) = broadcast::channel(4096);
        let engine = Arc::new(Self {
            store,
            data_dir: data_dir.to_path_buf(),
            asr: Scheduler::new(asr, config.asr.concurrency),
            config: RwLock::new(config),
            llm: RwLock::new(llm),
            events,
            sessions: Mutex::new(HashMap::new()),
        });
        tracing::info!(recovered = recovered.len(), dir = %data_dir.display(), "engine started");
        Ok(engine)
    }

    pub fn config(&self) -> Config {
        self.config.read().unwrap().clone()
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
            let active: Vec<String> = self.sessions.lock().unwrap().values().filter_map(|h| h.app_id.clone()).collect();
            Ok(mc_capture_macos::list_apps()?
                .into_iter()
                .map(|a| {
                    let mut v = serde_json::to_value(&a).unwrap_or_default();
                    v["capturing"] = serde_json::Value::Bool(active.contains(&a.app_id));
                    v
                })
                .collect())
        }
        #[cfg(not(target_os = "macos"))]
        Ok(vec![])
    }

    /// Starts capturing a source. Tab sessions then receive frames through `ingest_tab_frame`.
    pub fn start_session(self: &Arc<Self>, spec: SourceSpec, mode: SummaryMode, title: Option<String>) -> anyhow::Result<SessionRow> {
        if self.sessions.lock().unwrap().len() >= MAX_ACTIVE_SESSIONS {
            anyhow::bail!("too many active sessions (limit {MAX_ACTIVE_SESSIONS})");
        }
        if !mc_recorder::has_disk_reserve(&self.data_dir) {
            anyhow::bail!("less than 256 MB of free disk space");
        }
        let (title, bundle, url, video_key, app_id) = match &spec {
            SourceSpec::ChromiumTab { url, title: t, .. } => {
                let vk = url.as_deref().and_then(video_key_of);
                (title.or(t.clone()).unwrap_or_else(|| "Browser tab".into()), None, url.clone(), vk, None)
            }
            SourceSpec::MacApp { app_id } => {
                #[cfg(target_os = "macos")]
                let name = mc_capture_macos::list_apps()?.into_iter().find(|a| &a.app_id == app_id).map(|a| a.name);
                #[cfg(not(target_os = "macos"))]
                let name: Option<String> = None;
                let bundle = (!app_id.starts_with("pid:")).then(|| app_id.clone());
                (title.or(name).unwrap_or_else(|| app_id.clone()), bundle, None, None, Some(app_id.clone()))
            }
            SourceSpec::Mic { .. } => anyhow::bail!("microphone capture arrives in MVP-2"),
        };
        if let Some(a) = &app_id {
            if self.sessions.lock().unwrap().values().any(|h| h.app_id.as_deref() == Some(a.as_str())) {
                anyhow::bail!("{a} is already being recorded");
            }
        }
        let source_id = self.store.create_source(&NewSource {
            kind: spec.kind().as_str(),
            title: &title,
            app_bundle_id: bundle.as_deref(),
            url: url.as_deref(),
            video_key: video_key.as_deref(),
        })?;
        let id = self.store.create_session(&source_id, mode.as_str(), None, None)?;
        let handle = session::spawn(self.clone(), id.clone(), spec.kind(), title.clone(), mode, app_id.clone())?;
        self.sessions.lock().unwrap().insert(id.clone(), handle.clone());
        #[cfg(target_os = "macos")]
        if let Some(app) = app_id {
            if let Err(e) = handle.attach_app_capture(app) {
                self.sessions.lock().unwrap().remove(&id);
                let _ = handle.tx.try_send(SessionMsg::Stop { reason: format!("capture_failed: {e}") });
                anyhow::bail!("could not start capture: {e}");
            }
        }
        self.store.set_status(&id, "capturing", None)?;
        self.emit(EngineEvent::Status { session_id: id.clone(), status: "capturing".into(), detail: None });
        self.store.session(&id)?.ok_or_else(|| anyhow::anyhow!("session vanished"))
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
