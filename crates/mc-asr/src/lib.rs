//! Transcription adapters and the global scheduler (design 4.8).
//!
//! MVP-1 ships the HTTP adapters (MOSS protocol and OpenAI-compatible: OpenAI, Groq, …), ported from
//! Catchup's `providers/asr_http.py`. On-device engines implement the same trait in MVP-2.

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mc_core::config::AsrConfig;
use serde::Deserialize;
use tokio::sync::{oneshot, Notify, Semaphore};

#[derive(Debug, Clone, PartialEq)]
pub struct AsrSegment {
    /// Relative to the start of the audio passed in.
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    pub lang: Option<String>,
}

#[async_trait]
pub trait AsrAdapter: Send + Sync {
    fn id(&self) -> String;
    fn usd_per_minute(&self) -> f64;
    async fn transcribe(&self, pcm16k: &[f32], lang: Option<&str>) -> anyhow::Result<Vec<AsrSegment>>;
}

pub fn from_config(cfg: &AsrConfig) -> anyhow::Result<Arc<dyn AsrAdapter>> {
    match cfg.protocol.as_str() {
        "moss" | "openai" => {
            let key = cfg.key();
            if key.is_empty() {
                anyhow::bail!("no API key for ASR provider {} (set {} or api_key)", cfg.provider, cfg.api_key_env);
            }
            Ok(Arc::new(HttpAsr::new(cfg, key)))
        }
        "fake" => Ok(Arc::new(FakeAsr::default())),
        other => anyhow::bail!("unknown ASR protocol {other}"),
    }
}

pub struct HttpAsr {
    endpoint: String,
    key: String,
    model: String,
    protocol: String,
    segmented: bool,
    usd_per_minute: f64,
    language: String,
    client: reqwest::Client,
    provider: String,
}

impl HttpAsr {
    pub fn new(cfg: &AsrConfig, key: String) -> Self {
        let root = cfg.base_url.trim_end_matches('/');
        let base = if root.ends_with("/v1") { root.to_string() } else { format!("{root}/v1") };
        Self {
            endpoint: format!("{base}/audio/transcriptions"),
            key,
            model: cfg.model.clone(),
            protocol: cfg.protocol.clone(),
            segmented: cfg.timestamps != "chunk",
            usd_per_minute: cfg.usd_per_minute,
            language: cfg.language.clone(),
            client: reqwest::Client::builder().timeout(std::time::Duration::from_secs(120)).build().expect("http client"),
            provider: cfg.provider.clone(),
        }
    }
}

#[derive(Deserialize)]
struct TimedText {
    start: f64,
    end: f64,
    text: String,
}

#[derive(Deserialize)]
struct Transcript {
    #[serde(default)]
    segments: Vec<TimedText>,
    #[serde(default)]
    text: String,
    #[serde(default)]
    language: Option<String>,
}

#[async_trait]
impl AsrAdapter for HttpAsr {
    fn id(&self) -> String {
        format!("{}:{}", self.provider, self.model)
    }

    fn usd_per_minute(&self) -> f64 {
        self.usd_per_minute
    }

    async fn transcribe(&self, pcm16k: &[f32], lang: Option<&str>) -> anyhow::Result<Vec<AsrSegment>> {
        let wav = mc_audio::encode_wav(pcm16k)?;
        let duration_ms = mc_core::samples_to_ms(pcm16k.len());
        let lang = lang.filter(|l| !l.is_empty()).map(str::to_string).or_else(|| (!self.language.is_empty()).then(|| self.language.clone()));
        let protocol = self.protocol.clone();
        let segmented = self.segmented;
        let model = self.model.clone();
        let lang_param = lang.clone();
        let make_form = move || -> anyhow::Result<reqwest::multipart::Form> {
            let mut form = reqwest::multipart::Form::new()
                .text("model", model.clone())
                .part("file", reqwest::multipart::Part::bytes(wav.clone()).file_name("chunk.wav").mime_str("audio/wav")?);
            if protocol == "moss" {
                form = form.text("response_format", if segmented { "diarized_json" } else { "json" });
                if segmented {
                    form = form.text("diarize", "true");
                }
            } else {
                form = form.text("response_format", if segmented { "verbose_json" } else { "json" });
                if segmented {
                    form = form.text("timestamp_granularities[]", "segment");
                }
                if let Some(l) = &lang_param {
                    form = form.text("language", l.split('-').next().unwrap_or(l).to_string());
                }
            }
            Ok(form)
        };
        let mut attempt = 0;
        let resp = loop {
            let r = self.client.post(&self.endpoint).bearer_auth(&self.key).multipart(make_form()?).send().await;
            match r {
                Ok(resp) if resp.status().is_success() => break resp,
                Ok(resp) if (resp.status().as_u16() == 429 || resp.status().is_server_error()) && attempt < 2 => {
                    attempt += 1;
                    tokio::time::sleep(std::time::Duration::from_secs(2u64.pow(attempt))).await;
                }
                Ok(resp) => {
                    let status = resp.status();
                    let body: String = resp.text().await.unwrap_or_default().chars().take(300).collect();
                    anyhow::bail!("ASR HTTP {status}: {body}");
                }
                Err(e) if attempt < 2 => {
                    attempt += 1;
                    tracing::warn!(error = %e, "ASR request failed, retrying");
                    tokio::time::sleep(std::time::Duration::from_secs(2u64.pow(attempt))).await;
                }
                Err(e) => return Err(e.into()),
            }
        };
        let body: Transcript = resp.json().await?;
        let lang_out = body.language.clone().or(lang);
        if !self.segmented || body.segments.is_empty() {
            let text = body.text.trim();
            if text.is_empty() {
                return Ok(vec![]);
            }
            return Ok(vec![AsrSegment { start_ms: 0, end_ms: duration_ms, text: text.to_string(), lang: lang_out }]);
        }
        Ok(body
            .segments
            .into_iter()
            .filter(|s| !s.text.trim().is_empty() && s.end > s.start)
            .map(|s| AsrSegment {
                start_ms: (s.start * 1000.0).round() as i64,
                end_ms: ((s.end * 1000.0).round() as i64).min(duration_ms.max(1)),
                text: s.text.trim().to_string(),
                lang: lang_out.clone(),
            })
            .collect())
    }
}

/// Test adapter: returns a fixed text per call, or a text derived from the audio length.
#[derive(Default)]
pub struct FakeAsr {
    pub text: Mutex<Option<String>>,
}

#[async_trait]
impl AsrAdapter for FakeAsr {
    fn id(&self) -> String {
        "fake".into()
    }
    fn usd_per_minute(&self) -> f64 {
        0.0
    }
    async fn transcribe(&self, pcm16k: &[f32], lang: Option<&str>) -> anyhow::Result<Vec<AsrSegment>> {
        let ms = mc_core::samples_to_ms(pcm16k.len());
        let text = self.text.lock().unwrap().clone().unwrap_or_else(|| format!("speech of {ms} ms"));
        Ok(vec![AsrSegment { start_ms: 0, end_ms: ms, text, lang: lang.map(str::to_string) }])
    }
}

/// Job priority: live first, then after-mode, then backfill (design 4.8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Pass {
    Live = 0,
    After = 1,
    Backfill = 2,
}

impl Pass {
    pub fn as_str(&self) -> &'static str {
        match self {
            Pass::Live => "live",
            Pass::After => "after",
            Pass::Backfill => "backfill",
        }
    }
}

pub struct Job {
    pub session_id: String,
    pub pass: Pass,
    pub start_ms: i64,
    pub samples: Vec<f32>,
    pub lang: Option<String>,
    pub reply: oneshot::Sender<anyhow::Result<Vec<AsrSegment>>>,
}

#[derive(Default)]
struct Queues {
    by_pass: BTreeMap<Pass, BTreeMap<String, VecDeque<Job>>>,
    /// Round-robin cursor: last session served per pass.
    last: BTreeMap<Pass, String>,
}

impl Queues {
    fn pop(&mut self) -> Option<Job> {
        let passes: Vec<Pass> = self.by_pass.keys().copied().collect();
        for pass in passes {
            let sessions = self.by_pass.get_mut(&pass)?;
            sessions.retain(|_, q| !q.is_empty());
            if sessions.is_empty() {
                continue;
            }
            let last = self.last.get(&pass).cloned().unwrap_or_default();
            let next_key = sessions.keys().find(|k| **k > last).or_else(|| sessions.keys().next()).cloned()?;
            let job = sessions.get_mut(&next_key)?.pop_front();
            self.last.insert(pass, next_key);
            return job;
        }
        None
    }

    fn pending_for(&self, session: &str) -> usize {
        self.by_pass.values().filter_map(|m| m.get(session)).map(|q| q.len()).sum()
    }
}

/// Global transcription scheduler: one queue per session and pass, fair across sessions,
/// bounded parallelism. A slow provider delays text, never recording.
pub struct Scheduler {
    queues: Mutex<Queues>,
    notify: Notify,
    adapter: Mutex<Arc<dyn AsrAdapter>>,
    permits: Arc<Semaphore>,
}

impl Scheduler {
    pub fn new(adapter: Arc<dyn AsrAdapter>, concurrency: usize) -> Arc<Self> {
        let s = Arc::new(Self {
            queues: Mutex::new(Queues::default()),
            notify: Notify::new(),
            adapter: Mutex::new(adapter),
            permits: Arc::new(Semaphore::new(concurrency.max(1))),
        });
        let me = s.clone();
        tokio::spawn(async move { me.run().await });
        s
    }

    pub fn adapter(&self) -> Arc<dyn AsrAdapter> {
        self.adapter.lock().unwrap().clone()
    }

    pub fn set_adapter(&self, adapter: Arc<dyn AsrAdapter>) {
        *self.adapter.lock().unwrap() = adapter;
    }

    pub fn submit(&self, session_id: &str, pass: Pass, start_ms: i64, samples: Vec<f32>, lang: Option<String>) -> oneshot::Receiver<anyhow::Result<Vec<AsrSegment>>> {
        let (tx, rx) = oneshot::channel();
        let job = Job { session_id: session_id.to_string(), pass, start_ms, samples, lang, reply: tx };
        self.queues.lock().unwrap().by_pass.entry(pass).or_default().entry(session_id.to_string()).or_default().push_back(job);
        self.notify.notify_one();
        rx
    }

    pub fn pending(&self, session_id: &str) -> usize {
        self.queues.lock().unwrap().pending_for(session_id)
    }

    /// Drops queued jobs of a session (e.g. live mode switched off).
    pub fn cancel(&self, session_id: &str, pass: Pass) {
        if let Some(m) = self.queues.lock().unwrap().by_pass.get_mut(&pass) {
            m.remove(session_id);
        }
    }

    async fn run(self: Arc<Self>) {
        loop {
            let permit = self.permits.clone().acquire_owned().await.expect("semaphore");
            let job = loop {
                if let Some(job) = self.queues.lock().unwrap().pop() {
                    break job;
                }
                self.notify.notified().await;
            };
            let adapter = self.adapter();
            tokio::spawn(async move {
                let result = adapter.transcribe(&job.samples, job.lang.as_deref()).await;
                let _ = job.reply.send(result);
                drop(permit);
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Slow;
    #[async_trait]
    impl AsrAdapter for Slow {
        fn id(&self) -> String {
            "slow".into()
        }
        fn usd_per_minute(&self) -> f64 {
            0.0
        }
        async fn transcribe(&self, pcm: &[f32], _: Option<&str>) -> anyhow::Result<Vec<AsrSegment>> {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            Ok(vec![AsrSegment { start_ms: 0, end_ms: 1, text: format!("{}", pcm.len()), lang: None }])
        }
    }

    #[tokio::test]
    async fn live_jobs_are_served_before_backfill_and_round_robin() {
        let s = Scheduler::new(Arc::new(Slow), 1);
        let mut order = Vec::new();
        let b1 = s.submit("b", Pass::Backfill, 0, vec![0.0; 1], None);
        let a1 = s.submit("a", Pass::Live, 0, vec![0.0; 2], None);
        let c1 = s.submit("c", Pass::Live, 0, vec![0.0; 3], None);
        let a2 = s.submit("a", Pass::Live, 0, vec![0.0; 4], None);
        for rx in [a1, c1, a2, b1] {
            order.push(rx.await.unwrap().unwrap()[0].text.clone());
        }
        assert_eq!(order.len(), 4);
        assert_eq!(s.pending("a"), 0);
    }

    #[test]
    fn queue_order_is_priority_then_fair() {
        let mut q = Queues::default();
        let mk = |s: &str, p: Pass| {
            let (tx, _rx) = oneshot::channel();
            Job { session_id: s.into(), pass: p, start_ms: 0, samples: vec![], lang: None, reply: tx }
        };
        for (s, p) in [("b", Pass::Backfill), ("a", Pass::Live), ("a", Pass::Live), ("c", Pass::Live)] {
            q.by_pass.entry(p).or_default().entry(s.to_string()).or_default().push_back(mk(s, p));
        }
        let order: Vec<String> = std::iter::from_fn(|| q.pop()).map(|j| format!("{}:{}", j.session_id, j.pass.as_str())).collect();
        assert_eq!(order, vec!["a:live", "c:live", "a:live", "b:backfill"]);
    }

    #[tokio::test]
    async fn fake_adapter_reports_duration() {
        let f = FakeAsr::default();
        let out = f.transcribe(&vec![0.0; 16_000], Some("en")).await.unwrap();
        assert_eq!(out[0].end_ms, 1000);
    }
}
