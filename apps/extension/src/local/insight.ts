// Rolling key points, "what did I miss" and the report — ported from crates/mc-insight (same
// prompts, same code-side validation: evidence must exist in this session, numbers must appear in
// the cited text, quotes ≤25 words). Pure functions; the engine persists results.

export interface Seg {
  id: string;
  sessionId: string;
  startMs: number;
  endMs: number;
  text: string;
  state: "final" | "corrected";
  engine: string;
}

export interface Evidence {
  event_id: string;
  start_ms: number;
  end_ms: number;
}

export interface Insight {
  id: string;
  session_id: string;
  key: string;
  revision: number;
  kind: string;
  state: "tentative" | "confirmed" | "retracted";
  text: string;
  evidence: Evidence[];
  created_at: string;
}

const KINDS = ["key_point", "claim", "number", "decision", "question", "action", "quote", "topic"];

export const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 26);

export function fmtTs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60) % 60).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function langName(code: string): string {
  if (code.startsWith("zh")) return "Simplified Chinese";
  if (code === "en") return "English";
  if (code === "ja") return "Japanese";
  return "the same language as the transcript";
}

// ---- numbers (port of validators) ----
export function extractNumbers(text: string): string[] {
  const out: string[] = [];
  const re = /\d+(?:[.,]\d+)*/g;
  for (const m of text.match(re) || []) {
    let s = "";
    const parts = m.split(/([.,])/);
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === ",") continue;
      s += parts[i];
    }
    out.push(s);
  }
  return out;
}

export function checkNumbers(text: string, evidence: string): string | null {
  const have = extractNumbers(evidence);
  for (const n of extractNumbers(text)) {
    const v = Number(n);
    if (!Number.isNaN(v) && v <= 10 && !n.includes(".")) continue;
    if (!have.some((h) => h === n || h.replace(/\.0$/, "") === n)) return n;
  }
  return null;
}

// ---- reducer ----
export function reducerSystem(lang: string): string {
  return `You maintain the rolling key points of ONE audio source (a single livestream, video, app or meeting). Return only JSON: {"ops":[...]}. Each op is one of:
{"op":"upsert","key":"<existing key or new short id>","type":"key_point|claim|number|decision|question|action|quote|topic","text":"...","evidence":["<segment id>",...]}
{"op":"confirm","key":"<existing key>"}
{"op":"retract","key":"<existing key>","reason":"..."}
Rules: write "text" in ${langName(lang)}; one concrete point per op, at most 25 words; every upsert cites at least one segment id from the input; copy numbers exactly as they appear in the cited segments (same digits and units, never convert); do not invent facts; skip greetings, filler and ads; do not repeat points that already exist (update them with upsert instead); confirm an existing point when new segments support it; retract one that new segments contradict. Emit at most 5 ops. If nothing new is worth noting, return {"ops":[]}.`;
}

export function reducerInput(current: Insight[], earlier: Seg[], fresh: Seg[]): string {
  const seg = (e: Seg) => ({ id: e.id, t: fmtTs(e.startMs), text: e.text });
  return JSON.stringify({
    current_points: current.slice(-40).map((i) => ({ key: i.key, type: i.kind, state: i.state, text: i.text, evidence: i.evidence.map((e) => e.event_id) })),
    earlier_segments: earlier.slice(-12).map(seg),
    new_segments: fresh.map(seg),
  });
}

export interface Outcome {
  applied: Insight[];
  rejected: string[];
}

/** Validates reducer ops against this session's segments and current points. */
export function applyOps(sessionId: string, out: any, segs: Map<string, Seg>, current: Insight[]): Outcome {
  const outcome: Outcome = { applied: [], rejected: [] };
  const existing = new Map(current.map((i) => [i.key, i]));
  const ops: any[] = Array.isArray(out?.ops) ? out.ops.slice(0, 8) : [];
  const now = new Date().toISOString();
  for (const op of ops) {
    const key = String(op?.key ?? "").trim();
    if (op?.op === "upsert") {
      const text = String(op.text ?? "").trim();
      const kind = KINDS.includes(op.type) ? op.type : "key_point";
      const ids: string[] = Array.isArray(op.evidence) ? op.evidence.map(String) : [];
      const ev = ids.map((id) => segs.get(id)).filter((e): e is Seg => !!e);
      if (!text) {
        outcome.rejected.push("empty text");
        continue;
      }
      if (!ev.length || ev.length !== ids.length) {
        outcome.rejected.push(`unknown evidence for: ${text}`);
        continue;
      }
      const bad = checkNumbers(text, ev.map((e) => e.text).join(" "));
      if (bad) {
        outcome.rejected.push(`number ${bad} not in evidence: ${text}`);
        continue;
      }
      if (kind === "quote" && text.split(/\s+/).length > 25) {
        outcome.rejected.push("quote too long");
        continue;
      }
      const prev = existing.get(key);
      if (prev && prev.text === text) continue;
      const ins: Insight = {
        id: newId(),
        session_id: sessionId,
        key: key && !(prev === undefined && existing.has(key)) ? key : `k${newId().slice(0, 6)}`,
        revision: prev ? prev.revision + 1 : 1,
        kind,
        state: prev ? prev.state : "tentative",
        text,
        evidence: ev.map((e) => ({ event_id: e.id, start_ms: e.startMs, end_ms: e.endMs })),
        created_at: now,
      };
      existing.set(ins.key, ins);
      outcome.applied.push(ins);
    } else if (op?.op === "confirm" || op?.op === "retract") {
      const prev = existing.get(key);
      if (!prev) {
        outcome.rejected.push(`${op.op} of unknown key ${key}`);
        continue;
      }
      const state = op.op === "confirm" ? "confirmed" : "retracted";
      if (prev.state === state) continue;
      const ins: Insight = { ...prev, id: newId(), revision: prev.revision + 1, state, created_at: now };
      existing.set(key, ins);
      outcome.applied.push(ins);
    } else {
      outcome.rejected.push(`unknown op ${op?.op}`);
    }
  }
  return outcome;
}

// ---- report ----
export function reportSystem(lang: string): string {
  return `Write the final report for ONE audio source in ${langName(lang)}. Return only JSON: {"title":"a short, specific name for this recording (at most 8 words, no quotes or date)","summary":"2-3 sentences","sections":[{"heading":"...","bullets":[{"text":"...","evidence":["<segment id>"]}]}]}. Use 3-6 sections such as key points, numbers and announcements, decisions, open questions, action items. Every bullet cites segment ids from the input; copy numbers exactly as in the cited segments; do not invent facts.`;
}

export function reportInput(title: string, segs: Seg[], points: Insight[]): string {
  let list = segs.map((e) => ({ id: e.id, t: fmtTs(e.startMs), text: e.text }));
  const total = segs.reduce((a, e) => a + e.text.length, 0);
  if (total > 60000) {
    const keep = Math.floor(list.length / 3);
    list = [...list.slice(0, keep), ...list.slice(list.length - keep)];
  }
  return JSON.stringify({ title, rolling_points: points.map((i) => ({ type: i.kind, text: i.text })), segments: list });
}

export interface ReportOut {
  body: string;
  sections: { heading: string; bullets: { text: string; evidence: Evidence[] }[] }[];
}

/** Keeps only bullets with valid evidence and numbers; renders Markdown with timestamps. */
export function renderReport(title: string, out: any, segs: Map<string, Seg>): ReportOut {
  let md = `# ${title}\n\n`;
  if (typeof out?.summary === "string") md += out.summary.trim() + "\n\n";
  const sections: ReportOut["sections"] = [];
  for (const sec of Array.isArray(out?.sections) ? out.sections : []) {
    const heading = String(sec?.heading ?? "").trim();
    const bullets: { text: string; evidence: Evidence[] }[] = [];
    for (const b of Array.isArray(sec?.bullets) ? sec.bullets : []) {
      const text = String(b?.text ?? "").trim();
      const ev = (Array.isArray(b?.evidence) ? b.evidence : []).map((id: any) => segs.get(String(id))).filter((e: Seg | undefined): e is Seg => !!e);
      if (!text || !ev.length) continue;
      if (checkNumbers(text, ev.map((e: Seg) => e.text).join(" "))) continue;
      bullets.push({ text, evidence: ev.map((e: Seg) => ({ event_id: e.id, start_ms: e.startMs, end_ms: e.endMs })) });
    }
    if (!heading || !bullets.length) continue;
    md += `## ${heading}\n\n` + bullets.map((b) => `- ${b.text} \`[${fmtTs(b.evidence[0].start_ms)}]\``).join("\n") + "\n\n";
    sections.push({ heading, bullets });
  }
  return { body: md, sections };
}
