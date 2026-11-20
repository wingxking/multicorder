// Injected into the page's own JavaScript world (chrome.scripting world "MAIN") while a tab on a
// supported video site is recorded and the text source allows subtitles. It finds the subtitles
// the platform already serves to this browser, then plays them out in step with the video, so
// the recording's text matches what the user heard. It only reads what the page's own player
// loads with the user's own session; nothing is downloaded elsewhere.
//
// Talks to the extension through window.postMessage → media-clock.ts (isolated world).

import { CaptionMsg, CaptionSource, Cue, CuePlayer, LineAssembler, PAGE_TAG, parseAny, parseBilibili, parseYouTubeJson3, pickBilibiliTrack, pickByteDanceTrack, pickYouTubeTrack } from "./captions/core";

declare global {
  interface Window {
    __mcCaptions?: { stop: () => void };
  }
}

type Mode =
  | { mode: "track"; source: CaptionSource; player: CuePlayer }
  | { mode: "dom"; source: CaptionSource; lines: () => string[]; assembler: LineAssembler; lastText: number; restore?: () => void }
  | { mode: "texttrack"; source: CaptionSource; track: TextTrack; player: CuePlayer; count: number }
  | { mode: "none" };

(() => {
  if (window.__mcCaptions) return;

  const post = (msg: CaptionMsg) => window.postMessage({ [PAGE_TAG]: msg }, location.origin);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const host = location.hostname;
  const on = (re: RegExp) => re.test(host);

  function videoKey(): string | null {
    const u = new URL(location.href);
    if (on(/(^|\.)youtube\.com$/)) {
      // Channel pages such as /@name/live carry no id in the address: ask the player.
      const v = u.searchParams.get("v") ?? u.pathname.match(/^\/(?:live|shorts)\/([^/?#]+)/)?.[1]
        ?? (document.getElementById("movie_player") as { getPlayerResponse?: () => any } | null)?.getPlayerResponse?.()?.videoDetails?.videoId;
      return v ? `youtube:${v}` : null;
    }
    if (on(/(^|\.)bilibili\.com$/)) {
      const bv = u.pathname.match(/\/video\/(BV\w+)/)?.[1];
      return bv ? `bilibili:${bv}:${u.searchParams.get("p") ?? "1"}` : null;
    }
    const bd = u.pathname.match(/\/video\/(\d+)/)?.[1] ?? u.searchParams.get("modal_id");
    if (on(/(^|\.)tiktok\.com$/) && bd) return `tiktok:${bd}`;
    if (on(/(^|\.)douyin\.com$/) && bd) return `douyin:${bd}`;
    return `web:${u.origin}${u.pathname}`;
  }

  function pickVideo(): HTMLVideoElement | null {
    const vids = [...document.querySelectorAll("video")];
    const playing = vids.filter((v) => !v.paused);
    return (playing.length ? playing : vids).sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0] ?? null;
  }

  // Requests the page's own player makes. Sites clear the resource-timing buffer, so an observer
  // keeps the ones that matter as they happen.
  const seen: string[] = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (/timedtext|\/x\/player\/|aweme|item\/detail/.test(e.name)) seen.push(e.name);
      if (seen.length > 200) seen.splice(0, seen.length - 200);
    }).observe({ type: "resource", buffered: true });
  } catch { /* no PerformanceObserver: fall back to the buffer */ }
  const resources = () => [...new Set([...performance.getEntriesByType("resource").map((e) => e.name), ...seen])];

  // ---------- YouTube ----------
  type YtPlayer = HTMLElement & {
    getPlayerResponse?: () => any;
    getOption?: (m: string, k: string) => any;
    setOption?: (m: string, k: string, v: unknown) => void;
    loadModule?: (m: string) => void;
    unloadModule?: (m: string) => void;
  };
  const ytPlayer = () => document.getElementById("movie_player") as YtPlayer | null;

  /**
   * Makes the player load captions now (so it sends a fresh signed request): turns them on, or
   * reloads them if they are on. Returns a function that puts the user's setting back.
   */
  function ytEnsureCaptions(p: YtPlayer, languageCode: string, hide: boolean): () => void {
    const before = (() => { try { return p.getOption?.("captions", "track"); } catch { return null; } })();
    const wasOn = !!before?.languageCode;
    let style: HTMLStyleElement | null = null;
    if (!wasOn && hide) {
      style = document.createElement("style");
      style.textContent = "#movie_player .ytp-caption-window-container{opacity:0!important}";
      document.head.append(style);
    }
    try {
      if (wasOn) p.unloadModule?.("captions");
      p.loadModule?.("captions");
      p.setOption?.("captions", "track", wasOn ? before : { languageCode });
    } catch { /* player API changed: captions stay as they were */ }
    return () => {
      style?.remove();
      if (wasOn) return;
      try {
        p.unloadModule?.("captions");
      } catch { /* ignore */ }
    };
  }

  /** The player's own signed timedtext request (it carries the PO token YouTube now requires). */
  function ytSignedUrl(videoId: string): string | undefined {
    return resources().reverse().find((u) => u.includes("/api/timedtext") && u.includes(`v=${videoId}`) && u.includes("pot="));
  }

  async function youtube(): Promise<Mode | null> {
    const p = ytPlayer();
    const pr = p?.getPlayerResponse?.();
    const videoId: string | undefined = pr?.videoDetails?.videoId;
    if (!p || !videoId) return null;
    const list = pr?.captions?.playerCaptionsTracklistRenderer;
    const tracks: { languageCode: string; kind?: string }[] = list?.captionTracks ?? [];
    const languages = [...new Set(tracks.map((t) => t.languageCode))];
    if (pr?.videoDetails?.isLive) {
      // Live: broadcast captions are only rendered in the player's caption window.
      const restore = ytEnsureCaptions(p, tracks[0]?.languageCode ?? "en", true);
      return {
        mode: "dom", restore, assembler: new LineAssembler(), lastText: 0,
        source: { platform: "youtube", kind: "live", lang: tracks[0]?.languageCode ?? null, languages },
        lines: () => [...document.querySelectorAll("#movie_player .caption-visual-line")].map((l) => l.textContent ?? ""),
      };
    }
    const audio = list?.audioTracks?.[list?.defaultAudioTrackIndex ?? 0];
    const choice = pickYouTubeTrack(tracks, audio?.defaultCaptionTrackIndex);
    if (!choice) return null;
    let signed = ytSignedUrl(videoId);
    if (!signed) {
      const restore = ytEnsureCaptions(p, choice.track.languageCode, true);
      for (let i = 0; i < 24 && !signed; i++) {
        await sleep(250);
        signed = ytSignedUrl(videoId);
      }
      restore();
    }
    if (!signed) return null;
    const url = new URL(signed);
    url.searchParams.set("lang", choice.track.languageCode);
    url.searchParams.set("fmt", "json3");
    url.searchParams.delete("tlang");
    if (choice.kind === "auto") url.searchParams.set("kind", "asr");
    else url.searchParams.delete("kind");
    const res = await fetch(url, { credentials: "include" });
    const cues = parseYouTubeJson3(await res.json().catch(() => null));
    if (!cues.length) return null;
    return { mode: "track", player: new CuePlayer(cues), source: { platform: "youtube", kind: choice.kind, lang: choice.track.languageCode, languages } };
  }

  // ---------- Bilibili ----------
  async function bilibili(): Promise<Mode | null> {
    const cid = (window as any).__INITIAL_STATE__?.videoData?.cid;
    // The player's own subtitle-list request: WBI-signed and sent with the user's login.
    const req = resources().reverse().find((u) => u.includes("/x/player/wbi/v2") && (!cid || u.includes(`cid=${cid}`)))
      ?? resources().reverse().find((u) => u.includes("/x/player/wbi/v2"));
    if (!req) return null;
    const json = await fetch(req, { credentials: "include" }).then((r) => r.json()).catch(() => null);
    const tracks = (json?.data?.subtitle?.subtitles ?? []) as { lan: string; subtitle_url?: string; ai_type?: number }[];
    const choice = pickBilibiliTrack(tracks);
    if (!choice) return null;
    const href = choice.track.subtitle_url!.startsWith("//") ? `https:${choice.track.subtitle_url}` : choice.track.subtitle_url!;
    const cues = parseBilibili(await fetch(href).then((r) => r.json()).catch(() => null));
    if (!cues.length) return null;
    return { mode: "track", player: new CuePlayer(cues), source: { platform: "bilibili", kind: choice.kind, lang: choice.track.lan.replace(/^ai-/, ""), languages: tracks.map((t) => t.lan) } };
  }

  // ---------- TikTok / Douyin (ByteDance) ----------
  /** Finds caption track lists anywhere in the page's embedded data for the current video. */
  function byteDanceTracks(root: unknown, id: string): { lang: string; url: string; source?: string }[] {
    const out: { lang: string; url: string; source?: string }[] = [];
    const seen = new Set<unknown>();
    const walk = (node: any, inVideo: boolean, depth: number) => {
      if (!node || typeof node !== "object" || seen.has(node) || depth > 14) return;
      seen.add(node);
      const here = inVideo || String(node.id ?? node.aweme_id ?? node.awemeId ?? "") === id;
      if (here) {
        for (const s of node.subtitleInfos ?? node.subtitle_infos ?? []) {
          const url = s.Url ?? s.url ?? s.url_list?.[0];
          if (url) out.push({ lang: s.LanguageCodeName ?? s.language_code_name ?? s.LanguageCode ?? "", url, source: s.Source ?? s.source });
        }
        for (const c of node.captionInfos ?? node.caption_infos ?? []) {
          const url = c.url ?? c.Url ?? c.urlList?.[0] ?? c.url_list?.[0];
          if (url) out.push({ lang: c.language ?? c.lang ?? c.languageCode ?? "", url, source: c.isAutoGen === false || c.is_auto_generated === false ? "CREATOR" : "ASR" });
        }
      }
      for (const v of Object.values(node)) walk(v, here, depth + 1);
    };
    walk(root, false, 0);
    return out;
  }

  function embeddedData(): unknown[] {
    const roots: unknown[] = [];
    for (const id of ["__UNIVERSAL_DATA_FOR_REHYDRATION__", "SIGI_STATE", "RENDER_DATA"]) {
      const el = document.getElementById(id);
      if (!el?.textContent) continue;
      try {
        roots.push(JSON.parse(id === "RENDER_DATA" ? decodeURIComponent(el.textContent) : el.textContent));
      } catch { /* not JSON */ }
    }
    return roots;
  }

  async function byteDance(platform: "tiktok" | "douyin"): Promise<Mode | null> {
    const id = videoKey()?.split(":")[1];
    if (!id) return null;
    let tracks = embeddedData().flatMap((root) => byteDanceTracks(root, id));
    if (!tracks.length) {
      // The detail request the page already made for this video (same URL, same signature).
      const req = resources().reverse().find((u) => /aweme\/v1\/web\/aweme\/detail|api\/item\/detail/.test(u) && u.includes(id));
      if (req) tracks = byteDanceTracks(await fetch(req, { credentials: "include" }).then((r) => r.json()).catch(() => null), id);
    }
    const choice = pickByteDanceTrack(tracks);
    if (!choice) return null;
    const cues = parseAny(await fetch(choice.track.url).then((r) => r.text()).catch(() => ""));
    if (!cues.length) return null;
    return { mode: "track", player: new CuePlayer(cues), source: { platform, kind: choice.kind, lang: choice.track.lang || null, languages: [...new Set(tracks.map((t) => t.lang))] } };
  }

  // ---------- Any site: the media element's own text tracks ----------
  function textTracks(): Mode | null {
    const video = pickVideo();
    const list = [...(video?.textTracks ?? [])].filter((t) => t.kind === "subtitles" || t.kind === "captions");
    const track = list.find((t) => t.mode === "showing") ?? list[0];
    if (!track) return null;
    if (track.mode === "disabled") track.mode = "hidden"; // loads cues without showing them
    return { mode: "texttrack", track, count: -1, player: new CuePlayer([]), source: { platform: "web", kind: "creator", lang: track.language || null, languages: list.map((t) => t.language).filter(Boolean) } };
  }

  function cuesOf(track: TextTrack): Cue[] {
    return [...(track.cues ?? [])].map((c) => ({ start: c.startTime * 1000, end: c.endTime * 1000, text: (c as VTTCue).text ?? "" }));
  }

  async function detect(): Promise<Mode> {
    try {
      const found = on(/(^|\.)youtube\.com$/) ? await youtube()
        : on(/(^|\.)bilibili\.com$/) ? await bilibili()
        : on(/(^|\.)tiktok\.com$/) ? await byteDance("tiktok")
        : on(/(^|\.)douyin\.com$/) ? await byteDance("douyin")
        : null;
      return found ?? textTracks() ?? { mode: "none" };
    } catch {
      return textTracks() ?? { mode: "none" };
    }
  }

  // ---------- Loop ----------
  let key: string | null = null;
  let current: Mode = { mode: "none" };
  let detecting = false;
  let stopped = false;
  let lastState = "";
  let stateAt = 0;
  let retries = 0;
  let nextDetect = 0;

  // YouTube ads play in the same <video>; nothing is detected or emitted while one is showing.
  const adShowing = () => !!document.querySelector("#movie_player.ad-showing, #movie_player.ad-interrupting");

  function emitCue(text: string, wallMs: number, durMs: number, source: CaptionSource) {
    if (text) post({ kind: "cue", wall_ms: Math.round(wallMs), dur_ms: Math.max(1, Math.round(durMs)), text: text.slice(0, 2000), source });
  }

  function tick() {
    if (stopped) return;
    const now = Date.now();
    const k = videoKey();
    if (k !== key) {
      key = k;
      if (current.mode === "dom") current.restore?.();
      current = { mode: "none" };
      retries = 0;
      nextDetect = now + 1500; // give the player a moment to load the new video's data
    }
    if (current.mode === "none" && !detecting && now >= nextDetect && !adShowing()) {
      detecting = true;
      const forKey = key;
      void detect().then((m) => {
        detecting = false;
        retries++;
        // A few quick tries while the page settles, then a slow check (sign-in, late player data).
        nextDetect = Date.now() + (retries < 4 ? 3000 : 20000);
        if (stopped || forKey !== key) { if (m.mode === "dom") m.restore?.(); return; }
        current = m;
      });
    }
    const video = pickVideo();
    const playing = !!video && !video.paused && !video.ended && !adShowing();
    let active = false;
    if (current.mode === "track" || current.mode === "texttrack") {
      if (current.mode === "texttrack") {
        const cues = cuesOf(current.track);
        if (cues.length !== current.count) {
          current.count = cues.length;
          current.player.cues = cues.map((c) => ({ ...c, text: c.text.replace(/<[^>]+>/g, "") })).sort((a, b) => a.start - b.start);
        }
      }
      active = playing && current.player.cues.length > 0;
      if (playing && video) {
        const at = video.currentTime * 1000;
        const rate = video.playbackRate || 1;
        for (const c of current.player.due(at, rate)) emitCue(c.text, now - (at - c.start) / rate, (c.end - c.start) / rate, current.source);
      }
    } else if (current.mode === "dom") {
      const snapshot = current.lines();
      if (snapshot.some((l) => l.trim())) current.lastText = now;
      for (const line of current.assembler.push(snapshot, now)) emitCue(line.text, line.start, line.end - line.start, current.source);
      // Broadcast captions come and go; without any for 10 s the recording falls back to speech recognition.
      active = playing && now - current.lastText < 10000;
    }
    const source = current.mode === "none" ? null : current.source;
    const state = JSON.stringify([active, source, key]);
    if (state !== lastState || now - stateAt >= 1000) {
      lastState = state;
      stateAt = now;
      post({ kind: "state", active, source, video_key: key });
    }
  }

  const timer = setInterval(tick, 250);
  window.__mcCaptions = {
    stop() {
      stopped = true;
      clearInterval(timer);
      if (current.mode === "dom") current.restore?.();
      post({ kind: "state", active: false, source: null, video_key: key });
      window.__mcCaptions = undefined;
    },
  };
  // The extension asks the page script to stop (recording ended) through the isolated-world bridge.
  window.addEventListener("message", (e) => {
    if (e.source === window && (e.data as Record<string, unknown>)?.["mc-caption-stop"]) window.__mcCaptions?.stop();
  });
  tick();
})();

export {};
