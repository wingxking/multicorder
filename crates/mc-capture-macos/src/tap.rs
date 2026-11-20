//! One process tap + private aggregate device + IO proc. The IO proc only copies samples into a
//! lock-free ring; a pump thread drains it. Structure follows Anarlog's `speaker/macos.rs` (MIT) and
//! AudioCap's `ProcessTap.swift` (BSD-2); `Unmuted` because we record, not re-render (unlike Fader).

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use cidre::core_audio as ca;
use cidre::{arc, cat, cf, ns, os};
use ca::aggregate_device_keys as agg_keys;
use ringbuf::traits::{Consumer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};

struct Ctx {
    producer: HeapProd<f32>,
    channels: usize,
    is_float: bool,
    bits: u32,
    callbacks: Arc<AtomicU64>,
    dropped: Arc<AtomicUsize>,
    scratch: Vec<f32>,
}

/// Samples handed to the sink: native-rate mono f32 plus the rate.
pub type RawSink = Arc<dyn Fn(&[f32], u32) + Send + Sync>;

#[allow(dead_code)]
pub struct ProcessTap {
    // Drop order matters: stop the device, then free the context, then destroy the tap.
    _device: ca::hardware::StartedDevice<ca::AggregateDevice>,
    _ctx: Box<Ctx>,
    tap: ca::TapGuard,
    stop: Arc<AtomicBool>,
    pump: Option<std::thread::JoinHandle<()>>,
    callbacks: Arc<AtomicU64>,
    pub dropped: Arc<AtomicUsize>,
    pub sample_rate: u32,
    started: Instant,
}

extern "C" fn io_proc(
    _device: ca::Device,
    _now: &cat::AudioTimeStamp,
    input_data: &cat::AudioBufList<1>,
    _input_time: &cat::AudioTimeStamp,
    _output_data: &mut cat::AudioBufList<1>,
    _output_time: &cat::AudioTimeStamp,
    ctx: Option<&mut Ctx>,
) -> os::Status {
    let Some(ctx) = ctx else { return os::Status::NO_ERR };
    ctx.callbacks.fetch_add(1, Ordering::Relaxed);
    let buf = &input_data.buffers[0];
    if buf.data_bytes_size == 0 || buf.data.is_null() {
        return os::Status::NO_ERR;
    }
    let channels = ctx.channels.max(1);
    let bytes = buf.data_bytes_size as usize;
    if ctx.is_float && ctx.bits == 32 {
        let n = bytes / 4;
        let data = unsafe { std::slice::from_raw_parts(buf.data as *const f32, n) };
        push_mixed(ctx, data, channels, |s| s);
    } else if !ctx.is_float && ctx.bits == 16 {
        let n = bytes / 2;
        let data = unsafe { std::slice::from_raw_parts(buf.data as *const i16, n) };
        push_mixed(ctx, data, channels, |s| s as f32 / 32768.0);
    } else if !ctx.is_float && ctx.bits == 32 {
        let n = bytes / 4;
        let data = unsafe { std::slice::from_raw_parts(buf.data as *const i32, n) };
        push_mixed(ctx, data, channels, |s| s as f32 / 2147483648.0);
    }
    os::Status::NO_ERR
}

fn push_mixed<T: Copy>(ctx: &mut Ctx, data: &[T], channels: usize, conv: impl Fn(T) -> f32) {
    let frames = data.len() / channels;
    if ctx.scratch.len() < frames {
        // Rare: only when the HAL delivers a bigger buffer than the pre-allocated scratch.
        ctx.dropped.fetch_add(frames, Ordering::Relaxed);
        return;
    }
    for f in 0..frames {
        let mut acc = 0.0;
        for c in 0..channels {
            acc += conv(data[f * channels + c]);
        }
        ctx.scratch[f] = acc / channels as f32;
    }
    let written = ctx.producer.push_slice(&ctx.scratch[..frames]);
    if written < frames {
        ctx.dropped.fetch_add(frames - written, Ordering::Relaxed);
    }
}

impl ProcessTap {
    /// Taps exactly these Core Audio process objects (one app group).
    pub fn start(process_objs: &[u32], name: &str, mute_playback: bool, sink: RawSink) -> Result<Self> {
        if process_objs.is_empty() {
            return Err(anyhow!("no process objects to tap"));
        }
        let numbers: Vec<arc::R<ns::Number>> = process_objs.iter().map(|id| ns::Number::with_u32(*id)).collect();
        let array = ns::Array::from_slice_retained(&numbers);
        let mut desc = ca::TapDesc::with_mono_mixdown_of_processes(&array);
        desc.set_private(true);
        desc.set_mute_behavior(if mute_playback { ca::TapMuteBehavior::MuttedWhenTapped } else { ca::TapMuteBehavior::Unmuted });
        let tap = desc.create_process_tap().map_err(|e| anyhow!("create tap: {e:?}"))?;
        let asbd = tap.asbd().map_err(|e| anyhow!("tap format: {e:?}"))?;
        let sample_rate = asbd.sample_rate as u32;
        let channels = asbd.channels_per_frame as usize;
        let is_float = asbd.format_flags.contains(cat::AudioFormatFlags::IS_FLOAT);
        let bits = asbd.bits_per_channel;
        let tap_uid = tap.uid().map_err(|e| anyhow!("tap uid: {e:?}"))?;

        let sub_tap = cf::DictionaryOf::with_keys_values(
            &[ca::hardware::sub_tap_keys::uid(), ca::hardware::sub_tap_keys::drift_compensation()],
            &[tap_uid.as_type_ref(), cf::Boolean::value_true()],
        );
        let device_name = cf::String::from_str(&format!("{}{}", crate::DEVICE_PREFIX, name));
        let agg_desc = cf::DictionaryOf::with_keys_values(
            &[agg_keys::is_private(), agg_keys::tap_auto_start(), agg_keys::name(), agg_keys::uid(), agg_keys::tap_list()],
            &[
                cf::Boolean::value_true().as_type_ref(),
                cf::Boolean::value_true(),
                device_name.as_ref(),
                &cf::Uuid::new().to_cf_string(),
                &cf::ArrayOf::from_slice(&[sub_tap.as_ref()]),
            ],
        );

        let rb = HeapRb::<f32>::new(sample_rate as usize * 2);
        let (producer, consumer) = rb.split();
        let callbacks = Arc::new(AtomicU64::new(0));
        let dropped = Arc::new(AtomicUsize::new(0));
        let mut ctx = Box::new(Ctx {
            producer,
            channels,
            is_float,
            bits,
            callbacks: callbacks.clone(),
            dropped: dropped.clone(),
            scratch: vec![0.0; 16_384],
        });

        let agg = ca::AggregateDevice::with_desc(&agg_desc).map_err(|e| anyhow!("aggregate device: {e:?}"))?;
        let proc_id = agg.create_io_proc_id(io_proc, Some(&mut ctx)).map_err(|e| anyhow!("io proc: {e:?}"))?;
        let device = ca::device_start(agg, Some(proc_id)).map_err(|e| anyhow!("device start: {e:?}"))?;

        let stop = Arc::new(AtomicBool::new(false));
        let pump = spawn_pump(consumer, sample_rate, sink, stop.clone());
        tracing::info!(sample_rate, channels, objs = ?process_objs, "process tap started");
        Ok(Self {
            _device: device,
            _ctx: ctx,
            tap,
            stop,
            pump: Some(pump),
            callbacks,
            dropped,
            sample_rate,
            started: Instant::now(),
        })
    }

    /// Switches whether the app's own output is silenced while tapped, without restarting the tap.
    pub fn set_mute_playback(&mut self, mute_playback: bool) -> Result<()> {
        let mut desc = self.tap.desc().map_err(|e| anyhow!("tap description: {e:?}"))?;
        desc.set_mute_behavior(if mute_playback { ca::TapMuteBehavior::MuttedWhenTapped } else { ca::TapMuteBehavior::Unmuted });
        self.tap.set_desc(desc).map_err(|e| anyhow!("update tap: {e:?}"))?;
        Ok(())
    }

    pub fn callbacks(&self) -> u64 {
        self.callbacks.load(Ordering::Relaxed)
    }

    pub fn age(&self) -> Duration {
        self.started.elapsed()
    }
}

impl Drop for ProcessTap {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(p) = self.pump.take() {
            let _ = p.join();
        }
    }
}

fn spawn_pump(mut consumer: HeapCons<f32>, rate: u32, sink: RawSink, stop: Arc<AtomicBool>) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("mc-tap-pump".into())
        .spawn(move || {
            let mut buf = vec![0.0f32; rate as usize / 10];
            while !stop.load(Ordering::Relaxed) {
                let n = consumer.pop_slice(&mut buf);
                if n > 0 {
                    sink(&buf[..n], rate);
                } else {
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        })
        .expect("spawn pump")
}
