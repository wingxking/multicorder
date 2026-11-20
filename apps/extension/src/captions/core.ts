// Platform subtitles as a transcript source: parsers, track choice, and the two ways cues are
// played out in step with what the user actually hears (design: "text source layer").
//
// Everything here is pure (no DOM, no chrome.*), so it is unit-tested in test/captions.test.ts and
// shared by the in-page script.

/** One subtitle cue in video time. */
export interface Cue {
  start: number; // ms
  end: number; // ms
  text: string;
}

/** Where the text of a recording comes from while subtitles are used. */
export interface CaptionSource {
  platform: "youtube" | "bilibili" | "tiktok" | "douyin" | "web";
  /** "creator": uploaded by the author; "auto": the platform's own speech recognition; "live": broadcast captions. */
  kind: "creator" | "auto" | "live";
  lang: string | null;
  /** Other languages the platform offers for this video (for the UI). */
  languages?: string[];
}

/** Messages from the in-page script (window.postMessage) to the extension. */
export type CaptionMsg =
  | { kind: "cue"; wall_ms: number; dur_ms: number; text: string; source: CaptionSource }
  | { kind: "state"; active: boolean; source: CaptionSource | null; video_key: string | null };

export const PAGE_TAG = "mc-caption";

const CREDIT = /^\s*(翻译人员|校对人员|翻译|校对|字幕|Translator|Reviewer|Subtitles? by|Transcriber)\s*[:：].*$/gim;

/** Collapses whitespace and drops translator / reviewer credit lines. */
export function cleanText(text: string): string {
  return text.replace(CREDIT, "").replace(/\s+/g, " ").trim();
}

/** Sorts cues, drops empty ones and trims overlaps (rolling auto-captions overlap the next line). */
export function normalizeCues(cues: Cue[]): Cue[] {
  const out = cues
    .map((c) => ({ start: Math.max(0, Math.round(c.start)), end: Math.round(c.end), text: cleanText(c.text) }))
    .filter((c) => c.text && Number.isFinite(c.start) && Number.isFinite(c.end))
    .sort((a, b) => a.start - b.start);
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1];
    if (next && next.start > out[i].start) out[i].end = Math.min(out[i].end, next.start);
    if (out[i].end <= out[i].start) out[i].end = out[i].start + 1000;
  }
  return out;
}

/** YouTube `timedtext?fmt=json3`. */
export function parseYouTubeJson3(json: unknown): Cue[] {
  const events = (json as { events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string }[] }[] })?.events ?? [];
  return normalizeCues(events
    .filter((e) => e.segs?.length && e.tStartMs !== undefined)
    .map((e) => ({ start: e.tStartMs!, end: e.tStartMs! + (e.dDurationMs ?? 0), text: e.segs!.map((s) => s.utf8 ?? "").join("") })));
}

/** Bilibili subtitle JSON: `{ body: [{ from, to, content }] }` in seconds. */
export function parseBilibili(json: unknown): Cue[] {
  const body = (json as { body?: { from?: number; to?: number; content?: string }[] })?.body ?? [];
  return normalizeCues(body.map((b) => ({ start: (b.from ?? 0) * 1000, end: (b.to ?? 0) * 1000, text: b.content ?? "" })));
}

const VTT_TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})/;
function vttMs(s: string): number {
  const m = s.match(VTT_TIME);
  if (!m) return NaN;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]);
}

/** WebVTT or SRT text. */
export function parseVtt(text: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of text.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const [a, b] = lines[at].split("-->");
    const body = lines.slice(at + 1).join("\n").replace(/<[^>]+>/g, "");
    cues.push({ start: vttMs(a), end: vttMs(b), text: body });
  }
  return normalizeCues(cues);
}

/** ByteDance caption JSON (TikTok / Douyin): `{ utterances: [{ start_time, end_time, text }] }` in ms. */
export function parseByteDanceJson(json: unknown): Cue[] {
  const list = (json as { utterances?: { start_time?: number; end_time?: number; text?: string }[] })?.utterances ?? [];
  return normalizeCues(list.map((u) => ({ start: u.start_time ?? 0, end: u.end_time ?? 0, text: u.text ?? "" })));
}

/** Parses a subtitle file whose format is not known in advance. */
export function parseAny(body: string): Cue[] {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const json = JSON.parse(trimmed);
      if (json.events) return parseYouTubeJson3(json);
      if (json.body) return parseBilibili(json);
      if (json.utterances) return parseByteDanceJson(json);
    } catch {
      return [];
    }
    return [];
  }
  return parseVtt(body);
}

const baseLang = (lang: string | null | undefined) => (lang ?? "").toLowerCase().replace(/^ai-/, "").split(/[-_]/)[0];

export interface YouTubeTrack { languageCode: string; kind?: string; vssId?: string }

/**
 * The best YouTube track: the creator's track in the spoken language, else YouTube's own
 * speech recognition, else the player's default track.
 */
export function pickYouTubeTrack(tracks: YouTubeTrack[], defaultIndex?: number): { track: YouTubeTrack; kind: "creator" | "auto" } | null {
  if (!tracks.length) return null;
  const asr = tracks.find((t) => t.kind === "asr");
  const fallback = defaultIndex !== undefined ? tracks[defaultIndex] : undefined;
  const spoken = baseLang(asr?.languageCode ?? fallback?.languageCode);
  const creator = tracks.find((t) => t.kind !== "asr" && spoken && baseLang(t.languageCode) === spoken);
  if (creator) return { track: creator, kind: "creator" };
  if (asr) return { track: asr, kind: "auto" };
  if (fallback) return { track: fallback, kind: fallback.kind === "asr" ? "auto" : "creator" };
  return { track: tracks[0], kind: tracks[0].kind === "asr" ? "auto" : "creator" };
}

export interface BilibiliTrack { lan: string; subtitle_url?: string; ai_type?: number }

/** Bilibili: an uploaded track (Chinese first), else Bilibili's AI subtitles in the spoken language. */
export function pickBilibiliTrack(tracks: BilibiliTrack[]): { track: BilibiliTrack; kind: "creator" | "auto" } | null {
  const usable = tracks.filter((t) => t.subtitle_url);
  if (!usable.length) return null;
  const isAi = (t: BilibiliTrack) => t.lan.startsWith("ai-");
  const ai = usable.filter(isAi);
  const spoken = baseLang(ai[0]?.lan);
  const creator = usable.filter((t) => !isAi(t));
  const pick = creator.find((t) => spoken && baseLang(t.lan) === spoken) ?? creator.find((t) => baseLang(t.lan) === "zh") ?? creator[0];
  if (pick) return { track: pick, kind: "creator" };
  return { track: ai.find((t) => baseLang(t.lan) === spoken) ?? ai[0], kind: "auto" };
}

export interface ByteDanceTrack { lang: string; url: string; source?: string }

/** TikTok / Douyin: creator captions, else the platform's speech recognition; never machine translation. */
export function pickByteDanceTrack(tracks: ByteDanceTrack[]): { track: ByteDanceTrack; kind: "creator" | "auto" } | null {
  const usable = tracks.filter((t) => t.url && (t.source ?? "").toUpperCase() !== "MT");
  if (!usable.length) return null;
  const creator = usable.find((t) => t.source && !["ASR", "MT"].includes(t.source.toUpperCase()));
  if (creator) return { track: creator, kind: "creator" };
  return { track: usable[0], kind: "auto" };
}

/**
 * Plays out a known cue list in step with the video: `due()` returns the cues whose start the
 * playhead crossed since the last call. Seeks reset it (skipped cues were never heard); the cue
 * on screen right after a seek or at the start is included.
 */
export class CuePlayer {
  private last: number | null = null;
  constructor(public cues: Cue[]) {}

  due(currentMs: number, rate = 1): Cue[] {
    const prev = this.last;
    this.last = currentMs;
    const jumped = prev === null || currentMs < prev - 250 || currentMs - prev > 5000 * Math.max(1, rate);
    if (!jumped && currentMs <= prev!) return [];
    const out: Cue[] = [];
    for (let i = this.lowerBound(jumped ? currentMs - 60000 : prev!); i < this.cues.length && this.cues[i].start <= currentMs; i++) {
      const c = this.cues[i];
      if (jumped ? c.end > currentMs : c.start > prev!) out.push(c);
    }
    return out;
  }

  private lowerBound(ms: number) {
    let lo = 0, hi = this.cues.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cues[mid].start < ms) lo = mid + 1; else hi = mid;
    }
    return Math.max(0, lo - 1);
  }
}

/**
 * Turns snapshots of an on-screen caption window (roll-up live captions, a line growing word by
 * word or scrolling up) into finished lines, each emitted once with the time it first appeared.
 */
export class LineAssembler {
  private lines: { text: string; since: number }[] = [];
  private changedAt = 0;
  private recent: string[] = [];

  constructor(private idleMs = 3000) {}

  push(snapshot: string[], now: number): { text: string; start: number; end: number }[] {
    const lines = snapshot.map((l) => cleanText(l)).filter(Boolean);
    const out: { text: string; start: number; end: number }[] = [];
    const same = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);
    const next = lines.map((text) => ({ text, since: this.lines.find((l) => same(l.text, text))?.since ?? now }));
    // Lines that scrolled away or vanished are finished.
    for (const old of this.lines) if (!next.some((l) => same(l.text, old.text))) this.commit(old.text, old.since, now, out);
    // Lines above the last one are finished too.
    for (const line of next.slice(0, -1)) this.commit(line.text, line.since, now, out);
    if (next.map((l) => l.text).join("\n") !== this.lines.map((l) => l.text).join("\n")) this.changedAt = now;
    this.lines = next;
    const last = next[next.length - 1];
    if (last && now - this.changedAt >= this.idleMs) this.commit(last.text, last.since, now, out);
    return out;
  }

  private commit(text: string, start: number, now: number, out: { text: string; start: number; end: number }[]) {
    if (this.recent.some((r) => r === text || r.startsWith(text))) return;
    const earlier = this.recent.find((r) => text.startsWith(r));
    const piece = earlier ? text.slice(earlier.length).trim() : text;
    this.recent = [text, ...this.recent.filter((r) => r !== earlier)].slice(0, 12);
    if (piece) out.push({ text: piece, start, end: Math.max(now, start + 500) });
  }
}

/** A chunk counts as covered by subtitles when they were playing for this share of it. */
export const CAPTION_COVERAGE = 0.8;

/** Recording-time ranges during which platform subtitles were playing (same rule as the Mac app engine). */
export class Coverage {
  ranges: [number, number][] = [];

  /** One "subtitles playing" heartbeat at recording time `at` (about once a second). */
  beat(at: number) {
    this.add(at - 1500, at + 500);
  }

  add(start: number, end: number) {
    if (end <= start) return;
    const all = [...this.ranges, [start, end] as [number, number]].sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const [s, e] of all) {
      const last = merged[merged.length - 1];
      if (last && s <= last[1]) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
    this.ranges = merged;
  }

  share(start: number, end: number): number {
    if (end <= start) return 0;
    return this.ranges.reduce((a, [s, e]) => a + Math.max(0, Math.min(e, end) - Math.max(s, start)), 0) / (end - start);
  }
}

export const captionEngineId = (s: CaptionSource) => `caption:${s.platform}:${s.kind}:${s.lang ?? "und"}`;
