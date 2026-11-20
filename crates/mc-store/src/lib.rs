//! SQLite storage (design section 3). Every read of transcripts or insights takes a session id:
//! cross-session queries only return source-attributed hit lists (isolation invariant 1).
#![allow(clippy::too_many_arguments)]

use std::path::Path;
use std::sync::Mutex;

use mc_core::{now_iso, Evidence, Insight, TranscriptEvent};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('chromium_tab','mac_app','mic')),
  title TEXT NOT NULL,
  app_bundle_id TEXT,
  capture_source_id TEXT,
  canonical_url TEXT,
  video_key TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_groups (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS capture_sessions (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  group_id TEXT REFERENCES session_groups(id),
  track_role TEXT,
  status TEXT NOT NULL,
  summary_mode TEXT NOT NULL DEFAULT 'after',
  share_state TEXT NOT NULL DEFAULT 'off',
  asr_engine TEXT,
  lang TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  failure TEXT,
  sample_rate INTEGER NOT NULL DEFAULT 16000,
  bits_per_sample INTEGER NOT NULL DEFAULT 16,
  audio_ms INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  name_auto INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS audio_segments (
  session_id TEXT NOT NULL REFERENCES capture_sessions(id),
  seq INTEGER NOT NULL,
  start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
  path TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE IF NOT EXISTS gaps (
  session_id TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, cause TEXT NOT NULL,
  PRIMARY KEY (session_id, start_ms, cause)
);
CREATE TABLE IF NOT EXISTS media_marks (
  session_id TEXT NOT NULL, at_ms INTEGER NOT NULL, media_ms INTEGER, paused INTEGER NOT NULL,
  live INTEGER NOT NULL, rate REAL NOT NULL DEFAULT 1, video_key TEXT,
  PRIMARY KEY (session_id, at_ms)
);
CREATE TABLE IF NOT EXISTS markers (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, at_ms INTEGER NOT NULL, label TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transcript_events (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, media_start_ms INTEGER,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('partial','final','corrected','retracted')),
  supersedes TEXT,
  text TEXT NOT NULL, lang TEXT, engine TEXT NOT NULL,
  pass TEXT NOT NULL DEFAULT 'live'
);
CREATE INDEX IF NOT EXISTS te_session_time ON transcript_events(session_id, start_ms);
CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(text, event_id UNINDEXED, session_id UNINDEXED, tokenize='trigram');
CREATE TABLE IF NOT EXISTS insight_events (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, insight_key TEXT NOT NULL, revision INTEGER NOT NULL,
  kind TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('tentative','confirmed','retracted')),
  text TEXT NOT NULL, evidence TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ie_session ON insight_events(session_id, insight_key, revision);
CREATE TABLE IF NOT EXISTS reports (
  session_id TEXT PRIMARY KEY, body TEXT NOT NULL, sections TEXT NOT NULL, is_final INTEGER NOT NULL,
  model TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS asr_failures (
  session_id TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, pass TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1, last_error TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, start_ms, pass)
);
CREATE TABLE IF NOT EXISTS usage_ledger (
  id TEXT PRIMARY KEY, session_id TEXT, provider TEXT NOT NULL, unit TEXT NOT NULL,
  qty REAL NOT NULL, usd REAL NOT NULL, at TEXT NOT NULL
);
"#;

#[derive(Debug, Clone, Serialize)]
pub struct SessionRow {
    pub id: String,
    pub source_id: String,
    pub kind: String,
    pub title: String,
    pub app_bundle_id: Option<String>,
    pub capture_source_id: Option<String>,
    pub url: Option<String>,
    pub video_key: Option<String>,
    pub group_id: Option<String>,
    pub track_role: Option<String>,
    pub status: String,
    pub summary_mode: String,
    pub lang: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub failure: Option<String>,
    pub audio_ms: i64,
    pub sample_rate: u32,
    pub bits_per_sample: u16,
    /// The recording's own name: typed by the user, or written by the model (`name_auto`) after
    /// the summary. `None` means the UI shows the source's title.
    pub name: Option<String>,
    pub name_auto: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub session_id: String,
    pub session_title: String,
    pub event_id: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub session_id: String,
    pub body: String,
    pub sections: serde_json::Value,
    pub is_final: bool,
    pub model: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Gap {
    pub start_ms: i64,
    pub end_ms: i64,
    pub cause: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Marker {
    pub id: String,
    pub at_ms: i64,
    pub label: Option<String>,
}

/// A speech range whose transcription failed; retried until it succeeds.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AsrFailure {
    pub session_id: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub pass: String,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub created_at: String,
}

pub struct NewSource<'a> {
    pub kind: &'a str,
    pub title: &'a str,
    pub app_bundle_id: Option<&'a str>,
    pub capture_source_id: Option<&'a str>,
    pub url: Option<&'a str>,
    pub video_key: Option<&'a str>,
}

/// (seq, start_ms, end_ms, path, bytes, sha256)
pub type SegmentRow = (i64, i64, i64, String, i64, String);

pub struct Store {
    conn: Mutex<Connection>,
}

fn session_from_row(r: &rusqlite::Row) -> rusqlite::Result<SessionRow> {
    Ok(SessionRow {
        id: r.get("id")?,
        source_id: r.get("source_id")?,
        kind: r.get("kind")?,
        title: r.get("title")?,
        app_bundle_id: r.get("app_bundle_id")?,
        capture_source_id: r.get("capture_source_id")?,
        url: r.get("canonical_url")?,
        video_key: r.get("video_key")?,
        group_id: r.get("group_id")?,
        track_role: r.get("track_role")?,
        status: r.get("status")?,
        summary_mode: r.get("summary_mode")?,
        lang: r.get("lang")?,
        started_at: r.get("started_at")?,
        ended_at: r.get("ended_at")?,
        failure: r.get("failure")?,
        audio_ms: r.get("audio_ms")?,
        sample_rate: r.get("sample_rate")?,
        bits_per_sample: r.get("bits_per_sample")?,
        name: r.get("name")?,
        name_auto: r.get("name_auto")?,
    })
}

const SESSION_SELECT: &str = "SELECT s.*, src.kind, src.title, src.app_bundle_id, src.capture_source_id, src.canonical_url, src.video_key \
     FROM capture_sessions s JOIN sources src ON src.id = s.source_id";

fn event_from_row(r: &rusqlite::Row) -> rusqlite::Result<TranscriptEvent> {
    Ok(TranscriptEvent {
        id: r.get("id")?,
        session_id: r.get("session_id")?,
        start_ms: r.get("start_ms")?,
        end_ms: r.get("end_ms")?,
        media_start_ms: r.get("media_start_ms")?,
        revision: r.get("revision")?,
        state: r.get("state")?,
        supersedes: r.get("supersedes")?,
        text: r.get("text")?,
        lang: r.get("lang")?,
        engine: r.get("engine")?,
    })
}

fn insight_from_row(r: &rusqlite::Row) -> rusqlite::Result<Insight> {
    let evidence: String = r.get("evidence")?;
    Ok(Insight {
        id: r.get("id")?,
        session_id: r.get("session_id")?,
        key: r.get("insight_key")?,
        revision: r.get("revision")?,
        kind: r.get("kind")?,
        state: r.get("state")?,
        text: r.get("text")?,
        evidence: serde_json::from_str::<Vec<Evidence>>(&evidence).unwrap_or_default(),
        created_at: r.get("created_at")?,
    })
}

impl Store {
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.execute_batch(SCHEMA)?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let has_column = |table, column| tx.query_row("SELECT EXISTS (SELECT 1 FROM pragma_table_info(?1) WHERE name=?2)", [table, column], |row| row.get::<_, bool>(0));
        if !has_column("sources", "capture_source_id")? {
            tx.execute("ALTER TABLE sources ADD COLUMN capture_source_id TEXT", [])?;
            if has_column("sources", "capture_app_id")? {
                tx.execute("UPDATE sources SET capture_source_id=capture_app_id WHERE capture_app_id IS NOT NULL", [])?;
            }
        }
        if !has_column("capture_sessions", "sample_rate")? {
            tx.execute("ALTER TABLE capture_sessions ADD COLUMN sample_rate INTEGER NOT NULL DEFAULT 16000", [])?;
        }
        if !has_column("capture_sessions", "bits_per_sample")? {
            tx.execute("ALTER TABLE capture_sessions ADD COLUMN bits_per_sample INTEGER NOT NULL DEFAULT 16", [])?;
        }
        if !has_column("capture_sessions", "name")? {
            tx.execute("ALTER TABLE capture_sessions ADD COLUMN name TEXT", [])?;
            tx.execute("ALTER TABLE capture_sessions ADD COLUMN name_auto INTEGER NOT NULL DEFAULT 0", [])?;
        }
        tx.commit()?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn open_memory() -> anyhow::Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    fn db(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Sessions left "capturing" by a crash or quit become stopped(app_restart). Returns their ids.
    pub fn recover_on_start(&self) -> anyhow::Result<Vec<String>> {
        let db = self.db();
        let ids: Vec<String> = db
            .prepare("SELECT id FROM capture_sessions WHERE status IN ('starting','waiting','capturing','paused','reconnecting','stopping','processing')")?
            .query_map([], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        db.execute(
            "UPDATE capture_sessions SET status='stopped', failure=coalesce(failure,'app_restart'), ended_at=coalesce(ended_at,?1) \
             WHERE status IN ('starting','waiting','capturing','paused','reconnecting','stopping','processing')",
            params![now_iso()],
        )?;
        Ok(ids)
    }

    pub fn create_source(&self, s: &NewSource) -> anyhow::Result<String> {
        let id = mc_core::new_id();
        self.db().execute(
            "INSERT INTO sources(id,kind,title,app_bundle_id,capture_source_id,canonical_url,video_key,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![id, s.kind, s.title, s.app_bundle_id, s.capture_source_id, s.url, s.video_key, now_iso()],
        )?;
        Ok(id)
    }

    pub fn create_session(&self, source_id: &str, summary_mode: &str, group_id: Option<&str>, track_role: Option<&str>) -> anyhow::Result<String> {
        self.create_session_with_format(source_id, summary_mode, group_id, track_role, mc_core::RecordingFormat::default())
    }

    pub fn create_session_with_format(&self, source_id: &str, summary_mode: &str, group_id: Option<&str>, track_role: Option<&str>, format: mc_core::RecordingFormat) -> anyhow::Result<String> {
        let id = mc_core::new_id();
        self.db().execute(
            "INSERT INTO capture_sessions(id,source_id,group_id,track_role,status,summary_mode,started_at,sample_rate,bits_per_sample) VALUES (?1,?2,?3,?4,'starting',?5,?6,?7,?8)",
            params![id, source_id, group_id, track_role, summary_mode, now_iso(), format.sample_rate, format.bits_per_sample],
        )?;
        Ok(id)
    }

    pub fn create_group(&self, title: &str) -> anyhow::Result<String> {
        let id = mc_core::new_id();
        self.db().execute("INSERT INTO session_groups(id,title,created_at) VALUES (?1,?2,?3)", params![id, title, now_iso()])?;
        Ok(id)
    }

    pub fn set_status(&self, id: &str, status: &str, failure: Option<&str>) -> anyhow::Result<()> {
        let ended = matches!(status, "stopped" | "failed").then(now_iso);
        self.db().execute(
            "UPDATE capture_sessions SET status=?2, failure=coalesce(?3, failure), ended_at=coalesce(ended_at, ?4) WHERE id=?1",
            params![id, status, failure, ended],
        )?;
        Ok(())
    }

    pub fn set_summary_mode(&self, id: &str, mode: &str) -> anyhow::Result<()> {
        self.db().execute("UPDATE capture_sessions SET summary_mode=?2 WHERE id=?1", params![id, mode])?;
        Ok(())
    }

    pub fn set_lang(&self, id: &str, lang: Option<&str>) -> anyhow::Result<()> {
        self.db().execute("UPDATE capture_sessions SET lang=?2 WHERE id=?1", params![id, lang])?;
        Ok(())
    }

    pub fn set_title(&self, session_id: &str, title: &str) -> anyhow::Result<()> {
        self.db().execute(
            "UPDATE sources SET title=?2 WHERE id=(SELECT source_id FROM capture_sessions WHERE id=?1)",
            params![session_id, title],
        )?;
        Ok(())
    }

    /// The user's name for a recording; `None` (or blank) goes back to the source's title.
    pub fn set_name(&self, session_id: &str, name: Option<&str>) -> anyhow::Result<()> {
        let name = name.map(str::trim).filter(|n| !n.is_empty());
        self.db().execute("UPDATE capture_sessions SET name=?2, name_auto=0 WHERE id=?1", params![session_id, name])?;
        Ok(())
    }

    /// A model-written name; never replaces one the user typed. Returns whether it was applied.
    pub fn set_auto_name(&self, session_id: &str, name: &str) -> anyhow::Result<bool> {
        let name = name.trim();
        if name.is_empty() {
            return Ok(false);
        }
        let n = self.db().execute(
            "UPDATE capture_sessions SET name=?2, name_auto=1 WHERE id=?1 AND (name IS NULL OR name_auto=1)",
            params![session_id, name],
        )?;
        Ok(n > 0)
    }

    pub fn set_video(&self, session_id: &str, url: Option<&str>, video_key: Option<&str>) -> anyhow::Result<()> {
        self.db().execute(
            "UPDATE sources SET canonical_url=coalesce(?2, canonical_url), video_key=coalesce(?3, video_key) \
             WHERE id=(SELECT source_id FROM capture_sessions WHERE id=?1)",
            params![session_id, url, video_key],
        )?;
        Ok(())
    }

    pub fn set_audio_ms(&self, id: &str, ms: i64) -> anyhow::Result<()> {
        self.db().execute("UPDATE capture_sessions SET audio_ms=max(audio_ms, ?2) WHERE id=?1", params![id, ms])?;
        Ok(())
    }

    pub fn session(&self, id: &str) -> anyhow::Result<Option<SessionRow>> {
        let db = self.db();
        let sql = format!("{SESSION_SELECT} WHERE s.id=?1");
        Ok(db.query_row(&sql, params![id], session_from_row).optional()?)
    }

    pub fn sessions(&self, active_only: bool, limit: i64) -> anyhow::Result<Vec<SessionRow>> {
        let db = self.db();
        let filter = if active_only { "WHERE s.status IN ('starting','waiting','capturing','paused','reconnecting','stopping')" } else { "" };
        let sql = format!("{SESSION_SELECT} {filter} ORDER BY s.started_at DESC LIMIT ?1");
        let rows = db.prepare(&sql)?.query_map(params![limit], session_from_row)?.collect::<Result<_, _>>()?;
        Ok(rows)
    }

    pub fn add_segment(&self, session_id: &str, seq: i64, start_ms: i64, end_ms: i64, path: &str, bytes: i64, sha256: &str) -> anyhow::Result<()> {
        let db = self.db();
        db.execute(
            "INSERT OR REPLACE INTO audio_segments(session_id,seq,start_ms,end_ms,path,bytes,sha256) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![session_id, seq, start_ms, end_ms, path, bytes, sha256],
        )?;
        db.execute("UPDATE capture_sessions SET audio_ms=max(audio_ms, ?2) WHERE id=?1", params![session_id, end_ms])?;
        Ok(())
    }

    /// (seq, start_ms, end_ms, path, bytes, sha256) ordered by seq.
    pub fn segments(&self, session_id: &str) -> anyhow::Result<Vec<SegmentRow>> {
        let db = self.db();
        let rows = db
            .prepare("SELECT seq,start_ms,end_ms,path,bytes,sha256 FROM audio_segments WHERE session_id=?1 ORDER BY seq")?
            .query_map(params![session_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    pub fn add_gap(&self, session_id: &str, start_ms: i64, end_ms: i64, cause: &str) -> anyhow::Result<()> {
        self.db().execute(
            "INSERT OR IGNORE INTO gaps(session_id,start_ms,end_ms,cause) VALUES (?1,?2,?3,?4)",
            params![session_id, start_ms, end_ms, cause],
        )?;
        Ok(())
    }

    pub fn gaps(&self, session_id: &str) -> anyhow::Result<Vec<Gap>> {
        let db = self.db();
        let rows = db
            .prepare("SELECT start_ms,end_ms,cause FROM gaps WHERE session_id=?1 ORDER BY start_ms")?
            .query_map(params![session_id], |r| Ok(Gap { start_ms: r.get(0)?, end_ms: r.get(1)?, cause: r.get(2)? }))?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    pub fn add_media_mark(&self, session_id: &str, at_ms: i64, media_ms: Option<i64>, paused: bool, live: bool, rate: f64, video_key: Option<&str>) -> anyhow::Result<()> {
        self.db().execute(
            "INSERT OR REPLACE INTO media_marks(session_id,at_ms,media_ms,paused,live,rate,video_key) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![session_id, at_ms, media_ms, paused, live, rate, video_key],
        )?;
        Ok(())
    }

    /// Video time at session time `at_ms`, interpolated from the closest earlier mark.
    pub fn media_time_at(&self, session_id: &str, at_ms: i64) -> anyhow::Result<Option<i64>> {
        let db = self.db();
        let row: Option<(i64, Option<i64>, bool, f64)> = db
            .query_row(
                "SELECT at_ms, media_ms, paused, rate FROM media_marks WHERE session_id=?1 AND at_ms<=?2 ORDER BY at_ms DESC LIMIT 1",
                params![session_id, at_ms],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        Ok(row.and_then(|(mark_at, media, paused, rate)| {
            media.map(|m| if paused { m } else { m + ((at_ms - mark_at) as f64 * rate) as i64 })
        }))
    }

    pub fn add_marker(&self, session_id: &str, at_ms: i64, label: Option<&str>) -> anyhow::Result<String> {
        let id = mc_core::new_id();
        self.db().execute(
            "INSERT INTO markers(id,session_id,at_ms,label,created_at) VALUES (?1,?2,?3,?4,?5)",
            params![id, session_id, at_ms, label, now_iso()],
        )?;
        Ok(id)
    }

    pub fn markers(&self, session_id: &str) -> anyhow::Result<Vec<Marker>> {
        let db = self.db();
        let rows = db
            .prepare("SELECT id,at_ms,label FROM markers WHERE session_id=?1 ORDER BY at_ms")?
            .query_map(params![session_id], |r| Ok(Marker { id: r.get(0)?, at_ms: r.get(1)?, label: r.get(2)? }))?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    /// Inserts a transcript event. `corrected`/`retracted` events replace the live events they overlap.
    pub fn insert_transcript(&self, e: &TranscriptEvent, pass: &str) -> anyhow::Result<()> {
        let mut db = self.db();
        let tx = db.transaction()?;
        tx.execute(
            "INSERT INTO transcript_events(id,session_id,start_ms,end_ms,media_start_ms,revision,state,supersedes,text,lang,engine,pass) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![e.id, e.session_id, e.start_ms, e.end_ms, e.media_start_ms, e.revision, e.state, e.supersedes, e.text, e.lang, e.engine, pass],
        )?;
        if e.state == "final" || e.state == "corrected" {
            tx.execute("INSERT INTO transcript_fts(text,event_id,session_id) VALUES (?1,?2,?3)", params![e.text, e.id, e.session_id])?;
        }
        if let Some(old) = &e.supersedes {
            tx.execute("DELETE FROM transcript_fts WHERE event_id=?1", params![old])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Marks live events in [start, end) as superseded (after-mode correction) and returns their ids.
    pub fn supersede_range(&self, session_id: &str, start_ms: i64, end_ms: i64) -> anyhow::Result<Vec<String>> {
        let mut db = self.db();
        let tx = db.transaction()?;
        let ids: Vec<String> = tx
            .prepare(
                "SELECT id FROM transcript_events WHERE session_id=?1 AND state IN ('final','partial') AND pass!='after' \
                 AND start_ms < ?3 AND end_ms > ?2 AND id NOT IN (SELECT supersedes FROM transcript_events WHERE supersedes IS NOT NULL)",
            )?
            .query_map(params![session_id, start_ms, end_ms], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        for id in &ids {
            tx.execute("DELETE FROM transcript_fts WHERE event_id=?1", params![id])?;
        }
        tx.commit()?;
        Ok(ids)
    }

    /// Current transcript of a session: final/corrected events not superseded, ordered by time.
    pub fn transcript(&self, session_id: &str) -> anyhow::Result<Vec<TranscriptEvent>> {
        let db = self.db();
        let rows = db
            .prepare(
                "SELECT * FROM transcript_events t WHERE session_id=?1 AND state IN ('final','corrected') \
                 AND NOT EXISTS (SELECT 1 FROM transcript_events n WHERE n.session_id=t.session_id AND n.supersedes=t.id) \
                 ORDER BY start_ms, revision",
            )?
            .query_map(params![session_id], event_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        // Live events replaced by an after-mode pass over the same range are hidden too.
        let after: Vec<(i64, i64)> = rows.iter().filter(|e| e.state == "corrected").map(|e| (e.start_ms, e.end_ms)).collect();
        if after.is_empty() {
            return Ok(rows);
        }
        let covered_until = after.iter().map(|a| a.1).max().unwrap_or(0);
        Ok(rows.into_iter().filter(|e| e.state == "corrected" || e.start_ms >= covered_until).collect())
    }

    pub fn events_by_ids(&self, session_id: &str, ids: &[String]) -> anyhow::Result<Vec<TranscriptEvent>> {
        let all = self.transcript(session_id)?;
        Ok(all.into_iter().filter(|e| ids.contains(&e.id)).collect())
    }

    pub fn latest_insights(&self, session_id: &str, include_retracted: bool) -> anyhow::Result<Vec<Insight>> {
        let db = self.db();
        let rows = db
            .prepare(
                "SELECT * FROM insight_events i WHERE session_id=?1 AND revision = \
                 (SELECT max(revision) FROM insight_events j WHERE j.session_id=i.session_id AND j.insight_key=i.insight_key) \
                 ORDER BY created_at",
            )?
            .query_map(params![session_id], insight_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows.into_iter().filter(|i| include_retracted || i.state != "retracted").collect())
    }

    pub fn insert_insight(&self, i: &Insight) -> anyhow::Result<()> {
        self.db().execute(
            "INSERT INTO insight_events(id,session_id,insight_key,revision,kind,state,text,evidence,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![i.id, i.session_id, i.key, i.revision, i.kind, i.state, i.text, serde_json::to_string(&i.evidence)?, i.created_at],
        )?;
        Ok(())
    }

    pub fn upsert_report(&self, session_id: &str, body: &str, sections: &serde_json::Value, is_final: bool, model: Option<&str>) -> anyhow::Result<()> {
        self.db().execute(
            "INSERT INTO reports(session_id,body,sections,is_final,model,created_at) VALUES (?1,?2,?3,?4,?5,?6) \
             ON CONFLICT(session_id) DO UPDATE SET body=excluded.body, sections=excluded.sections, is_final=excluded.is_final, model=excluded.model, created_at=excluded.created_at",
            params![session_id, body, serde_json::to_string(sections)?, is_final, model, now_iso()],
        )?;
        Ok(())
    }

    pub fn report(&self, session_id: &str) -> anyhow::Result<Option<Report>> {
        let db = self.db();
        Ok(db
            .query_row("SELECT * FROM reports WHERE session_id=?1", params![session_id], |r| {
                let sections: String = r.get("sections")?;
                Ok(Report {
                    session_id: r.get("session_id")?,
                    body: r.get("body")?,
                    sections: serde_json::from_str(&sections).unwrap_or(serde_json::Value::Null),
                    is_final: r.get("is_final")?,
                    model: r.get("model")?,
                    created_at: r.get("created_at")?,
                })
            })
            .optional()?)
    }

    /// Full-text search; each hit carries its own session (no cross-session synthesis).
    pub fn search(&self, q: &str, session_id: Option<&str>, limit: i64) -> anyhow::Result<Vec<SearchHit>> {
        let db = self.db();
        let q = q.trim();
        if q.is_empty() {
            return Ok(vec![]);
        }
        let map = |r: &rusqlite::Row| {
            Ok(SearchHit {
                session_id: r.get(0)?,
                session_title: r.get(1)?,
                event_id: r.get(2)?,
                start_ms: r.get(3)?,
                end_ms: r.get(4)?,
                text: r.get(5)?,
            })
        };
        let base = "SELECT t.session_id, src.title, t.id, t.start_ms, t.end_ms, t.text FROM transcript_events t \
                    JOIN capture_sessions s ON s.id=t.session_id JOIN sources src ON src.id=s.source_id";
        let rows = if q.chars().count() >= 3 {
            let phrase = format!("\"{}\"", q.replace('"', "\"\""));
            let sql = format!(
                "{base} WHERE t.id IN (SELECT event_id FROM transcript_fts WHERE transcript_fts MATCH ?1) AND (?2 IS NULL OR t.session_id=?2) ORDER BY t.session_id, t.start_ms LIMIT ?3"
            );
            db.prepare(&sql)?.query_map(params![phrase, session_id, limit], map)?.collect::<Result<_, _>>()?
        } else {
            let sql = format!(
                "{base} WHERE t.state IN ('final','corrected') AND t.text LIKE ?1 AND (?2 IS NULL OR t.session_id=?2) ORDER BY t.session_id, t.start_ms LIMIT ?3"
            );
            db.prepare(&sql)?.query_map(params![format!("%{q}%"), session_id, limit], map)?.collect::<Result<_, _>>()?
        };
        Ok(rows)
    }

    /// Records a failed range, or bumps its attempt count and error if it is already known.
    pub fn add_asr_failure(&self, session_id: &str, start_ms: i64, end_ms: i64, pass: &str, error: &str) -> anyhow::Result<()> {
        let err: String = error.chars().take(300).collect();
        self.db().execute(
            "INSERT INTO asr_failures(session_id,start_ms,end_ms,pass,attempts,last_error,created_at) VALUES (?1,?2,?3,?4,1,?5,?6) \
             ON CONFLICT(session_id,start_ms,pass) DO UPDATE SET attempts=attempts+1, last_error=excluded.last_error, end_ms=max(end_ms, excluded.end_ms)",
            params![session_id, start_ms, end_ms, pass, err, now_iso()],
        )?;
        Ok(())
    }

    /// Failed ranges, oldest first; all sessions when `session_id` is None.
    pub fn asr_failures(&self, session_id: Option<&str>) -> anyhow::Result<Vec<AsrFailure>> {
        let db = self.db();
        let rows = db
            .prepare("SELECT session_id,start_ms,end_ms,pass,attempts,last_error,created_at FROM asr_failures WHERE (?1 IS NULL OR session_id=?1) ORDER BY created_at, start_ms")?
            .query_map(params![session_id], |r| {
                Ok(AsrFailure {
                    session_id: r.get(0)?,
                    start_ms: r.get(1)?,
                    end_ms: r.get(2)?,
                    pass: r.get(3)?,
                    attempts: r.get(4)?,
                    last_error: r.get(5)?,
                    created_at: r.get(6)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    pub fn delete_asr_failure(&self, session_id: &str, start_ms: i64, pass: &str) -> anyhow::Result<()> {
        self.db().execute("DELETE FROM asr_failures WHERE session_id=?1 AND start_ms=?2 AND pass=?3", params![session_id, start_ms, pass])?;
        Ok(())
    }

    /// (failed chunks, failed milliseconds) per session, for sessions that have failures.
    pub fn asr_failure_summary(&self) -> anyhow::Result<std::collections::HashMap<String, (i64, i64)>> {
        let db = self.db();
        let rows = db
            .prepare("SELECT session_id, count(*), coalesce(sum(end_ms-start_ms),0) FROM asr_failures GROUP BY session_id")?
            .query_map([], |r| Ok((r.get::<_, String>(0)?, (r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))))?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    pub fn add_usage(&self, session_id: Option<&str>, provider: &str, unit: &str, qty: f64, usd: f64) -> anyhow::Result<()> {
        self.db().execute(
            "INSERT INTO usage_ledger(id,session_id,provider,unit,qty,usd,at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![mc_core::new_id(), session_id, provider, unit, qty, usd, now_iso()],
        )?;
        Ok(())
    }

    pub fn spent_today(&self) -> anyhow::Result<f64> {
        let today = &now_iso()[..10];
        Ok(self.db().query_row(
            "SELECT coalesce(sum(usd),0) FROM usage_ledger WHERE substr(at,1,10)=?1",
            params![today],
            |r| r.get(0),
        )?)
    }

    /// Removes a session's text (transcript, key points, report, pending retries) so it can be
    /// transcribed again from its audio.
    pub fn clear_transcript(&self, session_id: &str) -> anyhow::Result<()> {
        let mut db = self.db();
        let tx = db.transaction()?;
        for table in ["transcript_events", "insight_events", "reports", "asr_failures"] {
            tx.execute(&format!("DELETE FROM {table} WHERE session_id=?1"), params![session_id])?;
        }
        tx.execute("DELETE FROM transcript_fts WHERE session_id=?1", params![session_id])?;
        tx.commit()?;
        Ok(())
    }

    /// Removes every row of a session (audio files are removed by the caller).
    pub fn delete_session(&self, session_id: &str) -> anyhow::Result<()> {
        let mut db = self.db();
        let tx = db.transaction()?;
        for table in ["audio_segments", "gaps", "media_marks", "markers", "transcript_events", "insight_events", "reports", "asr_failures"] {
            tx.execute(&format!("DELETE FROM {table} WHERE session_id=?1"), params![session_id])?;
        }
        tx.execute("DELETE FROM transcript_fts WHERE session_id=?1", params![session_id])?;
        tx.execute("UPDATE usage_ledger SET session_id=NULL WHERE session_id=?1", params![session_id])?;
        tx.execute("DELETE FROM capture_sessions WHERE id=?1", params![session_id])?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(session: &str, start: i64, text: &str, state: &str, supersedes: Option<String>) -> TranscriptEvent {
        TranscriptEvent {
            id: mc_core::new_id(),
            session_id: session.into(),
            start_ms: start,
            end_ms: start + 1000,
            media_start_ms: None,
            revision: 1,
            state: state.into(),
            supersedes,
            text: text.into(),
            lang: Some("en".into()),
            engine: "fake".into(),
        }
    }

    fn session(store: &Store, title: &str) -> String {
        let src = store
            .create_source(&NewSource { kind: "chromium_tab", title, app_bundle_id: None, capture_source_id: None, url: None, video_key: None })
            .unwrap();
        store.create_session(&src, "live", None, None).unwrap()
    }

    #[test]
    fn model_names_never_replace_user_names() {
        let store = Store::open_memory().unwrap();
        let id = session(&store, "Tab");
        assert!(store.set_auto_name(&id, "Weekly sync").unwrap());
        assert!(store.set_auto_name(&id, "Weekly sync, take two").unwrap());
        store.set_name(&id, Some("  My call ")).unwrap();
        assert!(!store.set_auto_name(&id, "Other").unwrap());
        let row = store.session(&id).unwrap().unwrap();
        assert_eq!((row.name.as_deref(), row.name_auto), (Some("My call"), false));
        store.set_name(&id, Some(" ")).unwrap();
        assert_eq!(store.session(&id).unwrap().unwrap().name, None);
    }

    #[test]
    fn transcripts_and_search_stay_per_session() {
        let store = Store::open_memory().unwrap();
        let a = session(&store, "A");
        let b = session(&store, "B");
        store.insert_transcript(&ev(&a, 0, "the falcon budget", "final", None), "live").unwrap();
        store.insert_transcript(&ev(&b, 0, "zebra protocol launch", "final", None), "live").unwrap();
        assert_eq!(store.transcript(&a).unwrap().len(), 1);
        assert!(store.transcript(&a).unwrap()[0].text.contains("falcon"));
        let hits = store.search("zebra", None, 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].session_id, b);
        assert_eq!(hits[0].session_title, "B");
        assert!(store.search("falcon", Some(&b), 10).unwrap().is_empty());
    }

    #[test]
    fn corrected_events_replace_live_ones() {
        let store = Store::open_memory().unwrap();
        let a = session(&store, "A");
        let live = ev(&a, 0, "the falcon budgie", "final", None);
        store.insert_transcript(&live, "live").unwrap();
        let old = store.supersede_range(&a, 0, 2000).unwrap();
        assert_eq!(old, vec![live.id.clone()]);
        store.insert_transcript(&ev(&a, 0, "the falcon budget", "corrected", Some(live.id.clone())), "after").unwrap();
        let t = store.transcript(&a).unwrap();
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].text, "the falcon budget");
        assert!(store.search("budgie", None, 10).unwrap().is_empty());
    }

    #[test]
    fn insight_revisions_and_recovery() {
        let store = Store::open_memory().unwrap();
        let a = session(&store, "A");
        let mut i = Insight {
            id: mc_core::new_id(),
            session_id: a.clone(),
            key: "k1".into(),
            revision: 1,
            kind: "key_point".into(),
            state: "tentative".into(),
            text: "x".into(),
            evidence: vec![],
            created_at: now_iso(),
        };
        store.insert_insight(&i).unwrap();
        i.id = mc_core::new_id();
        i.revision = 2;
        i.state = "retracted".into();
        store.insert_insight(&i).unwrap();
        assert!(store.latest_insights(&a, false).unwrap().is_empty());
        assert_eq!(store.latest_insights(&a, true).unwrap().len(), 1);
        store.set_status(&a, "capturing", None).unwrap();
        assert_eq!(store.recover_on_start().unwrap(), vec![a.clone()]);
        assert_eq!(store.session(&a).unwrap().unwrap().failure.as_deref(), Some("app_restart"));
    }

    #[test]
    fn asr_failures_upsert_and_summarise() {
        let store = Store::open_memory().unwrap();
        let a = session(&store, "A");
        store.add_asr_failure(&a, 0, 4000, "live", "down").unwrap();
        store.add_asr_failure(&a, 0, 4000, "live", "still down").unwrap();
        store.add_asr_failure(&a, 5000, 7000, "live", "down").unwrap();
        let f = store.asr_failures(Some(&a)).unwrap();
        assert_eq!(f.len(), 2);
        assert_eq!(f[0].attempts, 2);
        assert_eq!(f[0].last_error.as_deref(), Some("still down"));
        assert_eq!(store.asr_failure_summary().unwrap()[&a], (2, 6000));
        store.delete_asr_failure(&a, 0, "live").unwrap();
        assert_eq!(store.asr_failures(None).unwrap().len(), 1);
    }

    #[test]
    fn media_time_interpolates() {
        let store = Store::open_memory().unwrap();
        let a = session(&store, "A");
        store.add_media_mark(&a, 1000, Some(60_000), false, false, 1.0, None).unwrap();
        assert_eq!(store.media_time_at(&a, 3000).unwrap(), Some(62_000));
        assert_eq!(store.media_time_at(&a, 500).unwrap(), None);
    }
}
