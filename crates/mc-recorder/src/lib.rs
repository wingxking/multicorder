//! Archive writer: one FLAC file per 60 s of 16 kHz mono audio, with SHA-256 and a disk reserve check.
//! A crash loses at most the minute being written (design 4.7). Opus is planned for MVP-2.

use std::path::{Path, PathBuf};

use mc_core::{samples_to_ms, SAMPLE_RATE};
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
    next_seq: i64,
    seg_start_samples: usize,
    buf: Vec<f32>,
}

impl SegmentWriter {
    /// `first_seq` and `start_samples` let a session continue after a restart.
    pub fn new(dir: &Path, first_seq: i64, start_samples: usize) -> anyhow::Result<Self> {
        std::fs::create_dir_all(dir)?;
        Ok(Self { dir: dir.to_path_buf(), next_seq: first_seq, seg_start_samples: start_samples, buf: Vec::new() })
    }

    /// Appends audio; returns the segments completed by this call.
    pub fn push(&mut self, samples: &[f32]) -> anyhow::Result<Vec<SegmentInfo>> {
        let per = SAMPLE_RATE as usize * SEGMENT_SECONDS;
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
        let bytes = encode_flac(&self.buf)?;
        let tmp = path.with_extension("flac.part");
        std::fs::write(&tmp, &bytes)?;
        std::fs::rename(&tmp, &path)?;
        let info = SegmentInfo {
            seq: self.next_seq,
            start_ms: samples_to_ms(self.seg_start_samples),
            end_ms: samples_to_ms(self.seg_start_samples + self.buf.len()),
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

pub fn encode_flac(samples: &[f32]) -> anyhow::Result<Vec<u8>> {
    use flacenc::component::BitRepr;
    use flacenc::error::Verify;
    let ints: Vec<i32> = samples.iter().map(|s| mc_audio::f32_to_i16(*s) as i32).collect();
    let config = flacenc::config::Encoder::default()
        .into_verified()
        .map_err(|e| anyhow::anyhow!("flac config: {e:?}"))?;
    let source = flacenc::source::MemSource::from_samples(&ints, 1, 16, SAMPLE_RATE as usize);
    let stream = flacenc::encode_with_fixed_block_size(&config, source, config.block_size)
        .map_err(|e| anyhow::anyhow!("flac encode: {e:?}"))?;
    let mut sink = flacenc::bitsink::ByteSink::new();
    stream.write(&mut sink).map_err(|e| anyhow::anyhow!("flac write: {e:?}"))?;
    Ok(sink.as_slice().to_vec())
}

pub fn decode_flac(path: &Path) -> anyhow::Result<Vec<f32>> {
    let mut reader = claxon::FlacReader::open(path)?;
    let mut out = Vec::new();
    for s in reader.samples() {
        out.push(mc_audio::i16_to_f32(s? as i16));
    }
    Ok(out)
}

/// Reads [start_ms, end_ms) of a session from its ordered segments.
pub fn read_range(segments: &[SegmentInfo], start_ms: i64, end_ms: i64) -> anyhow::Result<Vec<f32>> {
    let mut out = Vec::new();
    for seg in segments.iter().filter(|s| s.end_ms > start_ms && s.start_ms < end_ms) {
        let samples = decode_flac(&seg.path)?;
        let from = mc_core::ms_to_samples((start_ms - seg.start_ms).max(0));
        let to = mc_core::ms_to_samples((end_ms - seg.start_ms).min(seg.end_ms - seg.start_ms)).min(samples.len());
        if from < to {
            out.extend_from_slice(&samples[from..to]);
        }
    }
    Ok(out)
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

    fn tone(secs: usize) -> Vec<f32> {
        (0..SAMPLE_RATE as usize * secs).map(|i| ((i as f32) * 0.05).sin() * 0.3).collect()
    }

    #[test]
    fn splits_into_minute_segments_and_reads_back() {
        let dir = std::env::temp_dir().join(format!("mc-rec-{}", mc_core::new_id()));
        let mut w = SegmentWriter::new(&dir, 0, 0).unwrap();
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
