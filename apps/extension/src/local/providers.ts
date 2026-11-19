// Transcription and summary calls for the in-browser engine. Three targets:
//  - "service": the Multicorder service API — the local Mac app/daemon (127.0.0.1) or the cloud
//    (multicoder.followkol.live). POST /v1/asr/transcribe (WAV) and POST /v1/llm/chat.
//  - "custom": provider APIs called directly with the user's keys (same request shapes as mc-asr
//    and mc-insight).

import { samplesToMs, SAMPLE_RATE } from "./chunker";
import type { AsrSettings, LlmProvider } from "./settings";

export interface AsrSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export type Target =
  | { kind: "service"; env: "local" | "cloud"; base: string; token: string }
  | { kind: "custom"; asr: AsrSettings; llm: LlmProvider[] };

/** A provider/service failure that should be retried later (recording is unaffected). */
export class ServiceError extends Error {
  constructor(message: string, public code = "service_unavailable") {
    super(message);
  }
}

export function targetLabel(t: Target): string {
  return t.kind === "custom" ? `${t.asr.provider}:${t.asr.model}` : t.env === "local" ? "local-service" : "cloud-service";
}

export function encodeWav(samples: Float32Array): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

async function send(fn: () => Promise<Response>, label: string): Promise<Response> {
  let attempt = 0;
  for (;;) {
    let r: Response;
    try {
      r = await fn();
    } catch (e) {
      if (attempt++ < 1) {
        await new Promise((res) => setTimeout(res, 1500));
        continue;
      }
      throw new ServiceError(`${label} unreachable (${(e as Error).message})`, "unreachable");
    }
    if (r.ok) return r;
    if ((r.status === 429 || r.status >= 500) && attempt++ < 1) {
      await new Promise((res) => setTimeout(res, 2000));
      continue;
    }
    const body = await r.text();
    let code = r.status === 401 ? "unauthorized" : "service_unavailable";
    try {
      code = JSON.parse(body).code || code;
    } catch {
      /* not JSON */
    }
    throw new ServiceError(`${label} HTTP ${r.status}: ${body.slice(0, 200)}`, code);
  }
}

export async function transcribe(t: Target, pcm: Float32Array, lang?: string): Promise<AsrSegment[]> {
  const wav = encodeWav(pcm);
  if (t.kind === "service") {
    const q = lang ? `?lang=${encodeURIComponent(lang)}` : "";
    const r = await send(() => fetch(`${t.base}/v1/asr/transcribe${q}`, { method: "POST", headers: { Authorization: `Bearer ${t.token}`, "Content-Type": "audio/wav" }, body: wav }), t.env === "local" ? "Local service" : "Cloud service");
    const body = await r.json();
    return (body.segments || []).filter((x: any) => String(x.text ?? "").trim()).map((x: any) => ({ startMs: x.start_ms, endMs: x.end_ms, text: String(x.text).trim() }));
  }
  const s = t.asr;
  if (!s.apiKey) throw new ServiceError("No transcription key set", "unauthorized");
  const root = s.baseUrl.replace(/\/+$/, "");
  const endpoint = (root.endsWith("/v1") ? root : root + "/v1") + "/audio/transcriptions";
  const durationMs = samplesToMs(pcm.length);
  const make = () => {
    const f = new FormData();
    f.append("model", s.model);
    f.append("file", wav, "chunk.wav");
    if (s.protocol === "moss") {
      f.append("response_format", s.segmented ? "diarized_json" : "json");
      if (s.segmented) f.append("diarize", "true");
    } else {
      f.append("response_format", s.segmented ? "verbose_json" : "json");
      if (s.segmented) f.append("timestamp_granularities[]", "segment");
      const l = lang || s.language;
      if (l) f.append("language", l.split("-")[0]);
    }
    return f;
  };
  const r = await send(() => fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${s.apiKey}` }, body: make() }), s.provider);
  const body = await r.json();
  const segs: any[] = Array.isArray(body.segments) ? body.segments : [];
  if (!s.segmented || !segs.length) {
    const text = String(body.text ?? "").trim();
    return text ? [{ startMs: 0, endMs: durationMs, text }] : [];
  }
  return segs
    .filter((x) => String(x.text ?? "").trim() && x.end > x.start)
    .map((x) => ({ startMs: Math.round(x.start * 1000), endMs: Math.min(Math.round(x.end * 1000), Math.max(1, durationMs)), text: String(x.text).trim() }));
}

export function parseJsonLoose(s: string): any | null {
  const t = s.trim();
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch {
      return null;
    }
  }
}

export interface ChatUsage {
  provider: string;
  model: string;
  tokens: number;
}

/** Chat returning parsed JSON, via the Multicorder service or the user's providers (in order). */
export async function chatJson(t: Target, system: string, user: string, maxTokens: number): Promise<{ out: any; usage: ChatUsage }> {
  if (t.kind === "service") {
    const r = await send(
      () => fetch(`${t.base}/v1/llm/chat`, { method: "POST", headers: { Authorization: `Bearer ${t.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ system, user, max_tokens: maxTokens }) }),
      t.env === "local" ? "Local service" : "Cloud service",
    );
    const body = await r.json();
    return { out: body.out, usage: { provider: body.usage?.provider ?? "service", model: body.usage?.model ?? "", tokens: body.usage?.tokens ?? 0 } };
  }
  let last: unknown = new ServiceError("No summary provider key set", "unauthorized");
  for (const p of t.llm.filter((x) => x.apiKey)) {
    try {
      const body: any = {
        model: p.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: maxTokens,
        temperature: 0.2,
        stream: false,
        ...(p.jsonMode !== false ? { response_format: { type: "json_object" } } : {}),
        ...(p.extra || {}),
      };
      const r = await send(() => fetch(p.baseUrl.replace(/\/+$/, "") + "/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${p.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }), p.name);
      const j = await r.json();
      const finish = j.choices?.[0]?.finish_reason;
      if (finish === "content_filter" || finish === "sensitive") throw new ServiceError(`${p.name} refused`);
      const out = parseJsonLoose(String(j.choices?.[0]?.message?.content ?? ""));
      if (!out) throw new ServiceError(`${p.name} returned non-JSON output`);
      return { out, usage: { provider: p.name, model: p.model, tokens: (j.usage?.prompt_tokens ?? 0) + (j.usage?.completion_tokens ?? 0) } };
    } catch (e) {
      last = e;
    }
  }
  throw last;
}
