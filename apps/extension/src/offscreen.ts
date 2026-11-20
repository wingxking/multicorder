// Offscreen document (USER_MEDIA): one shared 48 kHz AudioContext; per tab an independent node
// chain (source → gain → speakers, source → pcm-tap worklet). Each recording goes either to the
// Mac app over WebSocket ("app" backend, design 5.4–5.5) or to the built-in standalone engine
// ("local" backend, design 5.11).

import { LocalEngine } from "./local/engine";
import { encodeFrame, MediaMark, OffscreenMsg, OffscreenSession, PRE_ROLL_MS } from "./protocol";

const RESEND_FRAMES = 600; // 60 s
const MAX_BUFFERED_BYTES = 512 * 1024;

let contextReady: Promise<AudioContext> | undefined;
async function audioContext(): Promise<AudioContext> {
  contextReady ??= (async () => {
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: "playback" });
    await ctx.audioWorklet.addModule("pcm-tap.worklet.js");
    return ctx;
  })();
  const ctx = await contextReady;
  if (ctx.state === "suspended") await ctx.resume();
  return ctx;
}

// The service worker resolves which transcription service to use (local Mac service needs the
// native host; offscreen documents can only use chrome.runtime).
const local = new LocalEngine(async () => {
  const r = await chrome.runtime.sendMessage({ type: "resolve-service" });
  if (!r || r.error) throw new Error(r?.error || "service not available");
  return r;
});

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
      ws.send(JSON.stringify({ t: "hello", session_id: this.sessionId, resume_from: this.acked + 1 }));
    };
    ws.onmessage = (m) => {
      if (typeof m.data !== "string") return;
      const msg = JSON.parse(m.data);
      if (msg.t === "hello") {
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
  backend: "app" | "local";
  tabId: number;
  stream: MediaStream | null;
  archiveStream: MediaStream | null;
  archiveDelay: DelayNode | null;
  element: HTMLAudioElement | null;
  src: MediaStreamAudioSourceNode | MediaElementAudioSourceNode;
  gain: GainNode;
  tap: AudioWorkletNode;
  pipe: IngestPipe | null;
  levelDb: number;
}

const live = new Map<string, Live>();

function stop(s: Live, reason: string, tellApp: boolean) {
  live.delete(s.sessionId);
  s.tap.port.onmessage = null;
  s.src.disconnect();
  s.gain.disconnect();
  s.tap.disconnect();
  s.element?.pause();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    s.archiveDelay?.disconnect();
    s.archiveStream?.getTracks().forEach((t) => t.stop());
    if (s.stream !== s.archiveStream) s.stream?.getTracks().forEach((t) => t.stop());
  };
  if (s.backend === "local") {
    // Keep the delayed audio connected until the last samples reach the recorder.
    void local.stop(s.sessionId, reason, s.archiveDelay ? PRE_ROLL_MS : 0, release).catch(console.error).finally(release);
  } else {
    release();
    s.pipe?.close(tellApp);
  }
  chrome.runtime.sendMessage({ type: "offscreen-ended", sessionId: s.sessionId, tabId: s.tabId, reason }).catch(() => {});
}

type StartBase = Omit<Extract<OffscreenMsg, { type: "start" }>, "target" | "type" | "streamId">;

async function wire(opts: StartBase, src: MediaStreamAudioSourceNode | MediaElementAudioSourceNode, stream: MediaStream | null, element: HTMLAudioElement | null): Promise<string> {
  const ac = await audioContext();
  const gain = ac.createGain();
  gain.gain.value = opts.muted ? 0 : 1;
  src.connect(gain).connect(ac.destination); // a captured tab is muted for the user: play it back unless silent
  const tap = new AudioWorkletNode(ac, "pcm-tap", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: "explicit" });
  src.connect(tap);
  let sessionId = opts.sessionId ?? "";
  let pipe: IngestPipe | null = null;
  let archiveStream: MediaStream | null = null;
  let archiveDelay: DelayNode | null = null;
  if (opts.backend === "local") {
    if (!opts.settings) throw new Error("settings missing");
    archiveStream = stream;
    if (opts.waitForAudio || !archiveStream) {
      const dest = ac.createMediaStreamDestination();
      if (opts.waitForAudio) {
        archiveDelay = ac.createDelay();
        archiveDelay.delayTime.value = PRE_ROLL_MS / 1000;
        src.connect(archiveDelay).connect(dest);
      } else {
        src.connect(dest);
      }
      archiveStream = dest.stream;
    }
    sessionId = await local.create({ title: opts.title ?? "Browser tab", url: opts.url, mode: opts.mode, waitForAudio: opts.waitForAudio }, archiveStream, opts.settings);
  } else {
    pipe = new IngestPipe(sessionId, opts.port!, opts.token!, (reason) => {
      const s = live.get(sessionId);
      if (s) stop(s, reason, false);
    });
  }
  const entry: Live = { sessionId, backend: opts.backend, tabId: opts.tabId, stream, archiveStream, archiveDelay, element, src, gain, tap, pipe, levelDb: -120 };
  tap.port.onmessage = (e) => {
    if (e.data.kind === "pcm") {
      const pcm = new Int16Array(e.data.buf);
      entry.levelDb = e.data.db;
      if (entry.pipe) entry.pipe.push(pcm);
      else local.push(sessionId, pcm, entry.levelDb);
    }
  };
  stream?.getAudioTracks()[0]?.addEventListener("ended", () => {
    const s = live.get(sessionId);
    if (s) stop(s, "track_ended", true);
  });
  live.set(sessionId, entry);
  return sessionId;
}

async function start(msg: Extract<OffscreenMsg, { type: "start" }>) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: msg.streamId } } as any,
    video: false,
  });
  try {
    const ac = await audioContext();
    return await wire(msg, ac.createMediaStreamSource(stream), stream, null);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }
}

async function startElement(msg: Extract<OffscreenMsg, { type: "start-element" }>) {
  const ac = await audioContext();
  const el = new Audio(msg.audioUrl);
  el.crossOrigin = "anonymous";
  const src = ac.createMediaElementSource(el);
  const id = await wire({ ...msg, muted: true }, src, null, el);
  el.onended = () => {
    const s = live.get(id);
    if (s) setTimeout(() => stop(s, "ended", true), 1500);
  };
  await el.play();
  return id;
}

function byTab(tabId: number): Live | undefined {
  return [...live.values()].find((s) => s.tabId === tabId);
}

chrome.runtime.onMessage.addListener((msg: OffscreenMsg, _sender, reply) => {
  if (msg?.target !== "offscreen") return false;
  (async () => {
    switch (msg.type) {
      case "start":
        return { sessionId: await start(msg) };
      case "start-element":
        return { sessionId: await startElement(msg) };
      case "stop": {
        const s = msg.sessionId ? live.get(msg.sessionId) : msg.tabId !== undefined ? byTab(msg.tabId) : undefined;
        if (s) stop(s, msg.reason, true);
        return { ok: true };
      }
      case "mark": {
        const s = byTab(msg.tabId);
        const m: MediaMark = msg.mark;
        s?.pipe?.control({ t: "media_mark", ...m });
        return { ok: true };
      }
      case "navigation":
        byTab(msg.tabId)?.pipe?.control({ t: "navigation", url: msg.url, title: msg.title });
        return { ok: true };
      case "mute": {
        const s = live.get(msg.sessionId);
        if (s) s.gain.gain.value = msg.muted ? 0 : 1;
        return { ok: true };
      }
      case "local-mode":
        await local.setMode(msg.sessionId, msg.mode);
        return { ok: true };
      case "local-missed":
        return local.missed(msg.sessionId, msg.minutes);
      case "local-retry":
        return local.retry(msg.sessionId);
      case "local-flush":
        await local.flush(msg.sessionId);
        return { ok: true };
      case "local-retry-all":
        await local.retryAll();
        return { ok: true };
      case "list":
        return [...live.values()].map<OffscreenSession>((s) => ({
          sessionId: s.sessionId,
          backend: s.backend,
          tabId: s.tabId,
          levelDb: s.levelDb,
          connected: s.pipe ? s.pipe.connected : true,
          sentFrames: s.pipe?.sent ?? 0,
          bufferedFrames: s.pipe?.buffered ?? 0,
          muted: s.gain.gain.value === 0,
        }));
    }
  })().then(reply, (e) => reply({ error: String(e) }));
  return true;
});
