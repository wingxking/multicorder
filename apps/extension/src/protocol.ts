// Messages between extension contexts and the WebSocket frame format (protocol v1, design 6.1).

export const FRAME_SAMPLES = 1600; // 100 ms at 16 kHz
export const HEADER = 20;
export const AUDIO_START_DB = -55;
export const PRE_ROLL_MS = 200;

export function encodeFrame(seq: number, wallMs: number, pcm: Int16Array, flags = 0): ArrayBuffer {
  const buf = new ArrayBuffer(HEADER + pcm.length * 2);
  const v = new DataView(buf);
  v.setUint8(0, 0x4d); // M
  v.setUint8(1, 0x43); // C
  v.setUint8(2, 0x41); // A
  v.setUint8(3, 0x31); // 1
  v.setUint32(4, seq, true);
  v.setFloat64(8, wallMs, true);
  v.setUint16(16, pcm.length, true);
  v.setUint16(18, flags, true);
  new Int16Array(buf, HEADER).set(pcm);
  return buf;
}

export interface MediaMark {
  wall_ms: number;
  media_ms: number | null;
  paused: boolean;
  rate: number;
  live: boolean;
  video_key: string | null;
}

type StartCommon = { backend: "app" | "local"; tabId: number; sessionId?: string; port?: number; token?: string; title?: string; url?: string; mode?: "off" | "live" | "after"; muted?: boolean; waitForAudio?: boolean; settings?: import("./local/settings").Settings };

export type OffscreenMsg =
  | ({ target: "offscreen"; type: "start"; streamId: string } & StartCommon)
  | ({ target: "offscreen"; type: "start-element"; audioUrl: string } & StartCommon)
  | { target: "offscreen"; type: "stop"; sessionId?: string; tabId?: number; reason: string }
  | { target: "offscreen"; type: "mark"; tabId: number; mark: MediaMark }
  | { target: "offscreen"; type: "caption"; tabId: number; msg: import("./captions/core").CaptionMsg; policy: "auto" | "captions" }
  | { target: "offscreen"; type: "navigation"; tabId: number; url?: string; title?: string }
  | { target: "offscreen"; type: "mute"; sessionId: string; muted: boolean }
  | { target: "offscreen"; type: "pause"; sessionId: string; paused: boolean }
  | { target: "offscreen"; type: "mode"; sessionId: string; mode: "off" | "live" | "after" }
  | { target: "offscreen"; type: "local-mode"; sessionId: string; mode: "off" | "live" | "after" }
  | { target: "offscreen"; type: "local-missed"; sessionId: string; minutes: number }
  | { target: "offscreen"; type: "local-retry"; sessionId: string }
  | { target: "offscreen"; type: "local-asr"; sessionId: string }
  | { target: "offscreen"; type: "local-flush"; sessionId: string }
  | { target: "offscreen"; type: "local-retry-all" }
  | { target: "offscreen"; type: "list" };

export interface OffscreenSession {
  sessionId: string;
  backend: "app" | "local";
  tabId: number;
  levelDb: number;
  connected: boolean;
  sentFrames: number;
  bufferedFrames: number;
  muted: boolean;
}

export const WHITELIST = [/(^|\.)youtube\.com$/, /^youtu\.be$/, /(^|\.)bilibili\.com$/, /(^|\.)vimeo\.com$/, /(^|\.)twitch\.tv$/, /(^|\.)x\.com$/, /(^|\.)linkedin\.com$/, /(^|\.)tiktok\.com$/, /(^|\.)douyin\.com$/, /(^|\.)xiaohongshu\.com$/];

export function isWhitelisted(url?: string): boolean {
  if (!url) return false;
  try {
    const h = new URL(url).hostname;
    return WHITELIST.some((r) => r.test(h));
  } catch {
    return false;
  }
}

/** Live state of one tab recording, sent by the offscreen document a few times a second
 *  (`{type:"capture-state"}`) to the side panel and, through the worker, to the Mac app. */
export interface CaptureState {
  tab_id: number;
  session_id: string;
  backend: "app" | "local";
  status: "waiting" | "capturing" | "paused";
  paused: boolean;
  muted: boolean;
  mode: "off" | "live" | "after";
  title: string;
  started_at: string;
  elapsed_ms: number;
  level_db: number;
  /** Waveform peaks (0–1, 40 per second) since the previous report. */
  peaks: number[];
}
