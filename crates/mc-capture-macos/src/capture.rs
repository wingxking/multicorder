//! App list and the per-app capture manager: polls the process set every 2 s (macOS 26 sends no
//! IsRunningOutput change events — Fader), rebuilds the tap make-before-break when the set changes
//! or the tap stops calling back, and reports suspected missing permission (all-zero audio while the
//! app is playing). Output is 16 kHz mono.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use cidre::{core_audio as ca, ns, objc};
use mc_audio::StreamResampler;

use crate::grouping::{identify, is_ignored, outermost_app, process_name};
use crate::tap::ProcessTap;
use crate::AppAudioInfo;

pub fn list_apps() -> Result<Vec<AppAudioInfo>> {
    let me = std::process::id() as i32;
    let procs = ca::System::processes().map_err(|e| anyhow::anyhow!("process list: {e:?}"))?;
    let mut groups: BTreeMap<String, AppAudioInfo> = BTreeMap::new();
    objc::ar_pool(|| {
        for app in ns::Workspace::shared().running_apps().iter() {
            let pid = app.pid();
            if pid == me || pid <= 0 || app.is_terminated() {
                continue;
            }
            let Some(path) = app.bundle_url().and_then(|url| url.path()).map(|p| p.to_string()) else { continue };
            let bundle = std::path::Path::new(&path);
            if bundle.starts_with("/System/Library") || outermost_app(bundle).as_deref() != Some(bundle) {
                continue;
            }
            let bundle_id = app.bundle_id().map(|id| id.to_string());
            let app_id = bundle_id.clone().unwrap_or_else(|| path.clone());
            let name = app.localized_name().map(|name| name.to_string()).unwrap_or_else(|| app_id.clone());
            groups.entry(app_id.clone()).or_insert_with(|| AppAudioInfo {
                app_id, bundle_id, name, bundle_path: Some(path), pids: vec![pid], process_objs: vec![],
                is_emitting: false, is_recording: false,
            });
        }
    });
    for p in procs {
        let Ok(pid) = p.pid() else { continue };
        if pid == me || pid <= 0 {
            continue;
        }
        let emitting = p.is_running_output().unwrap_or(false);
        let recording = p.is_running_input().unwrap_or(false);
        let raw_name = process_name(pid).unwrap_or_default();
        if is_ignored(&raw_name) {
            continue;
        }
        let ident = identify(pid);
        if ident.owner_pid == me {
            continue;
        }
        // Processes outside app bundles (daemons, CLI tools) only while they play or record.
        if ident.bundle_path.is_none() && !emitting && !recording {
            continue;
        }
        let entry = groups.entry(ident.app_id.clone()).or_insert_with(|| AppAudioInfo {
            app_id: ident.app_id.clone(),
            bundle_id: ident.bundle_id.clone(),
            name: ident.name.clone(),
            bundle_path: ident.bundle_path.clone(),
            pids: vec![],
            process_objs: vec![],
            is_emitting: false,
            is_recording: false,
        });
        entry.pids.push(pid);
        entry.process_objs.push(p.0 .0);
        entry.is_emitting |= emitting;
        entry.is_recording |= recording;
    }
    let mut apps: Vec<_> = groups.into_values().collect();
    for a in &mut apps {
        a.pids.sort_unstable();
        a.pids.dedup();
        a.process_objs.sort_unstable();
    }
    apps.sort_by(|a, b| b.is_emitting.cmp(&a.is_emitting).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(apps)
}

#[derive(Debug, Clone)]
pub enum CaptureEvent {
    Started { process_objs: Vec<u32> },
    /// Tap rebuilt (process set changed or tap went quiet); `gap_ms` of audio may be missing.
    Retapped { reason: String, gap_ms: i64 },
    /// The app plays audio but the tap delivers only zeros: recording permission is probably missing.
    PermissionSuspected,
    AppGone,
    Error(String),
}

pub type AudioSink = Arc<dyn Fn(&[f32]) + Send + Sync>;
pub type EventSink = Arc<dyn Fn(CaptureEvent) + Send + Sync>;

struct TapSlot {
    tap: ProcessTap,
    gen: u64,
    objs: Vec<u32>,
}

struct Shared {
    active_gen: AtomicU64,
    last_audio: Mutex<Instant>,
    nonzero_seen: AtomicBool,
}

pub struct AppCapture {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl AppCapture {
    pub fn start(app_id: String, mute_playback: bool, sample_rate: u32, sink: AudioSink, events: EventSink) -> Result<Self> {
        find_app(&app_id)?.ok_or_else(|| anyhow::anyhow!("app {app_id} is not running"))?;
        let stop = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Shared {
            active_gen: AtomicU64::new(0),
            last_audio: Mutex::new(Instant::now()),
            nonzero_seen: AtomicBool::new(false),
        });
        let stop2 = stop.clone();
        // Core Audio can block while macOS waits for the user to answer a permission prompt.
        // Start the supervisor before tapping so the armed recording can still be controlled.
        let thread = std::thread::Builder::new()
            .name(format!("mc-app-{app_id}"))
            .spawn(move || supervise(app_id, mute_playback, sample_rate, shared, sink, events, stop2))?;
        Ok(Self { stop, thread: Some(thread) })
    }
}

impl Drop for AppCapture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            t.thread().unpark();
            if t.is_finished() {
                let _ = t.join();
            }
        }
    }
}

fn find_app(app_id: &str) -> Result<Option<AppAudioInfo>> {
    Ok(list_apps()?.into_iter().find(|a| a.app_id == app_id))
}

fn make_tap(app_id: &str, objs: &[u32], gen: u64, mute_playback: bool, sample_rate: u32, shared: Arc<Shared>, sink: AudioSink) -> Result<TapSlot> {
    let resampler: Mutex<Option<StreamResampler>> = Mutex::new(None);
    let raw: crate::tap::RawSink = Arc::new(move |samples: &[f32], rate: u32| {
        // The first audio of a newer generation switches the output to it (make-before-break).
        let active = shared.active_gen.load(Ordering::Acquire);
        if gen > active {
            shared.active_gen.store(gen, Ordering::Release);
        } else if gen < active {
            return;
        }
        *shared.last_audio.lock().unwrap() = Instant::now();
        if !mc_audio::is_all_zero(samples) {
            shared.nonzero_seen.store(true, Ordering::Relaxed);
        }
        let mut guard = resampler.lock().unwrap();
        if guard.as_ref().map(|r| r.input_rate()) != Some(rate) {
            *guard = StreamResampler::between(rate, sample_rate).ok();
        }
        if let Some(r) = guard.as_mut() {
            let out = r.push(samples);
            if !out.is_empty() {
                sink(&out);
            }
        }
    });
    let safe_name: String = app_id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' { c } else { '-' }).collect();
    let tap = ProcessTap::start(objs, &safe_name, mute_playback, raw)?;
    Ok(TapSlot { tap, gen, objs: objs.to_vec() })
}

fn supervise(app_id: String, mute_playback: bool, sample_rate: u32, shared: Arc<Shared>, sink: AudioSink, events: EventSink, stop: Arc<AtomicBool>) {
    let mut current: Option<TapSlot> = None;
    let mut retiring: Vec<(TapSlot, Instant)> = Vec::new();
    let mut gen = 0;
    let mut permission_reported = false;
    let mut missing_since: Option<Instant> = None;
    let started = Instant::now();
    let mut last_poll = Instant::now() - Duration::from_secs(10);
    while !stop.load(Ordering::Relaxed) {
        // Old taps are dropped once the new one is active, or after 2 s regardless.
        let active = shared.active_gen.load(Ordering::Acquire);
        retiring.retain(|(slot, since)| !(slot.gen < active || since.elapsed() > Duration::from_secs(2)));
        let poll_interval = if current.is_some() { Duration::from_secs(2) } else { Duration::from_millis(200) };
        if last_poll.elapsed() < poll_interval {
            std::thread::park_timeout(Duration::from_millis(200));
            continue;
        }
        last_poll = Instant::now();
        let app = match find_app(&app_id) {
            Ok(a) => a,
            Err(e) => {
                events(CaptureEvent::Error(e.to_string()));
                continue;
            }
        };
        let Some(app) = app else {
            let since = *missing_since.get_or_insert_with(Instant::now);
            if since.elapsed() > Duration::from_secs(30) {
                events(CaptureEvent::AppGone);
                missing_since = None;
            }
            continue;
        };
        missing_since = None;
        if app.process_objs.is_empty() {
            current = None;
            continue;
        }
        let Some(slot) = current.as_ref() else {
            gen += 1;
            match make_tap(&app_id, &app.process_objs, gen, mute_playback, sample_rate, shared.clone(), sink.clone()) {
                Ok(slot) => {
                    current = Some(slot);
                    events(CaptureEvent::Started { process_objs: app.process_objs });
                }
                Err(e) => events(CaptureEvent::Error(format!("could not attach to app audio: {e}"))),
            }
            continue;
        };
        let quiet_for = shared.last_audio.lock().unwrap().elapsed();
        let set_changed = app.process_objs != slot.objs;
        let dead = app.is_emitting && slot.tap.callbacks() == 0 && slot.tap.age() > Duration::from_secs(2);
        let stalled = app.is_emitting && quiet_for > Duration::from_secs(3) && slot.tap.age() > Duration::from_secs(3);
        if !permission_reported
            && app.is_emitting
            && started.elapsed() > Duration::from_secs(3)
            && !shared.nonzero_seen.load(Ordering::Relaxed)
        {
            permission_reported = true;
            events(CaptureEvent::PermissionSuspected);
        }
        if set_changed || dead || stalled {
            let reason = if set_changed { "process_set_changed" } else { "tap_stalled" };
            gen += 1;
            match make_tap(&app_id, &app.process_objs, gen, mute_playback, sample_rate, shared.clone(), sink.clone()) {
                Ok(slot) => {
                    if let Some(old) = current.replace(slot) {
                        retiring.push((old, Instant::now()));
                    }
                    events(CaptureEvent::Retapped { reason: reason.into(), gap_ms: 0 });
                }
                Err(e) => events(CaptureEvent::Error(format!("retap failed: {e}"))),
            }
        }
    }
    drop(retiring);
    drop(current);
}
