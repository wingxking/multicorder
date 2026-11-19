// Offscreen document (USER_MEDIA): one shared 48 kHz AudioContext; per tab an independent
// node chain (source → gain → speakers, source → pcm-tap worklet) and its own WebSocket (design 5.4–5.5).

import { encodeFrame, MediaMark, OffscreenMsg, OffscreenSession } from "./protocol";

const RESEND_FRAMES = 600; // 60 s
const MAX_BUFFERED_BYTES = 512 * 1024;

let ctx: AudioContext | null = null;
async function audioContext(): Promise<AudioContext> {
  if (!ctx) {
    ctx = new AudioContext({ sampleRate: 48000, latencyHint: "playback" });
    await ctx.audioWorklet.addModule("pcm-tap.worklet.js");
  }
  if (ctx.state === "suspended") await ctx.resume();
  return ctx;
}

class IngestPipe {
  private ws: WebSocket | null = null;
  private frames: { seq: number; buf: ArrayBuffer }[] = [];
  private nextSeq = 0;
  private acked = -1;
  private backoff = 500;
  private closed = false;
  connected = false;
  sent = 0;

  constructor(private sessionId: string, private port: number, private token: string, private onGone: (reason: string) => void) {
    this.connect();
  }

  private connect() {
    if (this.closed) return;
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}/v1/ingest/${this.sessionId}`, ["mc.v1", this.token]);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.backoff = 500;
      ws.send(JSON.stringify({ t: "hello", session_id: this.sessionId, resume_from: this.acked + 1, ext_version: chrome.runtime.getManifest().version }));
    };
    ws.onmessage = (m) => {
      if (typeof m.data !== "string") return;
      const msg = JSON.parse(m.data);
      if (msg.t === "hello") {
        // Resend what the app has not seen yet (after a reconnect).
        for (const f of this.frames) if (f.seq >= msg.next_seq) this.sendRaw(f.buf);
      } else if (msg.t === "ack") {
        this.acked = msg.upto_seq;
        this.frames = this.frames.filter((f) => f.seq > this.acked);
      } else if (msg.t === "close") {
        this.close();
        this.onGone(msg.reason || "closed_by_app");
      }
    };
    ws.onclose = () => {
      this.connected = false;
      if (this.closed) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 10_000);
    };
    ws.onerror = () => ws.close();
  }

  private sendRaw(buf: ArrayBuffer) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.ws.bufferedAmount < MAX_BUFFERED_BYTES) {
      this.ws.send(buf);
      this.sent++;
      return true;
    }
    return false;
  }

  push(pcm: Int16Array) {
    const seq = this.nextSeq++;
    const buf = encodeFrame(seq, Date.now(), pcm);
    this.frames.push({ seq, buf });
    if (this.frames.length > RESEND_FRAMES) this.frames.shift();
    this.sendRaw(buf);
  }

  control(obj: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  get buffered() {
    return this.frames.length;
  }

  close(stop = false) {
    if (stop) this.control({ t: "stop", reason: "user" });
    this.closed = true;
    setTimeout(() => this.ws?.close(), 300);
  }
}

interface Live {
  sessionId: string;
  tabId: number;
  stream: MediaStream | null;
  element: HTMLAudioElement | null;
  src: MediaStreamAudioSourceNode | MediaElementAudioSourceNode;
  gain: GainNode;
  tap: AudioWorkletNode;
  pipe: IngestPipe;
  levelDb: number;
}

const live = new Map<string, Live>();

function stop(s: Live, reason: string, tellApp: boolean) {
  live.delete(s.sessionId);
  s.stream?.getTracks().forEach((t) => t.stop());
  s.element?.pause();
  s.tap.port.onmessage = null;
  s.src.disconnect();
  s.gain.disconnect();
  s.tap.disconnect();
  s.pipe.close(tellApp);
  chrome.runtime.sendMessage({ type: "offscreen-ended", sessionId: s.sessionId, tabId: s.tabId, reason }).catch(() => {});
}

async function wire(sessionId: string, tabId: number, port: number, token: string, src: MediaStreamAudioSourceNode | MediaElementAudioSourceNode, stream: MediaStream | null, element: HTMLAudioElement | null, muted = false) {
  const ac = await audioContext();
  const gain = ac.createGain();
  gain.gain.value = muted ? 0 : 1;
  src.connect(gain).connect(ac.destination); // a captured tab is muted for the user: play it back
  const tap = new AudioWorkletNode(ac, "pcm-tap", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: "explicit" });
  src.connect(tap);
  const entry: Live = {
    sessionId,
    tabId,
    stream,
    element,
    src,
    gain,
    tap,
    levelDb: -120,
    pipe: new IngestPipe(sessionId, port, token, (reason) => {
      const s = live.get(sessionId);
      if (s) stop(s, reason, false);
    }),
  };
  tap.port.onmessage = (e) => {
    if (e.data.kind === "pcm") entry.pipe.push(new Int16Array(e.data.buf));
    else if (e.data.kind === "level") entry.levelDb = e.data.db;
  };
  stream?.getAudioTracks()[0]?.addEventListener("ended", () => {
    const s = live.get(sessionId);
    if (s) stop(s, "track_ended", true);
  });
  live.set(sessionId, entry);
}

async function start(msg: Extract<OffscreenMsg, { type: "start" }>) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: msg.streamId } } as any,
    video: false,
  });
  const ac = await audioContext();
  await wire(msg.sessionId, msg.tabId, msg.port, msg.token, ac.createMediaStreamSource(stream), stream, null, msg.muted);
}

async function startElement(msg: Extract<OffscreenMsg, { type: "start-element" }>) {
  const ac = await audioContext();
  const el = new Audio(msg.audioUrl);
  el.crossOrigin = "anonymous";
  const src = ac.createMediaElementSource(el);
  await wire(msg.sessionId, msg.tabId, msg.port, msg.token, src, null, el, true);
  el.onended = () => {
    const s = live.get(msg.sessionId);
    if (s) setTimeout(() => stop(s, "ended", true), 1500);
  };
  await el.play();
}

function byTab(tabId: number): Live | undefined {
  return [...live.values()].find((s) => s.tabId === tabId);
}

chrome.runtime.onMessage.addListener((msg: OffscreenMsg, _sender, reply) => {
  if (msg?.target !== "offscreen") return false;
  (async () => {
    switch (msg.type) {
      case "start":
        await start(msg);
        return { ok: true };
      case "start-element":
        await startElement(msg);
        return { ok: true };
      case "stop": {
        const s = msg.sessionId ? live.get(msg.sessionId) : msg.tabId !== undefined ? byTab(msg.tabId) : undefined;
        if (s) stop(s, msg.reason, true);
        return { ok: true };
      }
      case "mark": {
        const s = byTab(msg.tabId);
        const m: MediaMark = msg.mark;
        s?.pipe.control({ t: "media_mark", ...m });
        return { ok: true };
      }
      case "navigation":
        byTab(msg.tabId)?.pipe.control({ t: "navigation", url: msg.url, title: msg.title });
        return { ok: true };
      case "mute": {
        const s = live.get(msg.sessionId);
        if (s) s.gain.gain.value = msg.muted ? 0 : 1;
        return { ok: true };
      }
      case "list":
        return [...live.values()].map<OffscreenSession>((s) => ({
          sessionId: s.sessionId,
          tabId: s.tabId,
          levelDb: s.levelDb,
          connected: s.pipe.connected,
          sentFrames: s.pipe.sent,
          bufferedFrames: s.pipe.buffered,
          muted: s.gain.gain.value === 0,
        }));
    }
  })().then(reply, (e) => reply({ error: String(e) }));
  return true;
});
