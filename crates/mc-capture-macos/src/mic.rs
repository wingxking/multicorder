//! One input-only HAL audio unit per explicitly selected microphone source.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use anyhow::{anyhow, ensure, Result};
use cidre::{
    at::{self, au},
    av, blocks, core_audio as ca, os,
};
use mc_audio::StreamResampler;
use ringbuf::traits::{Consumer, Producer, Split};
use ringbuf::{HeapProd, HeapRb};

use crate::{CaptureEvent, EventSink, MicrophoneInfo, AudioSink, DEVICE_PREFIX};

fn input_sources(uid: &str, name: &str, is_default: bool, channels: u32) -> Vec<MicrophoneInfo> {
    let mut inputs = vec![MicrophoneInfo {
        id: uid.into(),
        name: name.into(),
        is_default,
        channel: None,
    }];
    if channels > 1 {
        inputs.extend((1..=channels).map(|channel| MicrophoneInfo {
            id: format!("channel:{}:{uid}:{channel}", uid.len()),
            name: format!("{name} · Channel {channel}"),
            is_default: false,
            channel: Some(channel),
        }));
    }
    inputs
}

fn input_devices() -> Result<Vec<(ca::Device, MicrophoneInfo)>> {
    let default = ca::System::default_input_device().ok();
    let devices =
        ca::System::devices().map_err(|e| anyhow!("Could not list audio devices: {e:?}"))?;
    Ok(devices
        .into_iter()
        .filter_map(|device| {
            let input = device.input_stream_cfg().ok()?;
            let channels = input
                .buffers()
                .iter()
                .map(|buffer| buffer.number_channels)
                .sum::<u32>();
            if channels == 0 {
                return None;
            }
            let name = device.name().ok()?.to_string();
            if name.starts_with(DEVICE_PREFIX) {
                return None;
            }
            let uid = device.uid().ok()?.to_string();
            Some(
                input_sources(&uid, &name, default == Some(device), channels)
                    .into_iter()
                    .map(move |source| (device, source)),
            )
        })
        .flatten()
        .collect())
}

pub fn list_microphones() -> Result<Vec<MicrophoneInfo>> {
    let mut microphones: Vec<_> = input_devices()?.into_iter().map(|(_, info)| info).collect();
    microphones.sort_by(|a, b| b.is_default.cmp(&a.is_default).then(a.name.cmp(&b.name)));
    Ok(microphones)
}

fn resolve(device_id: Option<&str>) -> Result<(ca::Device, MicrophoneInfo)> {
    input_devices()?
        .into_iter()
        .find(|(_, info)| device_id.map_or(info.is_default, |id| info.id == id))
        .ok_or_else(|| anyhow!("The selected microphone is unavailable"))
}

pub fn microphone(device_id: Option<&str>) -> Result<MicrophoneInfo> {
    resolve(device_id).map(|(_, info)| info)
}

pub struct MicCapture {
    stop: Arc<AtomicBool>,
    thread: std::thread::JoinHandle<()>,
}

impl MicCapture {
    pub fn start(device_id: &str, sample_rate: u32, sink: AudioSink, events: EventSink) -> Result<Self> {
        let (device, info) = resolve(Some(device_id))?;
        let stop = Arc::new(AtomicBool::new(false));
        let stop_worker = stop.clone();
        let thread = std::thread::Builder::new()
            .name("mc-microphone".into())
            .spawn(move || {
                if let Err(error) = capture(device, &info, sample_rate, sink, &stop_worker) {
                    if !stop_worker.load(Ordering::Acquire) {
                        events(CaptureEvent::Error(error.to_string()));
                    }
                }
            })?;
        Ok(Self { stop, thread })
    }
}

impl Drop for MicCapture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.thread.thread().unpark();
    }
}

fn authorized(stop: &AtomicBool) -> Result<bool> {
    let media = av::MediaType::audio();
    let status = av::CaptureDevice::authorization_status_for_media_type(media)
        .map_err(|_| anyhow!("Could not check microphone permission"))?;
    match status {
        av::AuthorizationStatus::Authorized => Ok(true),
        av::AuthorizationStatus::Denied | av::AuthorizationStatus::Restricted => Ok(false),
        av::AuthorizationStatus::NotDetermined => {
            let (tx, rx) = mpsc::channel();
            let mut reply = blocks::SendBlock::new1(move |allowed: bool| {
                let _ = tx.send(allowed);
            });
            av::CaptureDevice::request_access_for_media_type_ch(media, &mut reply)
                .map_err(|_| anyhow!("Could not request microphone permission"))?;
            while !stop.load(Ordering::Acquire) {
                match rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(allowed) => return Ok(allowed),
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
            Ok(false)
        }
    }
}

struct InputContext {
    unit: *mut au::Unit,
    channels: usize,
    pcm: Vec<f32>,
    mono: Vec<f32>,
    producer: HeapProd<f32>,
    render_failed: Arc<AtomicBool>,
}

extern "C-unwind" fn read_input(
    ctx: *mut InputContext,
    flags: &mut au::RenderActionFlags,
    time: &at::AudioTimeStamp,
    bus: u32,
    frames: u32,
    _unused: *mut at::AudioBufList<1>,
) -> os::Status {
    // Core Audio owns this callback and will stop invoking it before the heap context is freed.
    let Some(ctx) = (unsafe { ctx.as_mut() }) else {
        return os::Status::NO_ERR;
    };
    let frames = frames as usize;
    let count = frames.saturating_mul(ctx.channels);
    if frames > ctx.mono.len() || count > ctx.pcm.len() {
        ctx.render_failed.store(true, Ordering::Relaxed);
        return os::Status::NO_ERR;
    }
    let mut buffer = at::AudioBufList {
        number_buffers: 1,
        buffers: [at::audio::Buf {
            number_channels: ctx.channels as u32,
            data_bytes_size: (count * std::mem::size_of::<f32>()) as u32,
            data: ctx.pcm.as_mut_ptr().cast(),
        }],
    };
    unsafe extern "C-unwind" {
        fn AudioUnitRender(
            unit: *mut au::Unit,
            flags: &mut au::RenderActionFlags,
            time: &at::AudioTimeStamp,
            bus: u32,
            frames: u32,
            buffer: &mut at::AudioBufList<1>,
        ) -> os::Status;
    }
    let status = unsafe { AudioUnitRender(ctx.unit, flags, time, bus, frames as u32, &mut buffer) };
    if status == os::Status::NO_ERR {
        for (frame, sample) in ctx.pcm[..count]
            .chunks_exact(ctx.channels)
            .zip(&mut ctx.mono[..frames])
        {
            *sample = frame.iter().sum::<f32>() / ctx.channels as f32;
        }
        ctx.producer.push_slice(&ctx.mono[..frames]);
    } else {
        ctx.render_failed.store(true, Ordering::Relaxed);
    }
    status
}

fn capture(
    device: ca::Device,
    info: &MicrophoneInfo,
    sample_rate: u32,
    sink: AudioSink,
    stop: &AtomicBool,
) -> Result<()> {
    let name = &info.name;
    let allowed = authorized(stop)?;
    if stop.load(Ordering::Acquire) {
        return Ok(());
    }
    ensure!(
        allowed,
        "Allow Multicorder in System Settings → Privacy & Security → Microphone"
    );
    let result = |err: os::Error| anyhow!("Could not open microphone {name}: {err:?}");
    let mut unit = au::Output::new_apple().map_err(result)?;
    unit.set_io_enabled(au::Scope::INPUT, 1, true)
        .map_err(result)?;
    unit.set_io_enabled(au::Scope::OUTPUT, 0, false)
        .map_err(result)?;
    // AUHAL's device selection and input callback use the global element (0).
    unit.unit_mut()
        .set_prop(
            au::PropId::OUTPUT_CURRENT_DEVICE,
            au::Scope::GLOBAL,
            au::Element(0),
            &device,
        )
        .map_err(result)?;
    let hardware = unit
        .unit()
        .stream_format(au::Scope::INPUT, 1)
        .map_err(result)?;
    let device_channels = hardware.channels_per_frame;
    let rate = hardware.sample_rate as u32;
    ensure!(
        device_channels > 0 && rate > 0,
        "{name} has no usable input channels"
    );
    let channels = if let Some(channel) = info.channel {
        ensure!(
            channel <= device_channels,
            "Input channel unavailable: {name}"
        );
        1
    } else {
        device_channels as usize
    };
    let mut resampler = StreamResampler::between(rate, sample_rate)?;
    unit.set_input_stream_format(&at::audio::StreamBasicDesc::common_f32(
        hardware.sample_rate,
        channels as u32,
        true,
    ))
    .map_err(result)?;
    if let Some(channel) = info.channel {
        unit.unit_mut()
            .set_prop(
                au::PropId::CHANNEL_MAP,
                au::Scope::OUTPUT,
                au::Element(1),
                &[(channel - 1) as i32],
            )
            .map_err(result)?;
    }
    let max_frames = unit
        .unit()
        .max_frames_per_slice()
        .map_err(result)?
        .max(4096) as usize;
    let (producer, mut consumer) = HeapRb::<f32>::new(rate as usize * 2).split();
    let render_failed = Arc::new(AtomicBool::new(false));
    let mut ctx = Box::new(InputContext {
        unit: unit.unit_mut(),
        pcm: vec![0.0; max_frames * channels],
        mono: vec![0.0; max_frames],
        channels,
        producer,
        render_failed: render_failed.clone(),
    });
    let context = std::ptr::from_mut(&mut *ctx);
    unit.unit_mut()
        .output_set_input_cb(au::Scope::GLOBAL, 0, read_input, context)
        .map_err(result)?;
    let mut unit = unit.allocate_resources().map_err(result)?;
    unit.start().map_err(result)?;
    let mut last_check = Instant::now();
    let mut raw = vec![0.0; (rate / 10).max(1) as usize];
    let failure = loop {
        if stop.load(Ordering::Acquire) {
            break None;
        }
        if render_failed.load(Ordering::Relaxed) {
            break Some(anyhow!("Could not read audio from {name}"));
        }
        if last_check.elapsed() >= Duration::from_millis(500) {
            if !device.is_alive().unwrap_or(false) {
                break Some(anyhow!("Microphone disconnected: {name}"));
            }
            last_check = Instant::now();
        }
        let count = consumer.pop_slice(&mut raw);
        if count > 0 {
            let samples = resampler.push(&raw[..count]);
            if !samples.is_empty() {
                sink(&samples);
            }
        } else {
            std::thread::park_timeout(Duration::from_millis(10));
        }
    };
    let _ = unit.stop();
    drop(unit);
    failure.map_or(Ok(()), Err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stereo_channels_have_independent_stable_ids() {
        let inputs = input_sources("usb:123", "Receiver", true, 2);
        assert_eq!(inputs.len(), 3);
        assert!(inputs[0].is_default);
        assert_eq!(inputs[0].id, "usb:123");
        assert_eq!(inputs[1].channel, Some(1));
        assert_eq!(inputs[2].channel, Some(2));
        assert_ne!(inputs[1].id, inputs[2].id);
        assert_ne!(
            inputs[1].id,
            input_sources("usb:456", "Receiver", false, 2)[1].id
        );
        assert_eq!(
            inputs[1].id,
            input_sources("usb:123", "Renamed receiver", false, 2)[1].id
        );
        assert_eq!(input_sources("usb:456", "Mono mic", false, 1).len(), 1);
    }
}
