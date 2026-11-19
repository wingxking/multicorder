// Speech chunking — a line-by-line port of crates/mc-vad (same constants and policy):
// adaptive energy detector, ≥200 ms speech, 500 ms silence hang, 15 s hard cap, 200 ms pre-roll.

export const SAMPLE_RATE = 16000;
const WINDOW_MS = 30;
export const MIN_SPEECH_MS = 200;
export const SILENCE_HANG_MS = 500;
export const MAX_CHUNK_MS = 15000;
const PRE_ROLL_MS = 200;
const ABS_FLOOR = 0.003;

export const msToSamples = (ms: number) => Math.floor((Math.max(0, ms) * SAMPLE_RATE) / 1000);
export const samplesToMs = (n: number) => Math.floor((n * 1000) / SAMPLE_RATE);

export interface SpeechChunk {
  startMs: number;
  endMs: number;
  samples: Float32Array;
}

interface Current {
  start: number;
  samples: number[];
  speech: number;
  silence: number;
}

export class Chunker {
  private window = msToSamples(WINDOW_MS);
  private pending: number[] = [];
  private pendingStart: number;
  private noise = ABS_FLOOR;
  private preRoll: number[] = [];
  private current: Current | null = null;

  constructor(startSamples = 0) {
    this.pendingStart = startSamples;
  }

  push(samples: ArrayLike<number>): SpeechChunk[] {
    for (let i = 0; i < samples.length; i++) this.pending.push(samples[i]);
    const out: SpeechChunk[] = [];
    while (this.pending.length >= this.window) {
      const win = this.pending.splice(0, this.window);
      const winStart = this.pendingStart;
      this.pendingStart += this.window;
      const c = this.processWindow(win, winStart);
      if (c) out.push(c);
    }
    return out;
  }

  finish(): SpeechChunk | null {
    const rest = this.pending.splice(0);
    if (rest.length && this.current) this.current.samples.push(...rest);
    return this.close();
  }

  private processWindow(win: number[], winStart: number): SpeechChunk | null {
    let sum = 0;
    for (const s of win) sum += s * s;
    const level = Math.sqrt(sum / win.length);
    const threshold = Math.max(this.noise * 2.5, ABS_FLOOR);
    const speech = level > threshold;
    if (!speech) {
      this.noise = level < this.noise ? this.noise * 0.9 + level * 0.1 : this.noise * 0.995 + level * 0.005;
      this.noise = Math.max(this.noise, ABS_FLOOR * 0.5);
    }
    let emitted: SpeechChunk | null = null;
    if (!this.current) {
      if (speech) {
        const pre = this.preRoll.slice();
        this.current = { start: winStart - pre.length, samples: [...pre, ...win], speech: win.length, silence: 0 };
      }
    } else {
      const cur = this.current;
      cur.samples.push(...win);
      if (speech) {
        cur.speech += win.length;
        cur.silence = 0;
      } else cur.silence += win.length;
      if (cur.silence >= msToSamples(SILENCE_HANG_MS) || cur.samples.length >= msToSamples(MAX_CHUNK_MS)) emitted = this.close();
    }
    this.preRoll.push(...win);
    const max = msToSamples(PRE_ROLL_MS);
    if (this.preRoll.length > max) this.preRoll.splice(0, this.preRoll.length - max);
    return emitted;
  }

  private close(): SpeechChunk | null {
    const cur = this.current;
    this.current = null;
    if (!cur || cur.speech < msToSamples(MIN_SPEECH_MS)) return null;
    const keepTail = msToSamples(PRE_ROLL_MS);
    let samples = cur.samples;
    if (cur.silence > keepTail) samples = samples.slice(0, Math.max(0, samples.length - (cur.silence - keepTail)));
    return { startMs: samplesToMs(cur.start), endMs: samplesToMs(cur.start + samples.length), samples: Float32Array.from(samples) };
  }
}

export function chunkAll(samples: ArrayLike<number>, startSamples = 0): SpeechChunk[] {
  const c = new Chunker(startSamples);
  const out = c.push(samples);
  const last = c.finish();
  if (last) out.push(last);
  return out;
}
