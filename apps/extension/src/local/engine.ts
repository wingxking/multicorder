// In-browser engine (design 5.11), running in the offscreen document. One pipeline per tab:
// MediaRecorder → OPFS recording (always — transcription problems never touch it);
// 16 kHz PCM → Chunker → FairQueue → transcription service → IndexedDB → key points → report.
// Failed parts are kept in the "pending" store and filled in when the service is back
// (automatic every 30 s, or on "Retry").

import { Chunker, chunkAll, msToSamples, samplesToMs, SAMPLE_RATE, SpeechChunk } from "./chunker";
import * as db from "./db";
import { applyOps, fmtTs, Insight, langName, newId, renderReport, reducerInput, reducerSystem, reportInput, reportSystem, Seg } from "./insight";
import { chatJson, ServiceError, Target, targetLabel, transcribe } from "./providers";
import { FairQueue, Pass } from "./queue";
import type { Settings, SummaryMode } from "./settings";
import { AUDIO_START_DB } from "../protocol";
import { CAPTION_COVERAGE, CaptionMsg, CaptionSource, captionEngineId, Coverage } from "../captions/core";

export type LocalEvent =
  | { type: "status"; session_id: string; status: string; detail?: string | null }
  | { type: "level"; session_id: string; rms_db: number; silent: boolean }
  | { type: "transcript"; session_id: string; event: any }
  | { type: "insight"; session_id: string; insight: Insight }
  | { type: "report"; session_id: string; is_final: boolean }
  | { type: "backlog"; session_id: string; pending_chunks: number }
  | { type: "asr"; session_id: string; asr: NonNullable<db.LocalSession["asr"]> }
  | { type: "text_source"; session_id: string; source: CaptionSource | null; active: boolean };

export type Resolver = () => Promise<{ target: Target; settings: Settings }>;

function emit(e: LocalEvent) {
  chrome.runtime.sendMessage({ type: "local-event", event: { ...e, backend: "local" } }).catch(() => {});
}

const toSeg = (s: Seg) => ({ id: s.id, session_id: s.sessionId, start_ms: s.startMs, end_ms: s.endMs, state: s.state, text: s.text, engine: s.engine });
const short = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 160);

class Archive {
  pause() {
    if (this.recorder.state === "recording") this.recorder.pause();
  }

  resume() {
    if (this.recorder.state === "paused") this.recorder.resume();
  }

  private writer: Promise<FileSystemWritableFileStream>;
  private chain: Promise<unknown> = Promise.resolve();
  private recorder: MediaRecorder;
  private stopped: Promise<void>;

  constructor(private id: string, stream: MediaStream) {
    this.writer = (async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("rec", { create: true });
      const fh = await dir.getFileHandle(`${id}.webm`, { create: true });
      return fh.createWritable({ keepExistingData: false });
    })();
    this.recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 32000 });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size) this.chain = this.chain.then(async () => (await this.writer).write(e.data));
    };
    this.stopped = new Promise((res) => (this.recorder.onstop = () => res()));
    this.recorder.start(2000);
  }

  /** Commits everything recorded so far (readable file) and keeps recording. */
  async flush(): Promise<File | null> {
    if (this.recorder.state === "inactive") return db.recordingFile(this.id);
    this.recorder.requestData();
    await new Promise((r) => setTimeout(r, 200));
    const next = this.chain.then(async () => {
      const w = await this.writer;
      await w.close();
      const root = await navigator.storage.getDirectory();
      const fh = await (await root.getDirectoryHandle("rec")).getFileHandle(`${this.id}.webm`);
      const file = await fh.getFile();
      this.writer = fh.createWritable({ keepExistingData: true }).then(async (nw) => {
        await nw.seek(file.size);
        return nw;
      });
      return file;
    });
    this.chain = next;
    return next;
  }

  async stop(): Promise<void> {
    if (this.recorder.state !== "inactive") this.recorder.stop();
    await this.stopped;
    await this.chain;
    await (await this.writer).close();
  }
}

export async function decodeTo16k(file: Blob): Promise<Float32Array> {
  const bytes = await file.arrayBuffer();
  if (!bytes.byteLength) return new Float32Array();
  const ctx = new AudioContext();
  try {
    const buf = await ctx.decodeAudioData(bytes);
    const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(buf.duration * SAMPLE_RATE)), SAMPLE_RATE);
    const src = off.createBufferSource();
    src.buffer = buf;
    src.connect(off.destination);
    src.start();
    return (await off.startRendering()).getChannelData(0).slice();
  } finally {
    await ctx.close();
  }
}

class Session {
  chunker: Chunker | null = null;
  total = 0;
  pending = 0;
  idle: (() => void)[] = [];
  insightBuf: Seg[] = [];
  lastReduce = Date.now();
  levelAcc: number[] = [];
  stopping = false;
  paused = false;
  archive: Archive | null;
  started: Promise<void> = Promise.resolve();
  preRoll: Float32Array | null = null;
  /** Wall clock of the last audio frame, to place subtitle lines on the recording's timeline. */
  lastPushWall = 0;
  captionSource: CaptionSource | null = null;
  captionActive = false;
  captionsOnly = false;
  coverage = new Coverage();

  constructor(public row: db.LocalSession, public stream: MediaStream, public settings: Settings) {
    this.archive = row.status === "waiting" ? null : new Archive(row.id, stream);
    if (row.summary_mode === "live") this.chunker = new Chunker(0);
  }
}

export class LocalEngine {
  private sessions = new Map<string, Session>();
  private queue = new FairQueue<void>(3);
  private cached: { at: number; value: { target: Target; settings: Settings } } | null = null;
  private retrying = new Set<string>();

  constructor(private resolver: Resolver) {
    setInterval(() => void this.tick(), 5000);
    setInterval(() => void this.retryAll(), 30000);
    setTimeout(() => void this.retryAll(), 3000);
  }

  private async ctx(): Promise<{ target: Target; settings: Settings }> {
    if (this.cached && Date.now() - this.cached.at < 20000) return this.cached.value;
    const value = await this.resolver();
    this.cached = { at: Date.now(), value };
    return value;
  }

  private invalidate() {
    this.cached = null;
  }

  isLocal(id: string) {
    return this.sessions.has(id);
  }

  async create(meta: { title: string; url?: string; mode?: SummaryMode; waitForAudio?: boolean }, stream: MediaStream, settings: Settings): Promise<string> {
    const id = newId();
    const row: db.LocalSession = {
      id,
      backend: "local",
      kind: "chromium_tab",
      title: meta.title || "Browser tab",
      url: meta.url ?? null,
      video_key: videoKey(meta.url),
      status: meta.waitForAudio ? "waiting" : "capturing",
      summary_mode: meta.mode ?? settings.defaultMode,
      started_at: new Date().toISOString(),
      audio_ms: 0,
      asr_seconds: 0,
      tokens: 0,
      asr: { state: "ok", failed_chunks: 0, failed_ms: 0 },
    };
    await db.putSession(row);
    this.sessions.set(id, new Session(row, stream, settings));
    emit({ type: "status", session_id: id, status: row.status });
    return id;
  }

  /** 100 ms of 16 kHz PCM16 from the worklet. */
  push(id: string, pcm: Int16Array, rmsDb: number) {
    const s = this.sessions.get(id);
    if (!s || s.stopping || s.paused) return;
    const f = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
    if (!s.archive) {
      if (rmsDb < AUDIO_START_DB) {
        s.preRoll = f;
        return;
      }
      s.archive = new Archive(id, s.stream);
      s.row.status = "capturing";
      s.started = db.patchSession(id, { status: "capturing" });
      void s.started.then(() => emit({ type: "status", session_id: id, status: "capturing" }));
      const preroll = s.preRoll ?? new Float32Array(pcm.length);
      s.total += preroll.length;
      s.chunker?.push(preroll);
      s.preRoll = null;
    }
    s.total += f.length;
    s.lastPushWall = Date.now();
    for (const v of f) s.levelAcc.push(v);
    if (s.levelAcc.length >= SAMPLE_RATE) {
      const rms = Math.sqrt(s.levelAcc.reduce((a, v) => a + v * v, 0) / s.levelAcc.length);
      const dbv = rms > 1e-6 ? 20 * Math.log10(rms) : -120;
      emit({ type: "level", session_id: id, rms_db: dbv, silent: dbv < -60 });
      s.levelAcc = [];
      s.row.audio_ms = samplesToMs(s.total);
    }
    if (s.chunker) for (const c of s.chunker.push(f)) this.submit(s.row.id, s, c, "live", false);
  }

  private async segsFor(sessionId: string, chunk: { startMs: number; samples: Float32Array }, correct: boolean): Promise<Seg[]> {
    const { target } = await this.ctx();
    try {
      const out = await transcribe(target, chunk.samples);
      return out.map((x) => ({
        id: newId(),
        sessionId,
        startMs: chunk.startMs + x.startMs,
        endMs: Math.max(chunk.startMs + x.endMs, chunk.startMs + x.startMs + 1),
        text: x.text,
        state: correct ? "corrected" : "final",
        engine: targetLabel(target),
      }));
    } catch (e) {
      this.invalidate();
      throw e;
    }
  }

  private async storeSegs(sessionId: string, segs: Seg[]) {
    for (const seg of segs) {
      await db.putSeg(seg);
      emit({ type: "transcript", session_id: sessionId, event: toSeg(seg) });
    }
  }

  private async refreshAsr(sessionId: string, lastError?: string | null) {
    const p = await db.pending(sessionId);
    const asr = { state: p.length ? "degraded" : "ok", failed_chunks: p.length, failed_ms: p.reduce((a, x) => a + x.endMs - x.startMs, 0) } as const;
    const live = this.sessions.get(sessionId);
    if (live) live.row.asr = asr;
    await db.patchSession(sessionId, { asr, ...(lastError !== undefined ? { last_error: lastError } : {}) });
    emit({ type: "asr", session_id: sessionId, asr });
    return asr;
  }

  /** Platform subtitles from the page: lines become transcript text, playing time skips ASR. */
  caption(id: string, msg: CaptionMsg, policy: "auto" | "captions") {
    const s = this.sessions.get(id);
    if (!s || s.stopping || s.paused || !s.archive) return;
    const nowMs = samplesToMs(s.total);
    if (msg.kind === "state") {
      s.captionsOnly = policy === "captions";
      const active = msg.active && !!msg.source;
      if (active) s.coverage.beat(nowMs);
      if (JSON.stringify(msg.source) !== JSON.stringify(s.captionSource) || active !== s.captionActive) {
        s.captionSource = msg.source;
        s.captionActive = active;
        emit({ type: "text_source", session_id: id, source: msg.source, active });
      }
      return;
    }
    if (s.row.summary_mode === "off") return;
    const start = Math.max(0, Math.min(nowMs + 2000, nowMs - (s.lastPushWall - msg.wall_ms)));
    const seg: Seg = { id: newId(), sessionId: id, startMs: Math.round(start), endMs: Math.round(start + Math.max(1, msg.dur_ms)), text: msg.text, state: "final", engine: captionEngineId(msg.source) };
    void s.started.then(() => this.storeSegs(id, [seg]));
    s.insightBuf.push(seg);
  }

  private coveredByCaptions(s: Session, chunk: SpeechChunk) {
    return (s.captionsOnly && !!s.captionSource) || s.coverage.share(chunk.startMs, chunk.endMs) >= CAPTION_COVERAGE;
  }

  /** Replaces a finished recording's text (platform subtitles) with speech recognition of its audio. */
  async transcribeWithAsr(id: string) {
    if (this.sessions.has(id)) throw new Error("End the recording before transcribing it again");
    await db.clearText(id);
    await db.patchSession(id, { report_pending: false });
    emit({ type: "status", session_id: id, status: "stopped", detail: "transcript_reset" });
    return this.retry(id);
  }

  private submit(sessionId: string, s: Session, chunk: SpeechChunk, pass: Pass, correct: boolean) {
    if (this.coveredByCaptions(s, chunk)) return;
    s.pending++;
    this.queue
      .submit(sessionId, pass, async () => {
        const segs = await this.segsFor(sessionId, chunk, correct);
        await this.storeSegs(sessionId, segs);
        s.row.asr_seconds = (s.row.asr_seconds ?? 0) + (chunk.endMs - chunk.startMs) / 1000;
        if (segs.length) s.insightBuf.push(...segs);
      })
      .catch(async (e) => {
        // Keep the part for later; the recording itself is untouched.
        await db.putPending({ id: newId(), sessionId, startMs: chunk.startMs, endMs: chunk.endMs, pass, correct, attempts: 1, lastError: short(e) });
        await this.refreshAsr(sessionId, short(e));
        emit({ type: "status", session_id: sessionId, status: s.row.status, detail: `asr_unavailable: ${short(e)}` });
      })
      .finally(() => {
        s.pending--;
        if (s.pending === 0) s.idle.splice(0).forEach((f) => f());
      });
    emit({ type: "backlog", session_id: sessionId, pending_chunks: this.queue.pending(sessionId) });
  }

  private waitIdle(s: Session): Promise<void> {
    return s.pending === 0 ? Promise.resolve() : new Promise((r) => s.idle.push(r));
  }

  private async tick() {
    for (const s of this.sessions.values()) {
      const words = s.insightBuf.reduce((a, e) => a + Math.max(e.text.split(/\s+/).length, Math.floor(e.text.length / 2)), 0);
      if (s.insightBuf.length && (words >= 400 || Date.now() - s.lastReduce >= 45000)) {
        s.lastReduce = Date.now();
        const batch = s.insightBuf.splice(0);
        await this.reduce(s.row.id, batch);
      }
    }
  }

  /** Key-point round over new segments; failures are reported, not fatal. */
  private async reduce(sessionId: string, batch: Seg[]) {
    if (!batch.length) return;
    batch.sort((a, b) => a.startMs - b.startMs);
    const all = await db.transcript(sessionId);
    const segMap = new Map(all.map((e) => [e.id, e]));
    for (let i = 0; i < batch.length; i += 40) {
      const part = batch.slice(i, i + 40).filter((e) => segMap.has(e.id));
      if (!part.length) continue;
      try {
        const { target, settings } = await this.ctx();
        const current = await db.insights(sessionId);
        const earlier = all.filter((e) => e.endMs <= part[0].startMs);
        const { out } = await chatJson(target, reducerSystem(settings.outputLang), reducerInput(current, earlier, part), 2000);
        for (const ins of applyOps(sessionId, out, segMap, current).applied) {
          await db.putInsight(ins);
          emit({ type: "insight", session_id: sessionId, insight: ins });
        }
      } catch (e) {
        this.invalidate();
        emit({ type: "status", session_id: sessionId, status: this.sessions.get(sessionId)?.row.status ?? "stopped", detail: `model_error: ${short(e)}` });
        return;
      }
    }
  }

  /** Pauses or resumes a recording: nothing is recorded or transcribed while paused. */
  async setPaused(id: string, paused: boolean) {
    const s = this.sessions.get(id);
    if (!s || s.stopping || s.paused === paused) return;
    s.paused = paused;
    if (paused) s.archive?.pause();
    else s.archive?.resume();
    if (!s.archive) return; // still waiting for audio: nothing recorded yet
    s.row.status = paused ? "paused" : "capturing";
    await s.started;
    await db.patchSession(id, { status: s.row.status });
    emit({ type: "status", session_id: id, status: s.row.status });
  }

  async setMode(id: string, mode: SummaryMode) {
    const s = this.sessions.get(id);
    if (!s || s.row.summary_mode === mode) return;
    const wasLive = s.row.summary_mode === "live";
    s.row.summary_mode = mode;
    await s.started;
    await db.patchSession(id, { summary_mode: mode });
    if (mode === "live") {
      // Everything recorded so far is transcribed at backfill priority, then live from now on.
      const upto = s.total;
      s.chunker = new Chunker(upto);
      const file = await s.archive?.flush();
      if (file) {
        const audio = await decodeTo16k(file).catch(() => new Float32Array());
        for (const c of chunkAll(audio.subarray(0, Math.min(audio.length, upto)), 0)) this.submit(id, s, c, "backfill", false);
      }
    } else if (wasLive && s.chunker) {
      const last = s.chunker.finish();
      s.chunker = null;
      if (last) this.submit(id, s, last, "live", false);
    }
    emit({ type: "status", session_id: id, status: s.row.status, detail: `mode: ${mode}` });
  }

  async stop(id: string, reason: string, drainMs: number, releaseInput: () => void) {
    const s = this.sessions.get(id);
    if (!s || s.stopping) return;
    s.stopping = true;
    s.row.status = "stopping";
    await s.started;
    if (!s.archive) {
      releaseInput();
      if (reason === "cancelled") await db.deleteSession(id).catch(console.error);
      else await db.patchSession(id, { status: "stopped", ended_at: new Date().toISOString(), failure: "no_audio" });
      this.sessions.delete(id);
      emit({ type: "status", session_id: id, status: "stopped", detail: "no_audio" });
      return;
    }
    emit({ type: "status", session_id: id, status: "stopping", detail: reason });
    if (reason === "cancelled") {
      // The user discarded this recording: close the file, then delete it with its text.
      await s.archive.stop().catch(() => {}).finally(releaseInput);
      this.sessions.delete(id);
      await db.deleteSession(id).catch(console.error);
      emit({ type: "status", session_id: id, status: "stopped", detail: reason });
      return;
    }
    if (drainMs) await new Promise((resolve) => setTimeout(resolve, drainMs));
    await s.archive.stop().finally(releaseInput);
    const audioMs = samplesToMs(s.total);
    await db.patchSession(id, { status: "stopping", audio_ms: audioMs });
    if (s.chunker) {
      const last = s.chunker.finish();
      if (last) this.submit(id, s, last, "live", false);
    }
    const mode = s.row.summary_mode;
    if (mode === "after") {
      const file = await db.recordingFile(id);
      const audio = file ? await decodeTo16k(file).catch(() => new Float32Array()) : new Float32Array();
      const hadLive = (await db.transcript(id)).length > 0;
      for (const c of chunkAll(audio, 0)) this.submit(id, s, c, "after", hadLive);
    }
    let reportPending = false;
    if (mode !== "off") {
      await this.waitIdle(s);
      await this.reduce(id, s.insightBuf.splice(0));
      // With parts still missing, the report waits until transcription is complete.
      reportPending = (await db.pending(id)).length > 0 || !(await this.report(id, s.row.title));
    }
    await db.patchSession(id, { status: "stopped", ended_at: new Date().toISOString(), failure: reason === "user" || reason === "ended" ? null : reason, audio_ms: audioMs, asr_seconds: s.row.asr_seconds, tokens: s.row.tokens, report_pending: reportPending });
    this.sessions.delete(id);
    emit({ type: "status", session_id: id, status: "stopped", detail: reason });
  }

  /** Returns true when a report was written. */
  private async report(id: string, title: string): Promise<boolean> {
    const segs = await db.transcript(id);
    if (!segs.length) {
      await db.putReport({ sessionId: id, body: `# ${title}\n\n_No speech was transcribed._\n`, sections: [], created_at: new Date().toISOString() });
      return true;
    }
    try {
      const { target, settings } = await this.ctx();
      const points = await db.insights(id);
      const { out } = await chatJson(target, reportSystem(settings.outputLang), reportInput(title, segs, points), 4000);
      const r = renderReport(title, out, new Map(segs.map((e) => [e.id, e])));
      const name = typeof out?.title === "string" ? out.title.trim().replace(/^["“「]|["”」]$/g, "").slice(0, 80) : "";
      const row = await db.getSession(id);
      if (name && row && (!row.name || row.name_auto)) await db.patchSession(id, { name, name_auto: true });
      await db.putReport({ sessionId: id, body: r.body, sections: r.sections, created_at: new Date().toISOString() });
      emit({ type: "report", session_id: id, is_final: true });
      return true;
    } catch (e) {
      this.invalidate();
      emit({ type: "status", session_id: id, status: "stopped", detail: `report_error: ${short(e)}` });
      return false;
    }
  }

  /** Audio of a session at 16 kHz, from the recording (flushed first if still recording). */
  private async audio(id: string): Promise<Float32Array> {
    const live = this.sessions.get(id);
    const file = live ? await live.archive?.flush() : await db.recordingFile(id);
    return file ? decodeTo16k(file) : new Float32Array();
  }

  /**
   * Fills in missing transcription for one session. With nothing pending on a stopped session
   * that has audio but no text (e.g. the service was down for the whole recording), the whole
   * recording is transcribed again. Returns the number of parts attempted.
   */
  async retry(id: string): Promise<{ queued: number; filled: number; remaining: number }> {
    if (this.retrying.has(id)) return { queued: 0, filled: 0, remaining: (await db.pending(id)).length };
    this.retrying.add(id);
    try {
      this.invalidate();
      let parts = await db.pending(id);
      const row = await db.getSession(id);
      if (!row) return { queued: 0, filled: 0, remaining: 0 };
      let audio: Float32Array | null = null;
      if (!parts.length && !this.sessions.has(id) && row.summary_mode !== "off" && !(await db.transcript(id)).length) {
        audio = await this.audio(id);
        parts = chunkAll(audio, 0).map((c) => ({ id: newId(), sessionId: id, startMs: c.startMs, endMs: c.endMs, pass: "after" as const, correct: false, attempts: 0, lastError: "" }));
        for (const p of parts) await db.putPending(p);
      }
      if (!parts.length) {
        if (row.report_pending && row.status === "stopped") await this.finishRecovered(id, row, []);
        return { queued: 0, filled: 0, remaining: 0 };
      }
      audio = audio ?? (await this.audio(id));
      let filled = 0;
      const fresh: Seg[] = [];
      for (const p of parts) {
        const from = msToSamples(p.startMs);
        const to = Math.min(audio.length, msToSamples(p.endMs));
        if (to <= from) continue; // not readable yet (still being recorded)
        try {
          const segs = await this.segsFor(id, { startMs: p.startMs, samples: audio.slice(from, to) }, p.correct);
          await this.storeSegs(id, segs);
          await db.deletePending(p.id);
          fresh.push(...segs);
          filled++;
        } catch (e) {
          await db.putPending({ ...p, attempts: p.attempts + 1, lastError: short(e) });
          await this.refreshAsr(id, short(e));
          break; // service still down: try again later
        }
      }
      const asr = await this.refreshAsr(id, filled ? null : undefined);
      if (filled && asr.failed_chunks === 0) {
        emit({ type: "status", session_id: id, status: row.status, detail: "asr_recovered" });
        const live = this.sessions.get(id);
        if (live) live.insightBuf.push(...fresh);
        else if (row.status === "stopped" && row.summary_mode !== "off") await this.finishRecovered(id, row, fresh);
      }
      return { queued: parts.length, filled, remaining: asr.failed_chunks };
    } finally {
      this.retrying.delete(id);
    }
  }

  private async finishRecovered(id: string, row: db.LocalSession, fresh: Seg[]) {
    await this.reduce(id, fresh);
    const ok = await this.report(id, row.title);
    await db.patchSession(id, { report_pending: !ok });
  }

  /** Background retry: every session with missing parts or a pending report. */
  async retryAll() {
    const pend = await db.pending().catch(() => [] as db.PendingChunk[]);
    const ids = new Set(pend.map((p) => p.sessionId));
    for (const s of await db.listSessions().catch(() => [] as db.LocalSession[])) if (s.report_pending && s.status === "stopped") ids.add(s.id);
    for (const id of ids) {
      const r = await this.retry(id).catch(() => null);
      if (r && r.remaining > 0) break; // service still down; no point hammering it for other sessions
    }
  }

  /** "What did I miss": recent key points; for 15 minutes with few points, ask the model. */
  async missed(id: string, minutes: number) {
    const segs = await db.transcript(id);
    const to = segs.length ? segs[segs.length - 1].endMs : 0;
    const from = Math.max(0, to - minutes * 60000);
    const points = (await db.insights(id)).filter((i) => i.evidence.some((e) => e.start_ms >= from)).map((i) => ({ text: i.text, evidence: i.evidence }));
    if (points.length >= 2 || minutes < 15) return { minutes, from_ms: from, to_ms: to, points, source: "insights" };
    const window = segs.filter((e) => e.startMs >= from);
    if (!window.length) return { minutes, from_ms: from, to_ms: to, points, source: "insights" };
    const { target, settings } = await this.ctx();
    const sys = `Summarise what was said in this window of ONE audio source as at most 5 bullet points in ${langName(settings.outputLang)}. Return only JSON {"points":[{"text":"...","evidence":["<segment id>"]}]}. Cite segment ids; copy numbers exactly.`;
    const { out } = await chatJson(target, sys, JSON.stringify({ segments: window.map((e) => ({ id: e.id, t: fmtTs(e.startMs), text: e.text })) }), 1200);
    const byId = new Map(window.map((e) => [e.id, e]));
    const pts = (out.points || [])
      .map((p: any) => ({ text: String(p.text ?? "").trim(), evidence: (p.evidence || []).map((x: any) => byId.get(String(x))).filter(Boolean).map((e: Seg) => ({ event_id: e.id, start_ms: e.startMs, end_ms: e.endMs })) }))
      .filter((p: any) => p.text && p.evidence.length);
    return { minutes, from_ms: from, to_ms: to, points: pts, source: "model" };
  }

  /** Commits the recording so far so it can be downloaded. */
  async flush(id: string) {
    await this.sessions.get(id)?.archive?.flush();
  }
}

export function videoKey(url?: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (/(^|\.)youtube\.com$/.test(u.hostname)) {
      const v = u.searchParams.get("v");
      if (v) return `youtube:${v}`;
      const m = u.pathname.match(/^\/live\/([^/?#]+)/);
      if (m) return `youtube:${m[1]}`;
    }
    if (u.hostname === "youtu.be") return `youtube:${u.pathname.slice(1)}`;
    const b = u.pathname.match(/\/video\/(BV\w+)/);
    if (/(^|\.)bilibili\.com$/.test(u.hostname) && b) return `bilibili:${b[1]}`;
  } catch {
    /* not a URL */
  }
  return null;
}

export { ServiceError };
