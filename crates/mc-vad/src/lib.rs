//! Speech chunking for transcription (design 4.8).
//!
//! MVP-1 uses an adaptive energy detector; Silero replaces `is_speech` in MVP-2 without changing the
//! chunk policy, which follows Anarlog's `audio-chunking` (≥200 ms speech, merge gaps under the
//! silence hang) plus a hard 15 s cap so continuous audio (music, podcasts) still produces text
//! (Meetily issue #756).

use mc_core::{ms_to_samples, samples_to_ms};

const WINDOW_MS: i64 = 30;
pub const MIN_SPEECH_MS: i64 = 200;
pub const SILENCE_HANG_MS: i64 = 500;
pub const MAX_CHUNK_MS: i64 = 15_000;
const PRE_ROLL_MS: i64 = 200;
/// Never treat audio below this level as speech (~ -50 dBFS).
const ABS_FLOOR: f32 = 0.003;

#[derive(Debug, Clone, PartialEq)]
pub struct SpeechChunk {
    /// Session time of the first sample.
    pub start_ms: i64,
    pub end_ms: i64,
    pub samples: Vec<f32>,
}

pub struct Chunker {
    window: usize,
    pending: Vec<f32>,
    /// Session time (in samples) of `pending[0]`.
    pending_start: usize,
    noise: f32,
    pre_roll: std::collections::VecDeque<f32>,
    current: Option<Current>,
}

struct Current {
    start: usize,
    samples: Vec<f32>,
    speech_samples: usize,
    silence_run: usize,
}

impl Default for Chunker {
    fn default() -> Self {
        Self::new(0)
    }
}

impl Chunker {
    /// `start_samples`: session time of the first sample that will be pushed.
    pub fn new(start_samples: usize) -> Self {
        Self {
            window: ms_to_samples(WINDOW_MS),
            pending: Vec::new(),
            pending_start: start_samples,
            noise: ABS_FLOOR,
            pre_roll: Default::default(),
            current: None,
        }
    }

    pub fn push(&mut self, samples: &[f32]) -> Vec<SpeechChunk> {
        self.pending.extend_from_slice(samples);
        let mut out = Vec::new();
        while self.pending.len() >= self.window {
            let win: Vec<f32> = self.pending.drain(..self.window).collect();
            let win_start = self.pending_start;
            self.pending_start += self.window;
            if let Some(chunk) = self.process_window(&win, win_start) {
                out.push(chunk);
            }
        }
        out
    }

    /// Flushes the open chunk (end of stream or mode switch).
    pub fn finish(&mut self) -> Option<SpeechChunk> {
        let rest = std::mem::take(&mut self.pending);
        if !rest.is_empty() {
            if let Some(cur) = self.current.as_mut() {
                cur.samples.extend_from_slice(&rest);
            }
        }
        self.close()
    }

    fn rms(win: &[f32]) -> f32 {
        (win.iter().map(|s| s * s).sum::<f32>() / win.len() as f32).sqrt()
    }

    fn process_window(&mut self, win: &[f32], win_start: usize) -> Option<SpeechChunk> {
        let level = Self::rms(win);
        let threshold = (self.noise * 2.5).max(ABS_FLOOR);
        let speech = level > threshold;
        if !speech {
            // Track the noise floor only on non-speech windows; slow attack, faster release.
            self.noise = if level < self.noise { self.noise * 0.9 + level * 0.1 } else { self.noise * 0.995 + level * 0.005 };
            self.noise = self.noise.max(ABS_FLOOR * 0.5);
        }
        let mut emitted = None;
        match self.current.as_mut() {
            None if speech => {
                let pre: Vec<f32> = self.pre_roll.iter().copied().collect();
                let start = win_start - pre.len();
                let mut samples = pre;
                samples.extend_from_slice(win);
                self.current = Some(Current { start, samples, speech_samples: win.len(), silence_run: 0 });
            }
            None => {}
            Some(cur) => {
                cur.samples.extend_from_slice(win);
                if speech {
                    cur.speech_samples += win.len();
                    cur.silence_run = 0;
                } else {
                    cur.silence_run += win.len();
                }
                let hang = cur.silence_run >= ms_to_samples(SILENCE_HANG_MS);
                let full = cur.samples.len() >= ms_to_samples(MAX_CHUNK_MS);
                if hang || full {
                    emitted = self.close();
                }
            }
        }
        self.pre_roll.extend(win.iter().copied());
        while self.pre_roll.len() > ms_to_samples(PRE_ROLL_MS) {
            self.pre_roll.pop_front();
        }
        emitted
    }

    fn close(&mut self) -> Option<SpeechChunk> {
        let cur = self.current.take()?;
        if cur.speech_samples < ms_to_samples(MIN_SPEECH_MS) {
            return None;
        }
        // Drop trailing silence beyond 200 ms.
        let keep_tail = ms_to_samples(PRE_ROLL_MS);
        let mut samples = cur.samples;
        if cur.silence_run > keep_tail {
            let cut = cur.silence_run - keep_tail;
            samples.truncate(samples.len().saturating_sub(cut));
        }
        Some(SpeechChunk {
            start_ms: samples_to_ms(cur.start),
            end_ms: samples_to_ms(cur.start + samples.len()),
            samples,
        })
    }
}

/// Chunks a whole recording (after-mode transcription).
pub fn chunk_all(samples: &[f32], start_samples: usize) -> Vec<SpeechChunk> {
    let mut c = Chunker::new(start_samples);
    let mut out = c.push(samples);
    out.extend(c.finish());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(ms: i64) -> Vec<f32> {
        (0..ms_to_samples(ms)).map(|i| ((i as f32) * 0.07).sin() * 0.2).collect()
    }
    fn silence(ms: i64) -> Vec<f32> {
        vec![0.0005; ms_to_samples(ms)]
    }

    #[test]
    fn splits_on_silence() {
        let mut audio = silence(1000);
        audio.extend(tone(2000));
        audio.extend(silence(1000));
        audio.extend(tone(1500));
        audio.extend(silence(800));
        let chunks = chunk_all(&audio, 0);
        assert_eq!(chunks.len(), 2, "{:?}", chunks.iter().map(|c| (c.start_ms, c.end_ms)).collect::<Vec<_>>());
        assert!((chunks[0].start_ms - 800).abs() <= 40);
        assert!(chunks[1].start_ms >= 3750 && chunks[1].start_ms <= 4000);
    }

    #[test]
    fn caps_continuous_audio_at_15_seconds() {
        let chunks = chunk_all(&tone(40_000), 0);
        assert!(chunks.len() >= 3);
        assert!(chunks.iter().all(|c| c.end_ms - c.start_ms <= MAX_CHUNK_MS + 50));
    }

    #[test]
    fn ignores_clicks_shorter_than_min_speech() {
        let mut audio = silence(1000);
        audio.extend(tone(90));
        audio.extend(silence(1000));
        assert!(chunk_all(&audio, 0).is_empty());
    }

    #[test]
    fn honours_session_offset() {
        let mut audio = silence(500);
        audio.extend(tone(1000));
        audio.extend(silence(700));
        let chunks = chunk_all(&audio, ms_to_samples(60_000));
        assert!(chunks[0].start_ms >= 60_000);
    }
}
