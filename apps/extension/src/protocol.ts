// Messages between extension contexts and the WebSocket frame format (protocol v1, design 6.1).

export const FRAME_SAMPLES = 1600; // 100 ms at 16 kHz
export const HEADER = 20;

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

export type OffscreenMsg =
  | { target: "offscreen"; type: "start"; sessionId: string; streamId: string; tabId: number; port: number; token: string; muted?: boolean }
  | { target: "offscreen"; type: "start-element"; sessionId: string; audioUrl: string; tabId: number; port: number; token: string }
  | { target: "offscreen"; type: "stop"; sessionId?: string; tabId?: number; reason: string }
  | { target: "offscreen"; type: "mark"; tabId: number; mark: MediaMark }
  | { target: "offscreen"; type: "navigation"; tabId: number; url?: string; title?: string }
  | { target: "offscreen"; type: "mute"; sessionId: string; muted: boolean }
  | { target: "offscreen"; type: "list" };

export interface OffscreenSession {
  sessionId: string;
  tabId: number;
  levelDb: number;
  connected: boolean;
  sentFrames: number;
  bufferedFrames: number;
  muted: boolean;
}

export const WHITELIST = [/(^|\.)youtube\.com$/, /^youtu\.be$/, /(^|\.)bilibili\.com$/, /(^|\.)vimeo\.com$/, /(^|\.)twitch\.tv$/, /(^|\.)x\.com$/, /(^|\.)linkedin\.com$/];

export function isWhitelisted(url?: string): boolean {
  if (!url) return false;
  try {
    const h = new URL(url).hostname;
    return WHITELIST.some((r) => r.test(h));
  } catch {
    return false;
  }
}
