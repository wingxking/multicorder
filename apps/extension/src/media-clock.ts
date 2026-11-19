// Injected only into whitelisted video sites when the user starts recording that tab (activeTab).
// Reports the video timeline so every audio frame can be mapped to video time (design 5.6).
// Reads only <video> state and the page URL.

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

  function send() {
    const v = pick();
    if (!v) return;
    const live = !isFinite(v.duration) || !!document.querySelector(".ytp-live-badge:not([disabled])");
    chrome.runtime
      .sendMessage({
        type: "media_mark",
        mark: { wall_ms: Date.now(), media_ms: isFinite(v.currentTime) ? Math.round(v.currentTime * 1000) : null, paused: v.paused, rate: v.playbackRate, live, video_key: videoKey() },
      })
      .catch(() => {});
  }

  for (const ev of ["play", "pause", "seeked", "ratechange"]) document.addEventListener(ev, send, true);
  setInterval(send, 1000);
  send();
})();

export {};
