//! Audio helpers shared by capture, recording and transcription: resampling to 16 kHz, levels,
//! dropout detection and WAV encoding.

use mc_core::SAMPLE_RATE;
use rubato::{FftFixedIn, Resampler};

/// Streaming mono resampler to 16 kHz. Input arrives in arbitrary block sizes.
pub struct StreamResampler {
    from: u32,
    inner: Option<FftFixedIn<f32>>,
    pending: Vec<f32>,
    chunk: usize,
}

impl StreamResampler {
    pub fn new(from: u32) -> anyhow::Result<Self> {
        let chunk = (from as usize / 100).max(1); // 10 ms of input per FFT block
        let inner = if from == SAMPLE_RATE {
            None
        } else {
            Some(FftFixedIn::<f32>::new(from as usize, SAMPLE_RATE as usize, chunk, 2, 1)?)
        };
        Ok(Self { from, inner, pending: Vec::new(), chunk })
    }

    pub fn input_rate(&self) -> u32 {
        self.from
    }

    pub fn push(&mut self, input: &[f32]) -> Vec<f32> {
        let Some(inner) = self.inner.as_mut() else {
            return input.to_vec();
        };
        self.pending.extend_from_slice(input);
        let mut out = Vec::with_capacity(input.len() * SAMPLE_RATE as usize / self.from as usize + 16);
        while self.pending.len() >= self.chunk {
            let block: Vec<f32> = self.pending.drain(..self.chunk).collect();
            if let Ok(mut res) = inner.process(&[block], None) {
                out.append(&mut res[0]);
            }
        }
        out
    }
}

/// Root mean square level in dBFS (-120 for silence).
pub fn rms_db(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return -120.0;
    }
    let sum: f64 = samples.iter().map(|s| (*s as f64) * (*s as f64)).sum();
    let rms = (sum / samples.len() as f64).sqrt();
    if rms <= 1e-6 {
        -120.0
    } else {
        (20.0 * rms.log10()) as f32
    }
}

pub fn is_all_zero(samples: &[f32]) -> bool {
    samples.iter().all(|s| s.abs() < 1e-7)
}

/// Reports when, within a 5 s window, more than 15 % of samples are exact zeros
/// (device or tap stopped delivering audio). Thresholds follow Anarlog's listener pipeline.
pub struct DropoutDetector {
    window: usize,
    seen: usize,
    zeros: usize,
    reported: bool,
}

impl Default for DropoutDetector {
    fn default() -> Self {
        Self { window: SAMPLE_RATE as usize * 5, seen: 0, zeros: 0, reported: false }
    }
}

impl DropoutDetector {
    /// Returns `true` once per window that crosses the threshold.
    pub fn push(&mut self, samples: &[f32]) -> bool {
        self.seen += samples.len();
        self.zeros += samples.iter().filter(|s| **s == 0.0).count();
        if self.seen >= self.window {
            let ratio = self.zeros as f32 / self.seen as f32;
            self.seen = 0;
            self.zeros = 0;
            let crossed = ratio > 0.15;
            let fire = crossed && !self.reported;
            self.reported = crossed;
            return fire;
        }
        false
    }
}

pub fn f32_to_i16(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
}

pub fn i16_to_f32(sample: i16) -> f32 {
    sample as f32 / 32768.0
}

/// 16 kHz mono PCM16 WAV bytes.
pub fn encode_wav(samples: &[f32]) -> anyhow::Result<Vec<u8>> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cursor = std::io::Cursor::new(Vec::with_capacity(samples.len() * 2 + 44));
    {
        let mut writer = hound::WavWriter::new(&mut cursor, spec)?;
        for s in samples {
            writer.write_sample(f32_to_i16(*s))?;
        }
        writer.finalize()?;
    }
    Ok(cursor.into_inner())
}

/// Reads any PCM WAV/AIFF-free WAV into 16 kHz mono (test helper and file import).
pub fn decode_wav_to_16k(bytes: &[u8]) -> anyhow::Result<Vec<f32>> {
    let mut reader = hound::WavReader::new(std::io::Cursor::new(bytes))?;
    let spec = reader.spec();
    let channels = spec.channels as usize;
    let raw: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().collect::<Result<_, _>>()?,
        hound::SampleFormat::Int => {
            let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader.samples::<i32>().map(|s| s.map(|v| v as f32 / max)).collect::<Result<_, _>>()?
        }
    };
    let mono: Vec<f32> = raw
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect();
    let mut resampler = StreamResampler::new(spec.sample_rate)?;
    let mut out = resampler.push(&mono);
    out.extend(resampler.push(&vec![0.0; resampler.chunk]));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(rate: u32, freq: f32, secs: f32) -> Vec<f32> {
        (0..(rate as f32 * secs) as usize)
            .map(|i| (i as f32 / rate as f32 * freq * std::f32::consts::TAU).sin() * 0.5)
            .collect()
    }

    #[test]
    fn resampler_keeps_duration() {
        let mut r = StreamResampler::new(48_000).unwrap();
        let input = sine(48_000, 440.0, 1.0);
        let mut out = Vec::new();
        for block in input.chunks(512) {
            out.extend(r.push(block));
        }
        // FFT resampler has a small startup delay; length is within one block of 1 s.
        assert!((out.len() as i64 - 16_000).abs() < 400, "len {}", out.len());
    }

    #[test]
    fn passthrough_at_16k() {
        let mut r = StreamResampler::new(16_000).unwrap();
        assert_eq!(r.push(&[0.1, 0.2]).len(), 2);
    }

    #[test]
    fn rms_and_zero() {
        assert!(rms_db(&sine(16_000, 440.0, 0.1)) > -10.0);
        assert_eq!(rms_db(&[0.0; 100]), -120.0);
        assert!(is_all_zero(&[0.0; 10]));
    }

    #[test]
    fn dropout_fires_once() {
        let mut d = DropoutDetector::default();
        let zeros = vec![0.0; 16_000];
        let mut fired = 0;
        for _ in 0..12 {
            if d.push(&zeros) {
                fired += 1;
            }
        }
        assert_eq!(fired, 1);
    }

    #[test]
    fn wav_round_trip() {
        let input = sine(16_000, 300.0, 0.5);
        let bytes = encode_wav(&input).unwrap();
        let back = decode_wav_to_16k(&bytes).unwrap();
        assert!(back.len() >= input.len());
    }
}
