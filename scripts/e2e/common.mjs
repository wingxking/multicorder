// Helpers for the end-to-end tests (Node 22: global fetch and WebSocket).
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const OUT = new URL("../../test-output/", import.meta.url).pathname;

export function pairing(dir = process.env.MC_DATA_DIR) {
  const api = JSON.parse(readFileSync(join(dir, "run/api.json"), "utf8"));
  return { base: `http://127.0.0.1:${api.port}`, port: api.port, token: api.token };
}

export async function api(p, path, init = {}) {
  const r = await fetch(p.base + path, { ...init, headers: { Authorization: `Bearer ${p.token}`, "Content-Type": "application/json", ...(init.headers || {}) } });
  const text = await r.text();
  if (!r.ok) throw new Error(`${init.method || "GET"} ${path} → ${r.status} ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** PCM16 samples of a 16 kHz mono WAV (walks RIFF chunks to find `data`). */
export function readWav(path) {
  const b = readFileSync(path);
  let off = 12;
  while (off < b.length) {
    const id = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === "data") return new Int16Array(b.buffer.slice(b.byteOffset + off + 8, b.byteOffset + off + 8 + size));
    off += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}

export function frame(seq, wallMs, pcm) {
  const buf = new ArrayBuffer(20 + pcm.length * 2);
  const v = new DataView(buf);
  [0x4d, 0x43, 0x41, 0x31].forEach((c, i) => v.setUint8(i, c));
  v.setUint32(4, seq, true);
  v.setFloat64(8, wallMs, true);
  v.setUint16(16, pcm.length, true);
  v.setUint16(18, 0, true);
  new Int16Array(buf, 20).set(pcm);
  return buf;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFinished(p, id, timeoutMs = 300_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = await api(p, `/v1/sessions/${id}`);
    if (!s.active && ["stopped", "failed"].includes(s.session.status)) return s;
    await sleep(1000);
  }
  throw new Error(`session ${id} did not finish in ${timeoutMs} ms`);
}

/** Checks one session: planted word present, the other session's word absent, evidence valid. */
export async function verify(p, id, { expect, forbid, label }) {
  const transcript = await api(p, `/v1/sessions/${id}/transcript`);
  const insights = await api(p, `/v1/sessions/${id}/insights`);
  const report = await api(p, `/v1/sessions/${id}/report`);
  const text = transcript.map((e) => e.text).join(" ");
  const ids = new Set(transcript.map((e) => e.id));
  const problems = [];
  if (!transcript.length) problems.push("empty transcript");
  if (!new RegExp(expect, "i").test(text)) problems.push(`missing planted word /${expect}/`);
  if (new RegExp(forbid, "i").test(text)) problems.push(`CROSS-TALK: found /${forbid}/`);
  for (const i of insights) for (const e of i.evidence) if (!ids.has(e.event_id)) problems.push(`insight ${i.key} cites foreign evidence`);
  if (!insights.length) problems.push("no insights");
  if (!report?.body) problems.push("no report");
  return {
    label,
    id,
    ok: problems.length === 0,
    problems,
    transcript_chars: text.length,
    transcript_sample: text.slice(0, 160),
    insights: insights.map((i) => `${i.state}: ${i.text}`),
    report_head: report?.body?.slice(0, 400) ?? null,
  };
}

/** Streams PCM16 into a tab session over the WebSocket ingest protocol (E2E_SPEED× real time). */
export async function stream(p, sessionId, pcm, withMarks = false) {
  const speed = Number(process.env.E2E_SPEED || 4);
  const ws = new WebSocket(`ws://127.0.0.1:${p.port}/v1/ingest/${sessionId}`, ["mc.v1", p.token]);
  ws.binaryType = "arraybuffer";
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
  ws.send(JSON.stringify({ t: "hello", session_id: sessionId }));
  let acked = -1;
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.t === "ack") acked = msg.upto_seq;
  };
  const frames = Math.ceil(pcm.length / 1600);
  const t0 = Date.now();
  for (let seq = 0; seq < frames; seq++) {
    const chunk = new Int16Array(1600);
    chunk.set(pcm.subarray(seq * 1600, (seq + 1) * 1600));
    const wall = t0 + (seq * 100) / speed;
    ws.send(frame(seq, wall, chunk));
    if (withMarks && seq % 10 === 0) ws.send(JSON.stringify({ t: "media_mark", wall_ms: wall, media_ms: 60_000 + seq * 100, paused: false, rate: 1, live: false, video_key: "youtube:e2etest" }));
    if (seq % 10 === 9) await sleep(1000 / speed);
  }
  // Two seconds of silence closes the last speech chunk.
  for (let i = 0; i < 20; i++) ws.send(frame(frames + i, Date.now(), new Int16Array(1600)));
  await sleep(1500);
  ws.close();
  return { frames, acked };
}
