// Injected only into whitelisted video sites when the user starts recording that tab (activeTab).
// Reports the video timeline so every audio frame can be mapped to video time (design 5.6).
// Reads only <video> state and the page URL. It is also the bridge for captions-page.ts, which
// runs in the page's own world and cannot reach the extension directly.

import { CaptionMsg, PAGE_TAG } from "./captions/core";

declare global {
  interface Window {
    __mcClock?: boolean;
  }
}

(() => {
  if (window.__mcClock) return;
  window.__mcClock = true;

  function videoKey(): string | null {
    const u = new URL(location.href);
    if (/(^|\.)youtube\.com$/.test(u.hostname)) {
      const v = u.searchParams.get("v");
      if (v) return `youtube:${v}`;
      const m = u.pathname.match(/^\/live\/([^/?#]+)/);
      if (m) return `youtube:${m[1]}`;
    }
    if (u.hostname === "youtu.be") return `youtube:${u.pathname.slice(1)}`;
    const b = u.pathname.match(/\/video\/(BV[\w]+)/);
    if (/(^|\.)bilibili\.com$/.test(u.hostname) && b) return `bilibili:${b[1]}`;
    return null;
  }

  function pick(): HTMLVideoElement | null {
    const vids = [...document.querySelectorAll("video")];
    if (!vids.length) return null;
    const playing = vids.filter((v) => !v.paused);
    const pool = playing.length ? playing : vids;
    return pool.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  }

  const events = ["play", "pause", "seeked", "ratechange"];
  let timer: ReturnType<typeof setInterval> | undefined;

  /** After the extension is reloaded or updated, this copy can no longer reach it: stop quietly
   *  and let the new version inject itself again. */
  function retire() {
    clearInterval(timer);
    for (const ev of events) document.removeEventListener(ev, send, true);
    window.removeEventListener("message", relay);
    window.__mcClock = false;
  }

  /** Subtitle cues and state from captions-page.ts → the extension. */
  function relay(e: MessageEvent) {
    if (e.source !== window || !e.data || typeof e.data !== "object") return;
    const msg = (e.data as Record<string, unknown>)[PAGE_TAG] as CaptionMsg | undefined;
    if (!msg || (msg.kind !== "cue" && msg.kind !== "state")) return;
    if (msg.kind === "cue" && (typeof msg.text !== "string" || !Number.isFinite(msg.wall_ms) || !Number.isFinite(msg.dur_ms))) return;
    if (!chrome.runtime?.id) return retire();
    try {
      chrome.runtime.sendMessage({ type: "caption", msg }).catch((error: unknown) => { if (/context invalidated/i.test(String(error))) retire(); });
    } catch {
      retire();
    }
  }
  window.addEventListener("message", relay);
  chrome.runtime.onMessage.addListener((m: { type?: string }) => {
    if (m?.type === "caption-stop") window.postMessage({ "mc-caption-stop": true }, location.origin);
  });

  function send() {
    if (!chrome.runtime?.id) return retire();
    const v = pick();
    if (!v) return;
    const live = !isFinite(v.duration) || !!document.querySelector(".ytp-live-badge:not([disabled])");
    try {
      chrome.runtime
        .sendMessage({
          type: "media_mark",
          mark: { wall_ms: Date.now(), media_ms: isFinite(v.currentTime) ? Math.round(v.currentTime * 1000) : null, paused: v.paused, rate: v.playbackRate, live, video_key: videoKey() },
        })
        .catch((error: unknown) => { if (/context invalidated/i.test(String(error))) retire(); });
    } catch {
      retire(); // "Extension context invalidated" is thrown synchronously
    }
  }

  for (const ev of events) document.addEventListener(ev, send, true);
  timer = setInterval(send, 1000);
  send();
})();

export {};
