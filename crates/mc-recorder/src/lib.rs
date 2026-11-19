//! Archive writer: one FLAC file per 60 s of mono audio, with SHA-256 and a disk reserve check.
//! A crash loses at most the minute being written (design 4.7). Opus is planned for MVP-2.

use std::path::{Path, PathBuf};

use mc_core::RecordingFormat;
use sha2::{Digest, Sha256};

pub const SEGMENT_SECONDS: usize = 60;
/// Below this much free space new sessions are refused and recording reports storage trouble.
pub const DISK_RESERVE_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct SegmentInfo {
    pub seq: i64,
    pub start_ms: i64,
    pub end_ms: i64,
    pub path: PathBuf,
    pub bytes: i64,
    pub sha256: String,
}

pub struct SegmentWriter {
    dir: PathBuf,
    format: RecordingFormat,
    next_seq: i64,
    seg_start_samples: usize,
    buf: Vec<f32>,
}

impl SegmentWriter {
    /// `first_seq` and `start_samples` let a session continue after a restart.
    pub fn new(dir: &Path, first_seq: i64, start_samples: usize, format: RecordingFormat) -> anyhow::Result<Self> {
        format.validate()?;
        std::fs::create_dir_all(dir)?;
        Ok(Self { dir: dir.to_path_buf(), format, next_seq: first_seq, seg_start_samples: start_samples, buf: Vec::new() })
    }

    /// Appends audio; returns the segments completed by this call.
    pub fn push(&mut self, samples: &[f32]) -> anyhow::Result<Vec<SegmentInfo>> {
        let per = self.format.sample_rate as usize * SEGMENT_SECONDS;
        let mut done = Vec::new();
        let mut rest = samples;
        while !rest.is_empty() {
            let room = per - self.buf.len();
            let take = room.min(rest.len());
            self.buf.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
            if self.buf.len() == per {
                done.push(self.write_current()?);
            }
        }
        Ok(done)
    }

    /// Writes whatever is buffered (end of session).
    pub fn finish(&mut self) -> anyhow::Result<Option<SegmentInfo>> {
        if self.buf.is_empty() {
            return Ok(None);
        }
        self.write_current().map(Some)
    }

    pub fn buffered_samples(&self) -> usize {
        self.buf.len()
    }

    fn write_current(&mut self) -> anyhow::Result<SegmentInfo> {
        let path = self.dir.join(format!("{:06}.flac", self.next_seq));
        let bytes = encode_flac(&self.buf, self.format)?;
        let tmp = path.with_extension("flac.part");
        std::fs::write(&tmp, &bytes)?;
        std::fs::rename(&tmp, &path)?;
        let info = SegmentInfo {
            seq: self.next_seq,
            start_ms: self.format.duration_ms(self.seg_start_samples),
            end_ms: self.format.duration_ms(self.seg_start_samples + self.buf.len()),
            path,
            bytes: bytes.len() as i64,
            sha256: hex::encode(Sha256::digest(&bytes)),
        };
        self.seg_start_samples += self.buf.len();
        self.next_seq += 1;
        self.buf.clear();
        Ok(info)
    }
}

fn encode_flac(samples: &[f32], format: RecordingFormat) -> anyhow::Result<Vec<u8>> {
    use flacenc::component::BitRepr;
    use flacenc::error::Verify;
    let ints: Vec<i32> = samples.iter().map(|s| mc_audio::pcm_sample(*s, format.bits_per_sample)).collect();
    let config = flacenc::config::Encoder::default()
        .into_verified()
        .map_err(|e| anyhow::anyhow!("flac config: {e:?}"))?;
    let source = flacenc::source::MemSource::from_samples(&ints, 1, format.bits_per_sample as usize, format.sample_rate as usize);
    let stream = flacenc::encode_with_fixed_block_size(&config, source, config.block_size)
        .map_err(|e| anyhow::anyhow!("flac encode: {e:?}"))?;
    let mut sink = flacenc::bitsink::ByteSink::new();
    stream.write(&mut sink).map_err(|e| anyhow::anyhow!("flac write: {e:?}"))?;
    Ok(sink.as_slice().to_vec())
}

fn decode_flac(path: &Path) -> anyhow::Result<(RecordingFormat, Vec<f32>)> {
    let mut reader = claxon::FlacReader::open(path)?;
    let info = reader.streaminfo();
    let format = RecordingFormat { sample_rate: info.sample_rate, bits_per_sample: info.bits_per_sample as u16 };
    format.validate()?;
    let scale = (1 << (format.bits_per_sample - 1)) as f32;
    let samples = reader.samples().take(info.samples.map_or(usize::MAX, |count| count as usize))
        .map(|s| s.map(|v| v as f32 / scale)).collect::<Result<Vec<_>, _>>()?;
    Ok((format, samples))
}

/// Reads archived PCM with the original sample rate and bit depth. An open end includes the final sample.
pub fn read_archive(segments: &[SegmentInfo], start_ms: i64, end_ms: Option<i64>) -> anyhow::Result<(RecordingFormat, Vec<f32>)> {
    let mut format = None;
    let mut out = Vec::new();
    for seg in segments.iter().filter(|s| s.end_ms >= start_ms && end_ms.is_none_or(|end| s.start_ms < end)) {
        let (current, samples) = decode_flac(&seg.path)?;
        anyhow::ensure!(*format.get_or_insert(current) == current, "Archive format changed during recording");
        let from = current.samples_at(start_ms - seg.start_ms).min(samples.len());
        let to = end_ms.filter(|end| *end < seg.end_ms).map_or(samples.len(), |end| current.samples_at(end - seg.start_ms)).min(samples.len());
        if from < to {
            out.extend_from_slice(&samples[from..to]);
        }
    }
    Ok((format.unwrap_or_default(), out))
}

/// Reads a speech range as the engine's 16 kHz mono PCM.
pub fn read_range(segments: &[SegmentInfo], start_ms: i64, end_ms: i64) -> anyhow::Result<Vec<f32>> {
    if end_ms <= start_ms {
        return Ok(Vec::new());
    }
    let (format, audio) = read_archive(segments, start_ms, Some(end_ms))?;
    mc_audio::resample_to_16k(&audio, format.sample_rate)
}

/// Free bytes on the volume holding `path`.
pub fn free_bytes(path: &Path) -> Option<u64> {
    use std::ffi::CString;
    let c = CString::new(path.to_string_lossy().as_bytes()).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut stat) } != 0 {
        return None;
    }
    Some(stat.f_bavail as u64 * stat.f_frsize as u64)
}

pub fn has_disk_reserve(path: &Path) -> bool {
    free_bytes(path).map(|b| b >= DISK_RESERVE_BYTES).unwrap_or(true)
}

/// Removes half-written `.part` files left by a crash.
pub fn clean_partial(dir: &Path) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            if e.path().extension().is_some_and(|x| x == "part") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mc_core::SAMPLE_RATE;

    fn tone(secs: usize) -> Vec<f32> {
        (0..SAMPLE_RATE as usize * secs).map(|i| ((i as f32) * 0.05).sin() * 0.3).collect()
    }

    #[test]
    fn high_resolution_archive_keeps_bit_depth_and_resamples_only_for_speech() {
        let dir = std::env::temp_dir().join(format!("mc-rec-{}", mc_core::new_id()));
        let format = RecordingFormat { sample_rate: 48_000, bits_per_sample: 24 };
        let mut writer = SegmentWriter::new(&dir, 0, 0, format).unwrap();
        let audio: Vec<_> = (0..48_005).map(|i| {
            0.2 * (i as f32 * 0.1).sin() + (i % 10) as f32 * 0.000_001
        }).collect();
        writer.push(&audio).unwrap();
        let segments = [writer.finish().unwrap().unwrap()];
        let (metadata, decoded) = read_archive(&segments, 0, None).unwrap();
        assert_eq!(metadata, format);
        assert_eq!(decoded.len(), audio.len());
        assert!((decoded[3] - audio[3]).abs() < 1e-6);
        let (_, selection) = read_archive(&segments, 200, Some(700)).unwrap();
        assert_eq!(selection.len(), 24_000);
        let wav = mc_audio::encode_wav_with_format(&selection, metadata).unwrap();
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 48_000);
        assert_eq!(u16::from_le_bytes(wav[34..36].try_into().unwrap()), 24);
        assert_eq!(read_range(&segments, 200, 700).unwrap().len(), 8_000);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn splits_into_minute_segments_and_reads_back() {
        let dir = std::env::temp_dir().join(format!("mc-rec-{}", mc_core::new_id()));
        let mut w = SegmentWriter::new(&dir, 0, 0, RecordingFormat::default()).unwrap();
        let audio = tone(130);
        let mut segs = Vec::new();
        for block in audio.chunks(16_000) {
            segs.extend(w.push(block).unwrap());
        }
        segs.extend(w.finish().unwrap());
        assert_eq!(segs.len(), 3);
        assert_eq!(segs[0].start_ms, 0);
        assert_eq!(segs[1].start_ms, 60_000);
        assert_eq!(segs[2].end_ms, 130_000);
        assert_eq!(segs[0].sha256.len(), 64);
        let mid = read_range(&segs, 59_000, 61_000).unwrap();
        assert_eq!(mid.len(), 32_000);
        assert!((mid[0] - audio[16_000 * 59]).abs() < 1e-3);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn disk_check_works() {
        assert!(free_bytes(&std::env::temp_dir()).is_some());
    }
}
