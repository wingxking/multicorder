// IndexedDB storage for standalone mode (database "multicorder"). Every read takes a session id
// (isolation invariant); recordings live in OPFS at rec/<session>.webm.

import type { Insight, Seg } from "./insight";

export interface LocalSession {
  id: string;
  backend: "local";
  kind: "chromium_tab";
  title: string;
  url?: string | null;
  video_key?: string | null;
  status: string;
  summary_mode: "off" | "live" | "after";
  started_at: string;
  ended_at?: string | null;
  failure?: string | null;
  audio_ms: number;
  detail?: string | null;
  asr_seconds?: number;
  tokens?: number;
  /** Transcription health: parts waiting for the service to come back. */
  asr?: { state: "ok" | "degraded"; failed_chunks: number; failed_ms?: number };
  report_pending?: boolean;
  last_error?: string | null;
  /** The recording's own name (typed, or written by the model when `name_auto`). */
  name?: string | null;
  name_auto?: boolean;
}

/** A part of a recording whose transcription failed; retried from the OPFS recording. */
export interface PendingChunk {
  id: string;
  sessionId: string;
  startMs: number;
  endMs: number;
  pass: "live" | "after" | "backfill";
  correct: boolean;
  attempts: number;
  lastError: string;
}

export interface LocalReport {
  sessionId: string;
  body: string;
  sections: unknown;
  created_at: string;
}

let dbp: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open("multicorder", 2);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      if (ev.oldVersion < 1) {
        db.createObjectStore("sessions", { keyPath: "id" });
        db.createObjectStore("transcripts", { keyPath: "id" }).createIndex("sessionId", "sessionId");
        db.createObjectStore("insights", { keyPath: "id" }).createIndex("session_id", "session_id");
        db.createObjectStore("reports", { keyPath: "sessionId" });
      }
      if (ev.oldVersion < 2) db.createObjectStore("pending", { keyPath: "id" }).createIndex("sessionId", "sessionId");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function wrap<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function store(name: string, mode: IDBTransactionMode = "readonly") {
  return (await openDb()).transaction(name, mode).objectStore(name);
}

export async function putSession(s: LocalSession) {
  await wrap((await store("sessions", "readwrite")).put(s));
}
export async function getSession(id: string): Promise<LocalSession | undefined> {
  return wrap((await store("sessions")).get(id));
}
export async function patchSession(id: string, patch: Partial<LocalSession>) {
  const sessions = await store("sessions", "readwrite");
  const s: LocalSession | undefined = await wrap(sessions.get(id));
  if (s) await wrap(sessions.put({ ...s, ...patch }));
}
export async function listSessions(): Promise<LocalSession[]> {
  const all: LocalSession[] = await wrap((await store("sessions")).getAll());
  return all.sort((a, b) => b.started_at.localeCompare(a.started_at));
}

export async function putSeg(s: Seg) {
  await wrap((await store("transcripts", "readwrite")).put(s));
}
/** Current transcript: corrected segments replace live ones they cover. */
export async function transcript(sessionId: string): Promise<Seg[]> {
  const all: Seg[] = await wrap((await store("transcripts")).index("sessionId").getAll(sessionId));
  const corrected = all.filter((s) => s.state === "corrected");
  const coveredUntil = corrected.reduce((m, s) => Math.max(m, s.endMs), 0);
  return all.filter((s) => s.state === "corrected" || s.startMs >= coveredUntil).sort((a, b) => a.startMs - b.startMs);
}

export async function putInsight(i: Insight) {
  await wrap((await store("insights", "readwrite")).put(i));
}
/** Latest revision of each key, retracted ones dropped unless asked. */
export async function insights(sessionId: string, includeRetracted = false): Promise<Insight[]> {
  const all: Insight[] = await wrap((await store("insights")).index("session_id").getAll(sessionId));
  const latest = new Map<string, Insight>();
  for (const i of all) if (!latest.has(i.key) || latest.get(i.key)!.revision < i.revision) latest.set(i.key, i);
  return [...latest.values()].filter((i) => includeRetracted || i.state !== "retracted").sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function putReport(r: LocalReport) {
  await wrap((await store("reports", "readwrite")).put(r));
}
export async function getReport(sessionId: string): Promise<LocalReport | undefined> {
  return wrap((await store("reports")).get(sessionId));
}

export async function putPending(p: PendingChunk) {
  await wrap((await store("pending", "readwrite")).put(p));
}
export async function deletePending(id: string) {
  await wrap((await store("pending", "readwrite")).delete(id));
}
export async function pending(sessionId?: string): Promise<PendingChunk[]> {
  const st = await store("pending");
  const all: PendingChunk[] = await wrap(sessionId ? st.index("sessionId").getAll(sessionId) : st.getAll());
  return all.sort((a, b) => a.startMs - b.startMs);
}

export async function search(q: string): Promise<{ session: LocalSession; seg: Seg }[]> {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const out: { session: LocalSession; seg: Seg }[] = [];
  for (const s of await listSessions()) for (const seg of await transcript(s.id)) if (seg.text.toLowerCase().includes(needle)) out.push({ session: s, seg });
  return out;
}

/** Removes a recording's text (transcript, key points, report, pending parts) but keeps its audio. */
export async function clearText(id: string) {
  const db = await openDb();
  const tx = db.transaction(["transcripts", "insights", "reports", "pending"], "readwrite");
  tx.objectStore("reports").delete(id);
  for (const [name, idx] of [["transcripts", "sessionId"], ["insights", "session_id"], ["pending", "sessionId"]] as const) {
    const keys: IDBValidKey[] = await wrap(tx.objectStore(name).index(idx).getAllKeys(id));
    keys.forEach((k) => tx.objectStore(name).delete(k));
  }
  await new Promise((res, rej) => ((tx.oncomplete = res), (tx.onerror = () => rej(tx.error))));
}

export async function deleteSession(id: string) {
  const db = await openDb();
  const tx = db.transaction(["sessions", "transcripts", "insights", "reports", "pending"], "readwrite");
  tx.objectStore("sessions").delete(id);
  tx.objectStore("reports").delete(id);
  for (const [name, idx] of [["transcripts", "sessionId"], ["insights", "session_id"], ["pending", "sessionId"]] as const) {
    const keys: IDBValidKey[] = await wrap(tx.objectStore(name).index(idx).getAllKeys(id));
    keys.forEach((k) => tx.objectStore(name).delete(k));
  }
  await new Promise((res, rej) => ((tx.oncomplete = res), (tx.onerror = () => rej(tx.error))));
  try {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("rec");
    await dir.removeEntry(`${id}.webm`);
  } catch {
    /* no recording */
  }
}

export async function recordingFile(id: string): Promise<File | null> {
  try {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("rec");
    return await (await dir.getFileHandle(`${id}.webm`)).getFile();
  } catch {
    return null;
  }
}
