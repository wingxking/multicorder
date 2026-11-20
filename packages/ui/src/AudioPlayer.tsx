import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import Hover from "wavesurfer.js/dist/plugins/hover.esm.js";
import Regions from "wavesurfer.js/dist/plugins/regions.esm.js";
import Timeline from "wavesurfer.js/dist/plugins/timeline.esm.js";
import { fmtTs } from "./api";
import { Icon } from "./icons";
import { t, tError } from "./i18n";

export type Marker = { id: string; at_ms: number; label?: string | null };
export type PlayerHandle = { toggle: () => void };
type Selection = { start: number; end: number };

const RATES = [0.75, 1, 1.25, 1.5, 2];
const SKIP_SECONDS = 5;
const PREFS_KEY = "multicorder.player";
const MARKER_PREFIX = "marker-";

const cssVar = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

const colors = () => ({
  waveColor: cssVar("--text-3", "#8d8d98"),
  progressColor: cssVar("--primary", "#3e63dd"),
  cursorColor: cssVar("--primary", "#3e63dd"),
});

function loadPrefs(): { volume: number; rate: number } {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    return {
      volume: typeof saved.volume === "number" ? Math.min(1, Math.max(0, saved.volume)) : 1,
      rate: RATES.includes(saved.rate) ? saved.rate : 1,
    };
  } catch {
    return { volume: 1, rate: 1 };
  }
}

function savePrefs(prefs: { volume: number; rate: number }) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // A preference that isn't remembered is harmless.
  }
}

/** Calls `onChange` whenever the app's light/dark theme flips (the user's choice or the OS setting). */
function useThemeChange(onChange: () => void) {
  const callback = useRef(onChange);
  callback.current = onChange;
  useEffect(() => {
    const fire = () => callback.current();
    const observer = new MutationObserver(fire);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", fire);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", fire);
    };
  }, []);
}

/** The one player that is currently playing, so starting another pauses it. */
let activePlayer: WaveSurfer | null = null;

/**
 * Waveform player for a saved recording: click or drag on the waveform to seek, skip, speed and
 * volume, markers from the recording, and (when `editing`) a selection that can be played or exported.
 */
const AudioPlayer = forwardRef<PlayerHandle, {
  audio: Blob;
  markers: Marker[];
  editing: boolean;
  autoPlay?: boolean;
  onPlayingChange?: (playing: boolean) => void;
  onExport: (startMs: number, endMs: number) => Promise<void>;
  onError: (message: string) => void;
}>(function AudioPlayer({ audio, markers, editing, autoPlay, onPlayingChange, onExport, onError }, ref) {
  const container = useRef<HTMLDivElement>(null);
  const player = useRef<WaveSurfer | null>(null);
  const regions = useRef<Regions | null>(null);
  const [prefs, setPrefs] = useState(loadPrefs);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onPlaying = useRef(onPlayingChange);
  onPlaying.current = onPlayingChange;

  useEffect(() => {
    if (!container.current) return;
    const regionPlugin = Regions.create();
    const initial = loadPrefs();
    const waveform = WaveSurfer.create({
      container: container.current,
      height: 56,
      ...colors(),
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      dragToSeek: true,
      plugins: [
        Timeline.create({ height: 16, style: { color: cssVar("--text-3", "#8d8d98"), fontSize: "10px" } }),
        Hover.create({ lineColor: cssVar("--text-2", "#5c5c66"), lineWidth: 1, labelBackground: cssVar("--surface-3", "#e9e9ec"), labelColor: cssVar("--text", "#1b1b1f"), labelSize: 10, formatTimeCallback: (seconds) => fmtTs(seconds * 1000) }),
        regionPlugin,
      ],
    });
    waveform.setVolume(initial.volume);
    waveform.setPlaybackRate(initial.rate, true);
    player.current = waveform;
    regions.current = regionPlugin;
    const isMarker = (id: string) => id.startsWith(MARKER_PREFIX);
    regionPlugin.on("region-created", (region) => {
      if (isMarker(region.id)) return;
      regionPlugin.getRegions().forEach((old) => { if (old !== region && !isMarker(old.id)) old.remove(); });
      setSelection({ start: region.start, end: region.end });
    });
    regionPlugin.on("region-updated", (region) => { if (!isMarker(region.id)) setSelection({ start: region.start, end: region.end }); });
    regionPlugin.on("region-clicked", (region, event) => {
      if (!isMarker(region.id)) return;
      event.stopPropagation();
      waveform.setTime(region.start);
    });
    waveform.on("ready", (seconds) => {
      setDuration(seconds);
      if (autoPlay) void waveform.play().catch((failure) => onError(tError(failure)));
    });
    waveform.on("timeupdate", setTime);
    waveform.on("play", () => {
      if (activePlayer && activePlayer !== waveform) activePlayer.pause();
      activePlayer = waveform;
      setPlaying(true);
      onPlaying.current?.(true);
    });
    waveform.on("pause", () => { setPlaying(false); onPlaying.current?.(false); });
    waveform.on("finish", () => { setPlaying(false); onPlaying.current?.(false); });
    waveform.on("error", (failure) => setError(tError(failure)));
    let current = true;
    void waveform.loadBlob(audio).catch((failure) => { if (current) setError(tError(failure)); });
    return () => {
      current = false;
      if (activePlayer === waveform) activePlayer = null;
      onPlaying.current?.(false);
      waveform.destroy();
      player.current = null;
      regions.current = null;
    };
    // autoPlay and onError are only read for the first load of this audio.
  }, [audio]);

  // Markers become point regions once the audio has loaded (and again if they change).
  useEffect(() => {
    const plugin = regions.current;
    if (!plugin || !duration) return;
    plugin.getRegions().forEach((region) => { if (region.id.startsWith(MARKER_PREFIX)) region.remove(); });
    const color = cssVar("--warn", "#c27c00");
    for (const marker of markers) {
      const start = marker.at_ms / 1000;
      if (start > duration) continue;
      const content = document.createElement("span");
      content.className = "player-marker";
      content.textContent = marker.label || "";
      content.title = `${t("Marker")} ${fmtTs(marker.at_ms)}${marker.label ? ` · ${marker.label}` : ""}`;
      plugin.addRegion({ id: `${MARKER_PREFIX}${marker.id}`, start, color, content, drag: false, resize: false });
    }
  }, [markers, duration]);

  // Selecting a clip by dragging is only on while editing.
  useEffect(() => {
    const plugin = regions.current;
    if (!plugin || !editing) return;
    // Dragging selects here instead of seeking; a click still seeks.
    player.current?.setOptions({ dragToSeek: false });
    const disable = plugin.enableDragSelection({ color: "rgba(62,99,221,0.22)", minLength: 0.05 }, 6);
    return () => {
      disable();
      player.current?.setOptions({ dragToSeek: true });
      plugin.getRegions().forEach((region) => { if (!region.id.startsWith(MARKER_PREFIX)) region.remove(); });
      setSelection(null);
      player.current?.zoom(0);
      setZoom(1);
    };
  }, [editing, duration]);

  useThemeChange(() => {
    player.current?.setOptions(colors());
  });

  const toggle = (range?: Selection) => {
    const waveform = player.current;
    if (!waveform || !duration) return;
    if (waveform.isPlaying() && !range) waveform.pause();
    else void waveform.play(range?.start, range?.end).catch((failure) => onError(tError(failure)));
  };
  useImperativeHandle(ref, () => ({ toggle: () => toggle() }));

  const updatePrefs = (next: { volume: number; rate: number }) => {
    setPrefs(next);
    savePrefs(next);
  };

  async function exportSelection() {
    if (!selection) return;
    setSaving(true);
    try {
      await onExport(Math.floor(selection.start * 1000), Math.ceil(selection.end * 1000));
    } catch (failure) {
      onError(tError(failure));
    } finally {
      setSaving(false);
    }
  }

  function onKeyDown(event: React.KeyboardEvent) {
    const target = event.target as HTMLElement;
    if (event.metaKey || event.ctrlKey || event.altKey || target.matches("input, select, textarea")) return;
    const waveform = player.current;
    if (!waveform || !duration) return;
    if (event.key === " " && !target.matches("button")) {
      event.preventDefault();
      event.stopPropagation();
      toggle();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      waveform.skip(event.key === "ArrowLeft" ? -SKIP_SECONDS : SKIP_SECONDS);
    }
  }

  const rateIndex = RATES.indexOf(prefs.rate);
  return (
    <section className="audio-player" aria-label={editing ? t("Waveform editor") : t("Audio player")} tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="player-wave" ref={container} />
      {error && <p className="banner warn" role="alert">{error}</p>}
      {!error && duration === 0 && <p className="small muted" role="status">{t("Loading waveform…")}</p>}
      <div className="player-controls">
        <button className="btn icon-btn player-play" disabled={!duration} aria-label={playing ? t("Pause") : t("Play")} title={playing ? t("Pause") : t("Play")} onClick={() => toggle()}>
          <Icon name={playing ? "pause" : "play"} />
        </button>
        <button className="btn btn-ghost icon-btn" disabled={!duration} aria-label={t("Back {seconds} seconds", { seconds: SKIP_SECONDS })} title={t("Back {seconds} seconds", { seconds: SKIP_SECONDS })} onClick={() => player.current?.skip(-SKIP_SECONDS)}><Icon name="skipBack" /></button>
        <button className="btn btn-ghost icon-btn" disabled={!duration} aria-label={t("Forward {seconds} seconds", { seconds: SKIP_SECONDS })} title={t("Forward {seconds} seconds", { seconds: SKIP_SECONDS })} onClick={() => player.current?.skip(SKIP_SECONDS)}><Icon name="skipForward" /></button>
        <span className="player-time" aria-live="off">{fmtTs(time * 1000)} <span className="muted">/ {fmtTs(duration * 1000)}</span></span>
        <span className="grow" />
        <button className="btn btn-ghost btn-sm player-rate" aria-label={t("Playback speed {rate}×", { rate: prefs.rate })} title={t("Playback speed")} onClick={() => {
          const rate = RATES[(rateIndex + 1) % RATES.length];
          player.current?.setPlaybackRate(rate, true);
          updatePrefs({ ...prefs, rate });
        }}>{prefs.rate}×</button>
        <button className="btn btn-ghost icon-btn" aria-label={muted ? t("Unmute") : t("Mute")} title={muted ? t("Unmute") : t("Mute")} aria-pressed={muted} onClick={() => {
          player.current?.setMuted(!muted);
          setMuted(!muted);
        }}><Icon name={muted || prefs.volume === 0 ? "mute" : "speaker"} /></button>
        <input className="player-volume" type="range" min={0} max={1} step={0.05} value={muted ? 0 : prefs.volume} aria-label={t("Volume")} onChange={(event) => {
          const volume = Number(event.target.value);
          player.current?.setVolume(volume);
          if (muted) { player.current?.setMuted(false); setMuted(false); }
          updatePrefs({ ...prefs, volume });
        }} />
      </div>
      {editing && <div className="player-controls player-edit">
        {selection ? <>
          <span className="ts">{fmtTs(selection.start * 1000)}–{fmtTs(selection.end * 1000)} · {(selection.end - selection.start).toFixed(1)} s</span>
          <button className="btn btn-sm" onClick={() => toggle(selection)}><Icon name="play" size={13} />{t("Play selection")}</button>
          <button className="btn btn-sm" disabled={saving} onClick={() => void exportSelection()}><Icon name="download" size={13} />{t("Export selection")}</button>
          <button className="btn btn-sm btn-ghost" onClick={() => {
            regions.current?.getRegions().forEach((region) => { if (!region.id.startsWith(MARKER_PREFIX)) region.remove(); });
            setSelection(null);
          }}>{t("Clear")}</button>
        </> : <span className="small muted">{t("Drag across the waveform to select a clip.")}</span>}
        <span className="grow" />
        <label className="player-zoom">{t("Zoom")} <input type="range" min={1} max={8} step={1} value={zoom} disabled={!duration} onChange={(event) => {
          const next = Number(event.target.value);
          setZoom(next);
          const fitted = (container.current?.clientWidth ?? 0) / duration;
          player.current?.zoom(next === 1 ? 0 : fitted * next);
        }} /></label>
      </div>}
    </section>
  );
});

export default AudioPlayer;
