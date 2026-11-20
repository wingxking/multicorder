//! Engine tests with local fakes (no network). Real providers are exercised by `scripts/e2e`.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mc_asr::{AsrAdapter, AsrSegment};
use mc_core::config::Config;
use mc_core::{SourceSpec, SummaryMode};
use mc_insight::{Llm, Usage};
use serde_json::{json, Value};

use crate::Engine;

/// "Transcribes" a chunk by reading the marker frequency: tests feed 440 Hz to one session and
/// 880 Hz to the other, so cross-talk between sessions would show up as the wrong word.
struct ToneAsr;

#[async_trait]
impl AsrAdapter for ToneAsr {
    fn id(&self) -> String {
        "tone".into()
    }
    fn usd_per_minute(&self) -> f64 {
        0.0
    }
    async fn transcribe(&self, pcm: &[f32], _: Option<&str>) -> anyhow::Result<Vec<AsrSegment>> {
        let crossings = pcm.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count() as f64;
        let hz = crossings / (pcm.len() as f64 / 16_000.0);
        let word = if hz < 660.0 { "falcon budget 42" } else { "zebra launch 7" };
        Ok(vec![AsrSegment { start_ms: 0, end_ms: mc_core::samples_to_ms(pcm.len()), text: word.into(), lang: Some("en".into()) }])
    }
}

/// Model fake: cites the first new segment, and writes a report citing it too.
struct EchoLlm;

#[async_trait]
impl Llm for EchoLlm {
    async fn chat_json(&self, system: &str, user: &str, _max: u32) -> anyhow::Result<(Value, Usage)> {
        let input: Value = serde_json::from_str(user)?;
        let usage = Usage { provider: "echo".into(), model: "echo".into(), input_tokens: 10, output_tokens: 10, usd: 0.0 };
        if system.contains("final report") {
            let seg = &input["segments"][0];
            return Ok((json!({"summary": "ok", "sections": [{"heading": "Key points", "bullets": [{"text": seg["text"], "evidence": [seg["id"]]}]}]}), usage));
        }
        let seg = &input["new_segments"][0];
        Ok((json!({"ops": [{"op": "upsert", "key": "", "type": "key_point", "text": seg["text"], "evidence": [seg["id"]]}]}), usage))
    }
}

fn tone(hz: f32, secs: f32) -> Vec<i16> {
    (0..(16_000.0 * secs) as usize).map(|i| ((i as f32 / 16_000.0 * hz * std::f32::consts::TAU).sin() * 12_000.0) as i16).collect()
}

fn silence(secs: f32) -> Vec<i16> {
    vec![0; (16_000.0 * secs) as usize]
}

async fn feed(engine: &Engine, id: &str, audio: &[i16]) {
    for (seq, frame) in audio.chunks(1600).enumerate() {
        engine.ingest_tab_frame(id, seq as u32, 0.0, frame).unwrap();
        if seq % 50 == 0 {
            tokio::task::yield_now().await;
        }
    }
}

fn engine() -> (Arc<Engine>, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("mc-engine-{}", mc_core::new_id()));
    let cfg = Config { output_lang: "en".into(), ..Config::default() };
    let e = Engine::start_with(&dir, cfg, Some(Arc::new(ToneAsr)), Some(Arc::new(EchoLlm))).unwrap();
    (e, dir)
}

#[tokio::test(flavor = "multi_thread")]
async fn armed_session_keeps_only_short_preroll_and_creates_no_silent_archive() {
    let (engine, dir) = engine();
    let arm = || {
        engine.start_session_opts(
            SourceSpec::ChromiumTab { tab_id: None, url: None, title: None, browser: None },
            SummaryMode::Off,
            None,
            crate::StartOptions { wait_for_audio: true, ..Default::default() },
        ).unwrap().0
    };
    let audible = arm();
    let silent = arm();
    assert_eq!(audible.status, "waiting");
    assert_eq!(engine.sessions(true).unwrap().len(), 2);
    feed(&engine, &audible.id, &silence(3.0)).await;
    feed(&engine, &silent.id, &silence(3.0)).await;
    assert_eq!(engine.store.session(&audible.id).unwrap().unwrap().status, "waiting");
    assert!(engine.audio_wav(&audible.id).is_err());
    assert!(engine.store.segments(&audible.id).unwrap().is_empty());

    let sound = tone(440.0, 1.0);
    for (i, frame) in sound.chunks(1600).enumerate() {
        engine.ingest_tab_frame(&audible.id, 50 + i as u32, 0.0, frame).unwrap();
    }
    engine.stop_session(&audible.id, "user").unwrap();
    engine.stop_session(&silent.id, "user").unwrap();
    assert!(engine.wait_finished(&audible.id, Duration::from_secs(5)).await);
    assert!(engine.wait_finished(&silent.id, Duration::from_secs(5)).await);

    let wav = engine.audio_wav(&audible.id).unwrap();
    let samples = mc_audio::decode_wav_to_16k(&wav).unwrap();
    assert_eq!(samples.len(), 19_200);
    assert!(mc_audio::is_all_zero(&samples[..3200]));
    assert!(mc_audio::rms_db(&samples[3200..]) > -20.0);
    assert!(engine.store.gaps(&audible.id).unwrap().is_empty());
    assert_eq!(engine.store.session(&silent.id).unwrap().unwrap().failure.as_deref(), Some("no_audio"));
    assert!(engine.store.segments(&silent.id).unwrap().is_empty());
    assert!(engine.audio_wav(&silent.id).is_err());
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn paused_audio_is_skipped_and_audio_only_can_be_transcribed_and_summarized() {
    let (engine, dir) = engine();
    let mut events = engine.subscribe();
    let session = engine.start_session(
        SourceSpec::ChromiumTab { tab_id: None, url: None, title: Some("Pause test".into()), browser: None },
        SummaryMode::Off,
        None,
    ).unwrap();
    let sound = tone(440.0, 1.0);
    feed(&engine, &session.id, &sound).await;
    engine.set_paused(&session.id, true).unwrap();
    for (i, frame) in tone(880.0, 1.0).chunks(1600).enumerate() {
        engine.ingest_tab_frame(&session.id, 10 + i as u32, 0.0, frame).unwrap();
    }
    let snapshot = engine.paused_audio_wav(&session.id).await.unwrap();
    let snapshot = mc_audio::decode_wav_to_16k(&snapshot).unwrap();
    assert_eq!(snapshot.len(), sound.len());
    assert!(snapshot.iter().zip(&sound).all(|(actual, expected)|
        (*actual - mc_audio::i16_to_f32(*expected)).abs() < 0.0001));
    assert!(engine.store.segments(&session.id).unwrap().is_empty());
    engine.set_paused(&session.id, false).unwrap();
    assert!(engine.paused_audio_wav(&session.id).await.is_err());
    for (i, frame) in sound.chunks(1600).enumerate() {
        engine.ingest_tab_frame(&session.id, 20 + i as u32, 0.0, frame).unwrap();
    }
    engine.stop_session(&session.id, "user").unwrap();
    assert!(engine.wait_finished(&session.id, Duration::from_secs(5)).await);
    assert_eq!(engine.store.session(&session.id).unwrap().unwrap().audio_ms, 2000);
    assert!(engine.store.report(&session.id).unwrap().is_none());
    let mut waveform = false;
    let mut paused = false;
    while let Ok(event) = events.try_recv() {
        match event {
            mc_core::EngineEvent::Waveform { peaks, .. } => waveform |= peaks.iter().any(|p| *p > 0.1),
            mc_core::EngineEvent::Status { status, .. } => paused |= status == "paused",
            _ => {}
        }
    }
    assert!(waveform && paused);
    assert!(engine.generate_summary(&session.id).await.is_err());
    assert!(engine.retry_asr(&session.id).unwrap() > 0);
    tokio::time::timeout(Duration::from_secs(5), async {
        while engine.transcript(&session.id).unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }).await.unwrap();
    engine.generate_summary(&session.id).await.unwrap();
    let report = engine.store.report(&session.id).unwrap().unwrap();
    assert!(report.body.contains("falcon"));
    assert!(!report.body.contains("zebra"));
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn two_tab_sessions_stay_isolated_live_and_after() {
    let (engine, dir) = engine();
    let tab = |t: &str| SourceSpec::ChromiumTab { tab_id: None, url: Some("https://www.youtube.com/watch?v=abc123".into()), title: Some(t.into()), browser: None };
    let a = engine.start_session(tab("A"), SummaryMode::Live, None).unwrap();
    let b = engine.start_session(tab("B"), SummaryMode::After, None).unwrap();
    assert_eq!(a.video_key.as_deref(), Some("youtube:abc123"));
    let mut audio_a = silence(1.0);
    let mut audio_b = silence(1.0);
    for _ in 0..3 {
        audio_a.extend(tone(440.0, 2.0));
        audio_a.extend(silence(1.0));
        audio_b.extend(tone(880.0, 2.0));
        audio_b.extend(silence(1.0));
    }
    feed(&engine, &a.id, &audio_a).await;
    feed(&engine, &b.id, &audio_b).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    engine.stop_session(&a.id, "user").unwrap();
    engine.stop_session(&b.id, "user").unwrap();
    assert!(engine.wait_finished(&a.id, Duration::from_secs(30)).await);
    assert!(engine.wait_finished(&b.id, Duration::from_secs(30)).await);

    let ta = engine.transcript(&a.id).unwrap();
    let tb = engine.transcript(&b.id).unwrap();
    assert_eq!(ta.len(), 3, "{ta:?}");
    assert_eq!(tb.len(), 3, "{tb:?}");
    assert!(ta.iter().all(|e| e.text.contains("falcon")), "cross-talk in A: {ta:?}");
    assert!(tb.iter().all(|e| e.text.contains("zebra")), "cross-talk in B: {tb:?}");
    // Insights and reports cite only their own session.
    for (id, t) in [(&a.id, &ta), (&b.id, &tb)] {
        let ids: Vec<&str> = t.iter().map(|e| e.id.as_str()).collect();
        let ins = engine.insights(id).unwrap();
        assert!(!ins.is_empty());
        assert!(ins.iter().all(|i| i.evidence.iter().all(|e| ids.contains(&e.event_id.as_str()))));
        let report = engine.store.report(id).unwrap().expect("report");
        assert!(report.is_final);
    }
    assert_eq!(engine.store.segments(&a.id).unwrap().len(), 1);
    let session = engine.store.session(&a.id).unwrap().unwrap();
    assert_eq!(session.status, "stopped");
    assert!((session.audio_ms - 10_000).abs() < 200);
    // Exports.
    let (_, srt) = engine.export(&a.id, crate::ExportFormat::Srt).unwrap();
    assert!(String::from_utf8(srt).unwrap().contains("falcon"));
    // Search returns per-session hits.
    let hits = engine.store.search("zebra", None, 10).unwrap();
    assert!(hits.iter().all(|h| h.session_id == b.id));
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn switching_to_live_backfills_and_gaps_are_recorded() {
    let (engine, dir) = engine();
    let s = engine.start_session(SourceSpec::ChromiumTab { tab_id: None, url: None, title: Some("C".into()), browser: None }, SummaryMode::Off, None).unwrap();
    let mut audio = silence(0.5);
    audio.extend(tone(440.0, 2.0));
    audio.extend(silence(1.0));
    feed(&engine, &s.id, &audio).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    engine.set_mode(&s.id, SummaryMode::Live).unwrap();
    // A seq jump of 20 frames = 2 s gap filled with silence.
    let next = (audio.len() / 1600) as u32 + 20;
    for (i, frame) in tone(440.0, 2.0).chunks(1600).enumerate() {
        engine.ingest_tab_frame(&s.id, next + i as u32, 0.0, frame).unwrap();
    }
    engine.ingest_tab_frame(&s.id, next + 30, 0.0, &silence(1.0)[..1600]).ok();
    tokio::time::sleep(Duration::from_millis(500)).await;
    engine.stop_session(&s.id, "user").unwrap();
    assert!(engine.wait_finished(&s.id, Duration::from_secs(30)).await);
    let t = engine.transcript(&s.id).unwrap();
    assert!(t.len() >= 2, "backfill + live: {t:?}");
    assert!(engine.store.gaps(&s.id).unwrap().iter().any(|g| g.cause == "ws_gap"));
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn video_keys() {
    assert_eq!(crate::video_key_of("https://www.youtube.com/watch?v=xyz&t=3"), Some("youtube:xyz".into()));
    assert_eq!(crate::video_key_of("https://youtu.be/xyz?t=1"), Some("youtube:xyz".into()));
    assert_eq!(crate::video_key_of("https://www.bilibili.com/video/BV1x/"), Some("bilibili:BV1x".into()));
    assert_eq!(crate::video_key_of("https://example.com"), None);
}

#[tokio::test(flavor = "multi_thread")]
async fn recording_a_browser_whose_tabs_are_recorded_is_refused() {
    let (engine, dir) = engine();
    let tab = engine
        .start_session(
            SourceSpec::ChromiumTab { tab_id: Some(7), url: None, title: Some("T".into()), browser: Some("com.google.Chrome".into()) },
            SummaryMode::Off,
            None,
        )
        .unwrap();
    assert_eq!(tab.app_bundle_id.as_deref(), Some("com.google.Chrome"));
    assert_eq!(engine.tab_sessions_in_browser("com.google.Chrome"), vec![tab.id.clone()]);
    let err = engine.start_session(SourceSpec::MacApp { app_id: "com.google.Chrome".into() }, SummaryMode::Off, None).unwrap_err().to_string();
    assert!(err.starts_with("duplicate_browser_tabs:"), "{err}");
    assert!(err.contains(&tab.id));
    // Other browsers are unaffected by the guard (they fail later only because the app is not running).
    assert!(engine.tab_sessions_in_browser("com.apple.Safari").is_empty());
    engine.stop_session(&tab.id, "user").unwrap();
    assert!(engine.wait_finished(&tab.id, Duration::from_secs(10)).await);
    assert!(engine.tab_sessions_in_browser("com.google.Chrome").is_empty());
    std::fs::remove_dir_all(dir).ok();
}

/// Fails the first `fail` calls (provider down), then answers like ToneAsr.
struct FlakyAsr {
    fail: std::sync::atomic::AtomicUsize,
}

#[async_trait]
impl AsrAdapter for FlakyAsr {
    fn id(&self) -> String {
        "flaky".into()
    }
    fn usd_per_minute(&self) -> f64 {
        0.0
    }
    async fn transcribe(&self, pcm: &[f32], lang: Option<&str>) -> anyhow::Result<Vec<AsrSegment>> {
        use std::sync::atomic::Ordering;
        if self.fail.load(Ordering::SeqCst) > 0 {
            self.fail.fetch_sub(1, Ordering::SeqCst);
            anyhow::bail!("provider down (test)");
        }
        ToneAsr.transcribe(pcm, lang).await
    }
}

async fn wait_for(mut f: impl FnMut() -> bool, secs: u64) -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    while tokio::time::Instant::now() < deadline {
        if f() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

#[tokio::test(flavor = "multi_thread")]
async fn failed_transcription_is_kept_retried_and_reported() {
    let dir = std::env::temp_dir().join(format!("mc-engine-{}", mc_core::new_id()));
    let cfg = Config { output_lang: "en".into(), ..Config::default() };
    let flaky = Arc::new(FlakyAsr { fail: std::sync::atomic::AtomicUsize::new(1000) });
    let engine = Engine::start_with(&dir, cfg, Some(flaky.clone()), Some(Arc::new(EchoLlm))).unwrap();
    let mut events = engine.subscribe();
    let s = engine
        .start_session(SourceSpec::ChromiumTab { tab_id: None, url: None, title: Some("F".into()), browser: None }, SummaryMode::Live, None)
        .unwrap();
    let mut audio = silence(0.5);
    for _ in 0..3 {
        audio.extend(tone(440.0, 2.0));
        audio.extend(silence(1.0));
    }
    feed(&engine, &s.id, &audio).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    engine.stop_session(&s.id, "user").unwrap();
    assert!(engine.wait_finished(&s.id, Duration::from_secs(30)).await);
    // Recording is intact, text is missing, failures are recorded and visible.
    assert!(engine.transcript(&s.id).unwrap().is_empty());
    let health = engine.asr_health(&s.id);
    assert_eq!(health.state, "degraded");
    assert_eq!(health.failed_chunks, 3);
    assert!(!engine.audio_wav(&s.id).unwrap().is_empty());
    let listed = engine.sessions_json(false).unwrap();
    assert_eq!(listed[0]["asr"]["state"], "degraded");
    // Provider comes back: a manual retry fills the transcript in and regenerates the report.
    flaky.fail.store(0, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(engine.retry_asr(&s.id).unwrap(), 3);
    assert!(wait_for(|| engine.asr_health(&s.id).failed_chunks == 0 && engine.store.report(&s.id).ok().flatten().is_some_and(|r| r.body.contains("falcon")), 20).await);
    assert_eq!(engine.transcript(&s.id).unwrap().len(), 3);
    let mut recovered = false;
    while let Ok(e) = events.try_recv() {
        if let mc_core::EngineEvent::Status { detail: Some(d), .. } = &e {
            recovered |= d == "asr_recovered";
        }
    }
    assert!(recovered, "asr_recovered was not emitted");
    assert!(!engine.insights(&s.id).unwrap().is_empty());
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn retry_transcribes_a_recording_that_never_had_text() {
    let (engine, dir) = engine();
    let s = engine
        .start_session(SourceSpec::ChromiumTab { tab_id: None, url: None, title: Some("Off".into()), browser: None }, SummaryMode::Off, None)
        .unwrap();
    let mut audio = silence(0.5);
    audio.extend(tone(880.0, 2.0));
    audio.extend(silence(1.0));
    feed(&engine, &s.id, &audio).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    engine.stop_session(&s.id, "user").unwrap();
    assert!(engine.wait_finished(&s.id, Duration::from_secs(30)).await);
    assert!(engine.transcript(&s.id).unwrap().is_empty());
    assert_eq!(engine.retry_asr(&s.id).unwrap(), 1);
    assert!(wait_for(|| engine.transcript(&s.id).map(|t| t.len() == 1).unwrap_or(false), 20).await);
    assert!(engine.transcript(&s.id).unwrap()[0].text.contains("zebra"));
    assert_eq!(engine.asr_health(&s.id).state, "ok");
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn asr_is_on_by_default() {
    assert_eq!(SummaryMode::default(), SummaryMode::Live);
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelled_recording_is_discarded() {
    let (engine, dir) = engine();
    let session = engine.start_session(
        SourceSpec::ChromiumTab { tab_id: None, url: None, title: Some("Cancel test".into()), browser: None },
        SummaryMode::Live,
        None,
    ).unwrap();
    feed(&engine, &session.id, &tone(440.0, 2.0)).await;
    let audio_dir = engine.session_dir(&session.id);
    engine.cancel_session(&session.id).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while engine.is_active(&session.id) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }).await.unwrap();
    assert!(engine.store.session(&session.id).unwrap().is_none());
    assert!(engine.store.report(&session.id).unwrap().is_none());
    assert!(!audio_dir.exists());
    // Late transcription results for the deleted recording are dropped.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(engine.transcript(&session.id).unwrap().is_empty());
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn caption_coverage_merges_and_measures() {
    let mut c = crate::session::Coverage::default();
    c.add(0, 2000);
    c.add(1500, 3000);
    c.add(5000, 6000);
    c.add(2900, 4000);
    assert!((c.share(0, 4000) - 1.0).abs() < 1e-9);
    assert!((c.share(3000, 7000) - 0.5).abs() < 1e-9);
    assert_eq!(c.share(7000, 8000), 0.0);
}

#[tokio::test(flavor = "multi_thread")]
async fn platform_subtitles_replace_asr_where_they_play() {
    let (engine, dir) = engine();
    let mut events = engine.subscribe();
    let session = engine.start_session(
        SourceSpec::ChromiumTab { tab_id: None, url: Some("https://www.youtube.com/watch?v=x".into()), title: Some("Captions".into()), browser: None },
        SummaryMode::Live,
        None,
    ).unwrap();
    let source = mc_core::CaptionSource { platform: "youtube".into(), kind: "creator".into(), lang: Some("en".into()), languages: vec!["en".into(), "zh-CN".into()] };
    // Six seconds with subtitles playing (440 Hz would be "falcon" if it reached ASR)...
    let sound = tone(440.0, 6.0);
    let mut seq = 0u32;
    for second in sound.chunks(16_000) {
        engine.caption_state(&session.id, true, Some(source.clone()), Some("auto")).unwrap();
        for frame in second.chunks(1600) {
            engine.ingest_tab_frame(&session.id, seq, 0.0, frame).unwrap();
            seq += 1;
        }
        tokio::task::yield_now().await;
    }
    engine.caption_state(&session.id, true, Some(source.clone()), Some("auto")).unwrap();
    engine.caption(&session.id, 0.0, 1800.0, "hello from the subtitles", source.clone()).unwrap();
    // ...then a stretch without subtitles (880 Hz → "zebra"), which goes to speech recognition.
    engine.caption_state(&session.id, false, Some(source.clone()), Some("auto")).unwrap();
    for frame in silence(1.5).iter().copied().chain(tone(880.0, 4.0)).chain(silence(1.5)).collect::<Vec<_>>().chunks(1600) {
        engine.ingest_tab_frame(&session.id, seq, 0.0, frame).unwrap();
        seq += 1;
    }
    engine.stop_session(&session.id, "user").unwrap();
    assert!(engine.wait_finished(&session.id, Duration::from_secs(10)).await);
    let text = engine.transcript(&session.id).unwrap();
    let caption = text.iter().find(|e| e.text == "hello from the subtitles").expect("caption stored");
    assert_eq!(caption.engine, "caption:youtube:creator:en");
    assert!(text.iter().any(|e| e.text.contains("zebra")), "uncovered audio is transcribed: {text:?}");
    assert!(!text.iter().any(|e| e.text.contains("falcon")), "covered audio skips ASR: {text:?}");
    let mut announced = false;
    while let Ok(event) = events.try_recv() {
        if let mc_core::EngineEvent::TextSource { source: Some(s), active: true, .. } = event {
            announced |= s.platform == "youtube";
        }
    }
    assert!(announced);
    // "Transcribe with ASR" replaces the subtitle text with speech recognition of all the audio.
    assert!(engine.transcribe_with_asr(&session.id).unwrap() > 0);
    tokio::time::timeout(Duration::from_secs(10), async {
        while !engine.transcript(&session.id).unwrap().iter().any(|e| e.text.contains("falcon")) {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }).await.unwrap();
    assert!(engine.transcript(&session.id).unwrap().iter().all(|e| !e.engine.starts_with("caption:")));
    std::fs::remove_dir_all(dir).ok();
}
