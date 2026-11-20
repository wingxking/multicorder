import React, { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from "react";
import { CardState, describeDetail, fmtTs, Icon, locale, Session, SummaryMode, t, tError, WAITING_FOR_AUDIO } from "@multicorder/ui";
import type { Marker, PlayerHandle } from "./AudioPlayer";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
const AudioPlayer = lazy(() => import("./AudioPlayer"));
export type RecordingFormat = { sample_rate: number; bits_per_sample: number };
export const DEFAULT_RECORDING_FORMAT: RecordingFormat = { sample_rate: 16000, bits_per_sample: 16 };
/** Waveform peaks arrive 40 per second; the live strip shows the last 12 seconds. */
export const PEAKS_PER_SECOND = 40;
export const LIVE_PEAK_WINDOW = PEAKS_PER_SECOND * 12;

type Part = "transcript" | "summary";
type TextPreview = Record<Part, string | null>;
export type LiveCard = Omit<CardState, "session"> & { status?: string; peaks?: number[]; peakCount?: number; elapsed?: number; textRevision?: number };

type IconName = Parameters<typeof Icon>[0]["name"];
const iconUrls = new Map<string, Promise<string | null>>();

/** The app's own icon (from its bundle), or a generic one while it loads or if there is none. */
export function AppIcon({ path, invoke, fallback, size = 18 }: { path?: string | null; invoke: Invoke; fallback: IconName; size?: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!path || !("__TAURI_INTERNALS__" in window)) return;
    let current = true;
    if (!iconUrls.has(path)) {
      iconUrls.set(path, invoke<ArrayBuffer>("app_icon", { bundlePath: path })
        .then((bytes) => URL.createObjectURL(new Blob([bytes], { type: "image/png" })))
        .catch(() => null));
    }
    void iconUrls.get(path)!.then((value) => { if (current) setUrl(value); });
    return () => { current = false; };
  }, [path, invoke]);
  return url ? <img className="app-icon" src={url} width={size} height={size} alt="" draggable={false} />
    : <span className="app-icon app-icon-generic" style={{ width: size, height: size }} aria-hidden><Icon name={fallback} size={Math.round(size * 0.72)} /></span>;
}

const fmtFormat = (rate?: number, bits?: number) => `${(rate ?? 16000) / 1000} kHz · ${bits ?? 16}-bit`;
const fmtClock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, "0")).join(":");
};
/** Bytes per second of a mono PCM recording. */
const byteRate = (format: RecordingFormat) => format.sample_rate * (format.bits_per_sample / 8);
const fmtMegabytes = (bytes: number) => {
  const mb = bytes / 1e6;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
};

const cssVar = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/** A small menu or popover anchored to a button: closes on an outside click or Escape. */
function usePopover() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      root.current?.querySelector<HTMLButtonElement>("button")?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return { open, setOpen, root };
}

/** Keeps a canvas's backing store matched to its CSS size and the screen's pixel density. */
function useCanvas(draw: (context: CanvasRenderingContext2D, width: number, height: number) => void) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const redraw = useCallback(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) return;
    const ratio = window.devicePixelRatio || 1;
    const width = element.clientWidth;
    const height = element.clientHeight;
    if (element.width !== Math.round(width * ratio) || element.height !== Math.round(height * ratio)) {
      element.width = Math.round(width * ratio);
      element.height = Math.round(height * ratio);
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    drawRef.current(context, width, height);
  }, []);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const observer = new ResizeObserver(redraw);
    observer.observe(element);
    return () => observer.disconnect();
  }, [redraw]);
  return { canvas, redraw };
}

const METER_FLOOR_DB = -60;
const METER_SEGMENTS = 48;
const METER_TICKS = [-60, -48, -36, -24, -12, -6, 0];
const toDb = (amplitude: number) => (amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity);

/**
 * Segmented peak meter (−60…0 dBFS) with peak hold and a clip light, in the style of a hardware
 * recorder. It replays the waveform peaks (40 per second, delivered in batches) at their real pace.
 */
function LevelMeter({ peaks, peakCount, active }: { peaks: number[]; peakCount: number; active: boolean }) {
  const queue = useRef<number[]>([]);
  const seen = useRef(peakCount);
  const state = useRef({ level: METER_FLOOR_DB, hold: METER_FLOOR_DB, holdAt: 0, budget: 0, last: 0 });
  const readout = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);

  const { canvas, redraw } = useCanvas((context, width, height) => {
    const { level, hold } = state.current;
    const gap = 2;
    const segment = (width - gap * (METER_SEGMENTS - 1)) / METER_SEGMENTS;
    const off = cssVar("--border-strong", "#d2d2d8");
    const ok = cssVar("--ok", "#30a46c");
    const warn = cssVar("--warn", "#c27c00");
    const hot = cssVar("--accent", "#e5484d");
    const holdIndex = active && hold > METER_FLOOR_DB ? Math.min(METER_SEGMENTS - 1, Math.floor(((hold - METER_FLOOR_DB) / -METER_FLOOR_DB) * METER_SEGMENTS)) : -1;
    for (let i = 0; i < METER_SEGMENTS; i++) {
      const db = METER_FLOOR_DB + ((i + 1) / METER_SEGMENTS) * -METER_FLOOR_DB;
      const lit = active && level >= db - -METER_FLOOR_DB / METER_SEGMENTS;
      context.fillStyle = lit || i === holdIndex ? (db > -6 ? hot : db > -18 ? warn : ok) : off;
      context.beginPath();
      context.roundRect(i * (segment + gap), 0, segment, height, 1.5);
      context.fill();
    }
  });

  useEffect(() => {
    // A lower count means a new session on this source started counting from zero.
    const fresh = Math.min(peakCount >= seen.current ? peakCount - seen.current : peakCount, peaks.length);
    seen.current = peakCount;
    if (!fresh) return;
    const incoming = peaks.slice(-fresh);
    queue.current.push(...incoming);
    if (queue.current.length > PEAKS_PER_SECOND) queue.current.splice(0, queue.current.length - PEAKS_PER_SECOND / 2);
    if (incoming.some((peak) => peak >= 0.999)) setClipped(true);
  }, [peaks, peakCount]);

  useEffect(() => {
    const meter = state.current;
    if (!active) {
      Object.assign(meter, { level: METER_FLOOR_DB, hold: METER_FLOOR_DB, budget: 0, last: 0 });
      queue.current = [];
      if (readout.current) readout.current.textContent = "−∞";
      redraw();
      return;
    }
    let frame = 0;
    let shown = "";
    const tick = (now: number) => {
      const dt = meter.last ? Math.min(0.1, (now - meter.last) / 1000) : 0;
      meter.last = now;
      meter.budget += dt * PEAKS_PER_SECOND;
      let target = -Infinity;
      while (meter.budget >= 1 && queue.current.length) {
        target = Math.max(target, toDb(queue.current.shift()!));
        meter.budget -= 1;
      }
      if (!queue.current.length) meter.budget = Math.min(meter.budget, 1);
      // Instant attack, 24 dB/s release; the hold marker waits 1.5 s, then falls.
      meter.level = Math.max(METER_FLOOR_DB, target, meter.level - 24 * dt);
      if (meter.level >= meter.hold) {
        meter.hold = meter.level;
        meter.holdAt = now;
      } else if (now - meter.holdAt > 1500) {
        meter.hold = Math.max(meter.level, meter.hold - 30 * dt);
      }
      const text = meter.hold <= METER_FLOOR_DB ? "−∞" : meter.hold.toFixed(0).replace("-", "−");
      if (text !== shown && readout.current) readout.current.textContent = shown = text;
      redraw();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, redraw]);

  return (
    <div className={`level-meter${active ? "" : " is-idle"}`}>
      <div className="level-meter-row">
        <canvas ref={canvas} className="level-meter-bar" role="img" aria-label={t("Input level")} />
        <span className="level-meter-readout" title={t("Peak level (dBFS)")}><span ref={readout}>−∞</span> dB</span>
        <button className={`level-meter-clip${clipped ? " is-on" : ""}`} title={clipped ? t("The signal reached 0 dBFS and may be distorted. Click to reset.") : t("Clip indicator")}
          aria-label={clipped ? t("Clipping detected. Reset clip indicator") : t("Clip indicator")} onClick={() => setClipped(false)}>{t("CLIP")}</button>
      </div>
      <div className="level-meter-scale" aria-hidden>
        {METER_TICKS.map((db) => <span key={db} style={{ left: `${((db - METER_FLOOR_DB) / -METER_FLOOR_DB) * 100}%` }}>{db === 0 ? "0" : String(db).replace("-", "−")}</span>)}
      </div>
    </div>
  );
}

/** Scrolling waveform of the last 12 seconds, newest audio on the right, with markers. */
function LiveWaveform({ peaks, peakCount, elapsed, live, paused, markers }: { peaks: number[]; peakCount: number; elapsed: number; live: boolean; paused: boolean; markers: number[] }) {
  const { canvas, redraw } = useCanvas((context, width, height) => {
    const middle = height / 2;
    if (!peaks.length) {
      context.strokeStyle = cssVar("--border-strong", "#d2d2d8");
      context.setLineDash([4, 4]);
      context.beginPath();
      context.moveTo(0, middle);
      context.lineTo(width, middle);
      context.stroke();
      context.setLineDash([]);
      return;
    }
    const bar = 2;
    const step = 3;
    const bars = Math.max(1, Math.floor(width / step));
    const perBar = LIVE_PEAK_WINDOW / bars;
    const missing = LIVE_PEAK_WINDOW - Math.min(peaks.length, peakCount, LIVE_PEAK_WINDOW);
    const offset = width - bars * step;
    context.fillStyle = paused || !live ? cssVar("--text-3", "#8d8d98") : cssVar("--accent", "#e5484d");
    for (let b = 0; b < bars; b++) {
      const from = Math.floor(b * perBar);
      const to = Math.max(from + 1, Math.floor((b + 1) * perBar));
      let value = 0;
      for (let i = from; i < to; i++) {
        if (i < missing) continue;
        value = Math.max(value, peaks[peaks.length - LIVE_PEAK_WINDOW + i] ?? 0);
      }
      const h = Math.max(2, Math.min(height - 4, Math.sqrt(value) * (height - 4)));
      context.globalAlpha = from < missing ? 0.35 : 1;
      context.beginPath();
      context.roundRect(offset + b * step, middle - h / 2, bar, h, 1);
      context.fill();
    }
    context.globalAlpha = 1;
    const windowMs = (LIVE_PEAK_WINDOW / PEAKS_PER_SECOND) * 1000;
    context.fillStyle = context.strokeStyle = cssVar("--warn", "#c27c00");
    for (const at of markers) {
      const x = ((at - (elapsed - windowMs)) / windowMs) * width;
      if (x < 0 || x > width) continue;
      context.fillRect(x - 0.75, 0, 1.5, height);
      context.beginPath();
      context.moveTo(x - 0.75, 0);
      context.lineTo(x + 6, 3.5);
      context.lineTo(x - 0.75, 7);
      context.fill();
    }
  });
  useEffect(redraw, [peaks, peakCount, elapsed, live, paused, markers, redraw]);
  return (
    <div className="live-wave">
      <canvas ref={canvas} className="live-wave-canvas" role="img" aria-label={t("Live waveform of the last 12 seconds")} />
      <div className="live-wave-scale" aria-hidden><span>−12s</span><span>−9s</span><span>−6s</span><span>−3s</span><span>{t("Now")}</span></div>
    </div>
  );
}

/** Round transport button with its label underneath, like a recorder's front panel. */
function TransportButton({ variant, icon, label, title, disabled, onClick }: { variant: "record" | "stop" | "plain"; icon?: IconName; label: string; title?: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button className={`transport-btn transport-${variant}`} disabled={disabled} title={title ?? label} onClick={onClick}>
      <span className="transport-circle">{variant === "plain" && icon ? <Icon name={icon} size={16} /> : <span className="transport-glyph" />}</span>
      <span className="transport-label">{label}</span>
    </button>
  );
}

type TextFormat = "pdf" | "docx" | "txt" | "md";
const TEXT_FORMATS: { format: TextFormat; label: string }[] = [
  { format: "pdf", label: "PDF" },
  { format: "docx", label: "Word (DOCX)" },
  { format: "txt", label: "TXT" },
  { format: "md", label: "Markdown (MD)" },
];

function ClipMenu({ parts, onCopy, onExport }: { parts: { part: Part; label: string }[]; onCopy: (part: Part) => void; onExport: (part: Part, format: TextFormat) => void }) {
  const { open, setOpen, root } = usePopover();
  const [picking, setPicking] = useState<Part | null>(null);
  const menuId = useId();
  useEffect(() => { if (!open) setPicking(null); }, [open]);
  useEffect(() => { if (picking) root.current?.querySelector<HTMLButtonElement>("[role=menu] button")?.focus(); }, [picking, root]);
  const choose = (work: () => void) => () => { setOpen(false); work(); };
  const picked = parts.find(({ part }) => part === picking);
  return (
    <div className="popover-anchor" ref={root}>
      <button className="btn btn-sm btn-ghost icon-btn" aria-label={t("More actions")} title={t("More actions")} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen(!open)}>
        <Icon name="more" size={14} />
      </button>
      {open && <div className="popover menu" role="menu" id={menuId} aria-label={picked ? t("Download {label} as", { label: picked.label }) : undefined}>
        {picked ? <>
          <button role="menuitem" onClick={() => setPicking(null)}><Icon name="back" size={13} />{t("Download {label} as", { label: picked.label })}</button>
          <hr />
          {TEXT_FORMATS.map(({ format, label }) => (
            <button role="menuitem" key={format} onClick={choose(() => onExport(picked.part, format))}><Icon name="download" size={13} />{label}</button>
          ))}
        </> : parts.map(({ part, label }, index) => (
          <React.Fragment key={part}>
            {index > 0 && <hr />}
            <button role="menuitem" onClick={choose(() => onCopy(part))}><Icon name="copy" size={13} />{t("Copy {label}", { label })}</button>
            <button role="menuitem" aria-haspopup="menu" onClick={() => setPicking(part)}><Icon name="download" size={13} />{t("Download {label}…", { label })}</button>
          </React.Fragment>
        ))}
      </div>}
    </div>
  );
}

/** One "Download" button that lists the formats to save as; the caller shows the save panel. */
export function DownloadMenu({ options, onPick }: { options: { key: string; label: string }[]; onPick: (key: string) => void }) {
  const { open, setOpen, root } = usePopover();
  const menuId = useId();
  return (
    <div className="popover-anchor" ref={root}>
      <button className="btn btn-sm" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen(!open)}>
        <Icon name="download" size={13} />{t("Download…")}
      </button>
      {open && <div className="popover menu menu-start" role="menu" id={menuId} aria-label={t("Download as")}>
        {options.map(({ key, label }) => (
          <button role="menuitem" key={key} onClick={() => { setOpen(false); onPick(key); }}>{label}</button>
        ))}
      </div>}
    </div>
  );
}

export function SavedClip({ clip, revision, invoke, flash, showSource, onDetails }: { clip: Session; revision?: number; invoke: Invoke; flash: (text: string) => void; showSource?: boolean; onDetails?: () => void }) {
  const [preview, setPreview] = useState<TextPreview | null>(null);
  const [busy, setBusy] = useState<Part | "audio" | null>(null);
  const [audio, setAudio] = useState<{ blob: Blob; markers: Marker[]; autoPlay: boolean } | null>(null);
  const [editing, setEditing] = useState(false);
  const [playing, setPlaying] = useState(false);
  const player = useRef<PlayerHandle>(null);
  const saving = clip.status === "stopping";
  const processing = clip.status === "processing";
  useEffect(() => {
    let current = true;
    void invoke<TextPreview>("recording_preview", { id: clip.id }).then((result) => { if (current) setPreview(result); }).catch(console.error);
    return () => { current = false; };
  }, [clip.id, clip.status, clip.asr?.failed_chunks, revision, invoke]);

  async function run(command: string, args: Record<string, unknown>, message: string) {
    try {
      await invoke(command, { id: clip.id, ...args });
      flash(message);
    } catch (error) {
      flash(tError(error));
    }
  }

  async function openPlayer(autoPlay: boolean) {
    setBusy("audio");
    try {
      const [bytes, markers] = await Promise.all([
        invoke<ArrayBuffer>("load_recording_audio", { id: clip.id }),
        invoke<Marker[]>("recording_markers", { id: clip.id }).catch(() => []),
      ]);
      setAudio({ blob: new Blob([bytes], { type: "audio/wav" }), markers: markers ?? [], autoPlay });
    } catch (error) {
      setEditing(false);
      flash(tError(error));
    } finally {
      setBusy(null);
    }
  }

  async function generate(part: Part) {
    setBusy(part);
    try {
      if (part === "transcript") {
        const result = await invoke<{ queued: number }>("generate_recording_transcript", { id: clip.id });
        flash(result?.queued ? t("Transcription queued. Text will appear here when ready.") : t("No speech was detected in this recording."));
      } else {
        await invoke("generate_recording_summary", { id: clip.id });
        flash(t("Summary saved."));
      }
      setPreview(await invoke<TextPreview>("recording_preview", { id: clip.id }));
    } catch (error) {
      flash(tError(error));
    } finally {
      setBusy(null);
    }
  }

  async function exportText(part: Part, format: TextFormat) {
    try {
      const name = `${clip.title || "Multicorder"} - ${label(part)}`;
      const path = await invoke<string | null>("export_recording_text", { id: clip.id, part, format, name, title: t("Save {label}", { label: label(part) }) });
      if (path) flash(t("Saved {path}", { path }));
    } catch (error) {
      flash(tError(error));
    }
  }

  async function saveWav() {
    try {
      const path = await invoke<string | null>("export_audio", { id: clip.id, name: clip.title, title: t("Save audio") });
      if (path) flash(t("Saved {path}", { path }));
    } catch (error) {
      flash(tError(error));
    }
  }

  const label = (part: Part) => (part === "transcript" ? t("Transcript") : t("AI summary"));
  const parts: Part[] = ["transcript", "summary"];
  const present = preview ? parts.filter((part) => preview[part]) : [];
  const missing = preview ? parts.filter((part) => !preview[part]) : [];
  const missingText = missing.length === 2 ? t("No transcript or summary yet.")
    : missing[0] === "transcript" ? t("No transcript yet.") : t("No AI summary yet.");
  const date = new Date(clip.started_at).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" });

  return (
    <li className={`saved-clip${audio ? " is-open" : ""}`}>
      <div className="clip-row">
        <button className={`clip-play${playing ? " is-playing" : ""}`} disabled={saving || busy === "audio"}
          aria-label={playing ? t("Pause") : t("Play recording from {date}", { date })} title={playing ? t("Pause") : t("Play")}
          onClick={() => audio ? player.current?.toggle() : void openPlayer(true)}>
          {busy === "audio" ? <span className="spinner" aria-hidden /> : <Icon name={playing ? "pause" : "play"} size={14} />}
        </button>
        <div className="clip-meta">
          {showSource && <span className="clip-source">{clip.title}</span>}
          <span className="clip-date">{date}</span>
          <span className="ts">{fmtTs(clip.audio_ms)}</span>
          <span className="clip-format">{fmtFormat(clip.sample_rate, clip.bits_per_sample)}</span>
          {processing && <span className="chip info">{t("Processing")}</span>}
        </div>
        <div className="clip-buttons">
          {onDetails && <button className="btn btn-sm btn-ghost" onClick={onDetails}>{t("Details")}</button>}
          <button className={`btn btn-sm btn-ghost icon-btn${editing ? " is-pressed" : ""}`} disabled={busy === "audio" || saving} aria-pressed={editing}
            aria-label={t("Edit audio")} title={t("Edit audio")} onClick={() => {
              setEditing(!editing);
              if (!audio && !editing) void openPlayer(false);
            }}><Icon name="scissors" size={14} /></button>
          <button className="btn btn-sm btn-ghost icon-btn" disabled={saving} aria-label={t("Download WAV")} title={t("Download WAV")}
            onClick={() => void saveWav()}><Icon name="download" size={14} /></button>
          {present.length > 0 && <ClipMenu parts={present.map((part) => ({ part, label: label(part) }))}
            onCopy={(part) => void run("copy_recording_text", { part }, t("Copied."))} onExport={(part, format) => void exportText(part, format)} />}
          {audio && <button className="btn btn-sm btn-ghost icon-btn" aria-label={t("Close player")} title={t("Close player")} onClick={() => {
            setAudio(null);
            setEditing(false);
          }}><Icon name="close" size={13} /></button>}
        </div>
      </div>
      {audio && <Suspense fallback={<p className="small muted">{t("Loading waveform…")}</p>}>
        <AudioPlayer ref={player} audio={audio.blob} markers={audio.markers} editing={editing} autoPlay={audio.autoPlay} onPlayingChange={setPlaying} onError={flash}
          onExport={async (startMs, endMs) => {
            const path = await invoke<string | null>("export_recording_selection", { id: clip.id, startMs, endMs, name: clip.title, title: t("Save selection") });
            if (path) flash(t("Saved {path}", { path }));
          }} />
      </Suspense>}
      {present.length > 0 && <div className="clip-texts">
        {present.map((part) => (
          <section className="recording-text" key={part} aria-label={label(part)}>
            <h4><Icon name={part === "transcript" ? "text" : "sparkle"} size={12} />{label(part)}</h4>
            <p className="clip-excerpt">{preview![part]}</p>
          </section>
        ))}
      </div>}
      {missing.length > 0 && <div className="clip-missing">
        <span className="clip-missing-text"><Icon name={missing.length === 2 ? "text" : missing[0] === "transcript" ? "text" : "sparkle"} size={12} />{missingText}</span>
        {missing.map((part) => (
          <button key={part} className="btn btn-sm" disabled={busy !== null || saving || processing} onClick={() => void generate(part)}>
            {busy === part ? t("Generating…") : part === "transcript" ? t("Generate transcript") : t("Generate summary")}
          </button>
        ))}
      </div>}
    </li>
  );
}

function PausedPlayback({ id, invoke, onError }: { id: string; invoke: Invoke; onError: (message: string) => void }) {
  const [audio, setAudio] = useState<Blob>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let current = true;
    void invoke<ArrayBuffer>("load_paused_audio", { id }).then((bytes) => {
      if (current) setAudio(new Blob([bytes], { type: "audio/wav" }));
    }).catch((failure) => { if (current) setError(tError(failure)); });
    return () => { current = false; };
  }, [id, invoke]);
  return (
    <section className="pause-review" aria-label={t("Review paused recording")}>
      <strong className="small">{t("Review paused recording")}</strong>
      {audio ? <Suspense fallback={<p className="small muted">{t("Loading recording…")}</p>}>
        <AudioPlayer audio={audio} markers={[]} editing={false} onError={onError} onExport={async () => {}} />
      </Suspense> : <p className="small muted" role="status">{error || t("Loading recording…")}</p>}
    </section>
  );
}

function phaseLabel(phase: string | undefined, hasSession: boolean, canStart: boolean, kind: Session["kind"]) {
  if (phase === "waiting") return t("Waiting for audio");
  if (phase === "paused") return t("Paused");
  if (phase === "stopping" || phase === "stopped" || phase === "failed") return t("Saving");
  if (hasSession) return t("Recording");
  if (canStart) return t("Ready");
  return kind === "mic" ? t("Disconnected") : kind === "chromium_tab" ? t("Chrome tab") : t("App closed");
}

const SAMPLE_RATES = [16000, 24000, 32000, 44100, 48000];

function FormatPicker({ format, setFormat, disabled }: { format: RecordingFormat; setFormat: (format: RecordingFormat) => void; disabled: boolean }) {
  const { open, setOpen, root } = usePopover();
  const popoverId = useId();
  return (
    <div className="popover-anchor" ref={root}>
      <button className="btn btn-sm" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popoverId : undefined}
        aria-label={t("Recording format: {format}", { format: `${fmtFormat(format.sample_rate, format.bits_per_sample)} · ${t("Mono")}` })} onClick={() => setOpen(!open)}>
        <Icon name="sliders" size={13} />{fmtFormat(format.sample_rate, format.bits_per_sample)} · {t("Mono")}<span className="chevron" aria-hidden><Icon name="back" size={10} /></span>
      </button>
      {open && <div className="popover format-popover" role="dialog" id={popoverId} aria-label={t("Recording format")}>
        <label><span>{t("Sample rate")}</span><select className="input" value={format.sample_rate} onChange={(e) => setFormat({ ...format, sample_rate: Number(e.target.value) })}>
          {SAMPLE_RATES.map((rate) => <option key={rate} value={rate}>{rate / 1000} kHz</option>)}
        </select></label>
        <label><span>{t("Audio quality")}</span><select className="input" value={format.bits_per_sample} onChange={(e) => setFormat({ ...format, bits_per_sample: Number(e.target.value) })}>
          <option value={16}>16-bit PCM</option><option value={24}>24-bit PCM</option>
        </select></label>
        <p className="small muted">{t("About {size} per minute. Applies to new recordings from this source.", { size: fmtMegabytes(byteRate(format) * 60) })}</p>
      </div>}
    </div>
  );
}

export function RecordingPanel({ title, iconPath, mutePlayback, setMutePlayback, originalName, kind, session, card, clips, cards, canStart, standaloneRecording, willWait, lastFailure, format, setFormat, invoke, flash, onStart, onStop, refresh }: {
  title: string;
  iconPath?: string | null;
  mutePlayback: boolean;
  /** Absent for microphones, which have no playback to mute. */
  setMutePlayback?: (value: boolean) => void;
  originalName?: string;
  kind: Session["kind"];
  format: RecordingFormat;
  setFormat: (format: RecordingFormat) => void;
  session?: Session;
  card?: LiveCard;
  clips: Session[];
  cards: Record<string, LiveCard>;
  canStart: boolean;
  standaloneRecording: boolean;
  willWait: boolean;
  lastFailure?: string | null;
  invoke: Invoke;
  flash: (text: string) => void;
  onStart: () => Promise<void>;
  onStop: (id: string) => Promise<void>;
  refresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(5);
  const [missed, setMissed] = useState<string[]>([]);
  const [markers, setMarkers] = useState<number[]>([]);
  const headingId = useId();
  const phase = card?.status ?? session?.status;
  const paused = phase === "paused";
  const waiting = phase === "waiting";
  const finishing = phase === "stopping" || phase === "stopped" || phase === "failed";
  const live = !!session && !paused && !waiting && !finishing;
  const note = describeDetail(card?.detail);
  const elapsed = card?.elapsed ?? session?.audio_ms ?? 0;
  const peaks = card?.peaks ?? [];
  const peakCount = card?.peakCount ?? peaks.length;
  const activeFormat: RecordingFormat = session
    ? { sample_rate: session.sample_rate ?? 16000, bits_per_sample: session.bits_per_sample ?? 16 }
    : kind === "chromium_tab" ? DEFAULT_RECORDING_FORMAT : format;
  const canRecordHere = !session && canStart;

  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    try {
      await work();
      refresh();
    } catch (error) {
      flash(tError(error));
    } finally {
      setBusy(false);
    }
  }
  const changeMode = (mode: SummaryMode) => session && action(() => invoke("set_mode", { id: session.id, mode }));
  const loadMarkers = useCallback(async (id: string) => {
    const list = await invoke<Marker[]>("recording_markers", { id }).catch(() => null);
    setMarkers((list ?? []).map((marker) => marker.at_ms));
  }, [invoke]);
  useEffect(() => {
    setMarkers([]);
    if (session?.id) void loadMarkers(session.id);
  }, [session?.id, loadMarkers]);

  const start = () => action(onStart);
  const togglePause = () => session && action(() => invoke("pause_session", { id: session.id, paused: !paused }));
  const addMarker = () => session && action(async () => {
    await invoke("add_marker", { id: session.id });
    setMarkers((current) => [...current, elapsed]);
    void loadMarkers(session.id);
  });
  const canPause = !!session && !busy && !finishing && phase !== "starting";

  // Space starts a recording, or pauses and resumes one; M adds a marker. Ignored while typing,
  // on a focused control (which Space would press) and inside a player (Space plays there).
  const keys = useRef({ start, togglePause, addMarker, canStart: canRecordHere && !busy, canPause, live });
  keys.current = { start, togglePause, addMarker, canStart: canRecordHere && !busy, canPause, live };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement;
      if (target.closest("input, select, textarea, button, a, [contenteditable], dialog, [role=menu], .audio-player")) return;
      const k = keys.current;
      if (event.key === " ") {
        if (k.canStart) { event.preventDefault(); void k.start(); }
        else if (k.canPause) { event.preventDefault(); void k.togglePause(); }
      } else if ((event.key === "m" || event.key === "M") && k.live) {
        event.preventDefault();
        void k.addMarker();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const sizeText = session
    ? `${fmtMegabytes(byteRate(activeFormat) * (elapsed / 1000))}`
    : t("~{size}/min", { size: fmtMegabytes(byteRate(activeFormat) * 60) });
  const shortcuts = session ? !finishing : canRecordHere;

  return (
    <article className={`source-panel${live ? " is-live" : ""}`} aria-labelledby={headingId}>
      <header className="source-panel-head">
        <span className="source-panel-icon"><AppIcon path={iconPath} invoke={invoke} fallback={kind === "mic" ? "mic" : kind === "chromium_tab" ? "tab" : "app"} size={26} /></span>
        <div className="source-panel-title">
          <h2 id={headingId}>{title}</h2>
          {originalName && <div className="source-original-name">{originalName}</div>}
        </div>
        <span className={`chip ${phase === "capturing" ? "rec" : session ? "info" : canStart ? "ok" : ""}`}>
          {phase === "capturing" && <span className="dot" />}
          {standaloneRecording && !session ? t("Recording in browser") : phaseLabel(phase, !!session, canStart, kind)}
        </span>
      </header>
      {!session && kind === "chromium_tab" && !canStart ? (
        <p className="transport transport-note small muted">{t(standaloneRecording ? "Manage this recording in the browser extension." : "Start this source from the Multicorder extension in Chrome.")}</p>
      ) : <section className="transport" aria-label={t("Recorder")}>
        <div className="transport-main">
          <div className="transport-buttons">
            {!session ? (
              <TransportButton key="record" variant="record" label={kind === "chromium_tab" ? t("Record tab") : t("Record")} disabled={!canStart || busy}
                title={willWait ? t(WAITING_FOR_AUDIO) : t("Start recording")} onClick={() => void start()} />
            ) : (
              <>
                <TransportButton key="stop" variant="stop" label={t("End & save")} disabled={busy || finishing} onClick={() => void action(() => onStop(session.id))} />
                <TransportButton variant="plain" icon={paused ? "play" : "pause"} label={paused ? t("Resume") : t("Pause")} disabled={!canPause} onClick={() => void togglePause()} />
                <TransportButton variant="plain" icon="flag" label={t("Marker")} title={t("Add marker")} disabled={busy || !live} onClick={() => void addMarker()} />
                {card?.lines.length ? <TransportButton variant="plain" icon="clock" label={t("Catch up")} title={t("What did I miss?")} disabled={busy} onClick={() => void action(async () => {
                  const result = await invoke<{ points: { text: string }[] }>("missed", { id: session.id, minutes: 5 });
                  setMissed(result?.points.map((point) => point.text) ?? []);
                })} /> : null}
              </>
            )}
          </div>
          <div className="transport-clock" role="timer" aria-label={t("Recorded time {time}", { time: fmtClock(elapsed) })}>
            <span className={`clock${live ? " is-live" : paused ? " is-paused" : ""}`}>{fmtClock(elapsed)}</span>
            <span className="clock-sub">{fmtFormat(activeFormat.sample_rate, activeFormat.bits_per_sample)} · {t("Mono")} · {sizeText}</span>
          </div>
          <LevelMeter peaks={peaks} peakCount={peakCount} active={live} />
        </div>
        <LiveWaveform peaks={peaks} peakCount={peakCount} elapsed={elapsed} live={live} paused={paused} markers={markers} />
        <div className="transport-options">
          {session ? (
            <select className="input input-sm" aria-label={t("Summary mode")} disabled={finishing} value={session.summary_mode} onChange={(e) => void changeMode(e.target.value as SummaryMode)}>
              <option value="live">{t("Live summary")}</option>
              <option value="after">{t("Summary at end")}</option>
              <option value="off">{t("Audio only")}</option>
            </select>
          ) : kind !== "chromium_tab" && <FormatPicker format={format} setFormat={setFormat} disabled={busy} />}
          {!session && setMutePlayback && (canStart || kind !== "chromium_tab") && (
            <button className={`btn btn-sm${mutePlayback ? " is-pressed" : ""}`} aria-pressed={mutePlayback} onClick={() => setMutePlayback(!mutePlayback)}
              title={t("Records the audio without playing it through your speakers or headphones. Applies to every new recording.")}>
              <Icon name={mutePlayback ? "mute" : "speaker"} size={13} />{t("Record silently")}
            </button>
          )}
          <span className="grow" />
          {shortcuts && <span className="transport-keys">
            <kbd>Space</kbd>{session ? t("Pause / resume") : t("Record")}
            {live && <><kbd>M</kbd>{t("Marker")}</>}
          </span>}
        </div>
      </section>}
      {session && paused && <PausedPlayback key={session.id} id={session.id} invoke={invoke} onError={flash} />}
      {waiting && <p className="small muted" role="status">{t(WAITING_FOR_AUDIO)}</p>}
      {!session && lastFailure === "no_audio" && <p className="small muted" role="status">{t("No sound was detected, so no audio was saved.")}</p>}
      {!session && lastFailure?.startsWith("capture_failed: ") && <p className="banner warn" role="status">{lastFailure.slice("capture_failed: ".length)}</p>}
      {note && <p className="small muted" role="status">{note}</p>}
      {session && !!card?.lines.length && <div className="panel-captions" aria-live="polite">{card.lines.slice(-2).map((line) => <p key={line.id}><span className="ts">{fmtTs(line.start_ms)}</span> {line.text}</p>)}</div>}
      {session && !!card?.insights.length && <ul className="panel-points" aria-label={t("Key points")}>{card.insights.slice(-3).map((point) => <li key={point.key}>{point.text}</li>)}</ul>}
      {session && missed.length > 0 && <ul className="panel-points missed" aria-label={t("What you missed")}>{missed.map((point, index) => <li key={index}>{point}</li>)}</ul>}
      <section className="source-clips">
        <h3>{t("Recordings")}{clips.length > 0 && <span className="count">{clips.length}</span>}</h3>
        {clips.length ? (
          <ul>{clips.slice(0, visible).map((clip) => (
            <SavedClip key={clip.id} clip={clip} showSource={kind === "mac_app" && clip.kind === "chromium_tab"} revision={cards[clip.id]?.textRevision} invoke={invoke} flash={flash} />
          ))}</ul>
        ) : <p className="small muted">{t("Recordings from this source are saved locally.")}</p>}
        {visible < clips.length && <button className="btn btn-sm" onClick={() => setVisible((count) => count + 5)}>{t("Show more recordings")}</button>}
      </section>
    </article>
  );
}

export const RECORDING_CSS = `
.source-panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);padding:18px;display:grid;gap:14px}
.source-panel-head{display:flex;align-items:center;gap:12px}
.source-panel-icon{width:38px;height:38px;flex:none;display:grid;place-items:center;border-radius:10px;background:var(--surface-2);color:var(--text-2)}
.app-icon{flex:none;display:inline-grid;place-items:center;object-fit:contain}
.app-icon-generic{color:var(--text-3)}
.source-panel-icon .app-icon-generic{color:inherit}
.is-live .source-panel-icon{background:var(--accent-weak);color:var(--accent-text)}
.source-panel-title{min-width:0;flex:1}.source-panel-title h2{margin:0;font-size:17px;overflow-wrap:anywhere}
.source-panel .grow,.audio-player .grow{flex:1}
.source-panel p{margin:0}
.btn.is-pressed{background:var(--surface-3);border-color:var(--border-strong);color:var(--text)}
.input-sm{height:26px;font-size:12px;padding:0 7px}
kbd{font:500 10.5px var(--mono);color:var(--text-2);background:var(--surface);border:1px solid var(--border);border-bottom-width:2px;border-radius:4px;padding:0 4px;line-height:15px}

.transport{background:var(--surface-2);border-radius:var(--radius-md);padding:14px;display:grid;gap:12px}
.transport-main{display:flex;align-items:center;gap:12px 20px;flex-wrap:wrap}
.transport-buttons{display:flex;align-items:flex-start;gap:10px}
.transport-note{padding:10px 14px}
.transport-btn{display:grid;justify-items:center;gap:4px;background:none;border:0;padding:0;cursor:pointer;color:var(--text-2);font-size:11px;font-weight:500;min-width:44px}
.transport-btn:disabled{opacity:.45;cursor:default}
.transport-circle{width:38px;height:38px;border-radius:50%;display:grid;place-items:center;background:var(--surface);border:1px solid var(--border);box-shadow:var(--shadow-sm);color:var(--text);transition:border-color .12s,background .12s,transform .06s}
.transport-btn:not(:disabled):hover .transport-circle{border-color:var(--border-strong);background:var(--surface-3)}
.transport-btn:not(:disabled):active .transport-circle{transform:scale(.96)}
.transport-btn:focus-visible{outline:none}.transport-btn:focus-visible .transport-circle{box-shadow:0 0 0 3px var(--focus)}
.transport-record .transport-circle,.transport-stop .transport-circle{width:54px;height:54px;border:2px solid var(--border-strong)}
.transport-record .transport-glyph{width:22px;height:22px;border-radius:50%;background:var(--accent)}
.transport-stop .transport-glyph{width:18px;height:18px;border-radius:4px;background:var(--accent)}
.transport-record:not(:disabled):hover .transport-glyph{background:var(--accent-hover)}
.transport-record .transport-label,.transport-stop .transport-label{color:var(--text)}
.is-live .transport-stop .transport-circle{border-color:var(--accent);animation:rec-ring 1.6s ease-in-out infinite}
@keyframes rec-ring{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,var(--accent) 35%,transparent)}50%{box-shadow:0 0 0 5px color-mix(in srgb,var(--accent) 0%,transparent)}}
@media (prefers-reduced-motion:reduce){.is-live .transport-stop .transport-circle{animation:none}}
.transport-clock{display:grid;gap:3px;min-width:150px}
.clock{font:500 30px/1 var(--mono);font-variant-numeric:tabular-nums;letter-spacing:-.02em;color:var(--text)}
.clock.is-live{color:var(--accent-text)}
.clock.is-paused{color:var(--text-3)}
.clock-sub{font-size:11.5px;color:var(--text-3);font-variant-numeric:tabular-nums;white-space:nowrap}
.level-meter{flex:1 1 300px;min-width:min(100%,280px);display:grid;gap:3px}
.level-meter-row{display:flex;align-items:center;gap:8px}
.level-meter-bar{flex:1;min-width:0;height:10px;display:block}
.level-meter-readout{font:500 11px var(--mono);color:var(--text-2);min-width:46px;text-align:right;font-variant-numeric:tabular-nums}
.level-meter.is-idle .level-meter-readout{color:var(--text-3)}
.level-meter-clip{font:600 9px var(--font);letter-spacing:.06em;height:16px;padding:0 5px;border-radius:4px;border:1px solid var(--border);background:var(--surface);color:var(--text-3);cursor:pointer}
.level-meter-clip.is-on{background:var(--accent);border-color:var(--accent);color:#fff}
.level-meter-scale{position:relative;height:12px;margin-right:84px;font:10px var(--mono);color:var(--text-3)}
.level-meter-scale span{position:absolute;transform:translateX(-50%)}
.level-meter-scale span:first-child{transform:none}.level-meter-scale span:last-child{transform:translateX(-100%)}
.live-wave{display:grid;gap:3px}
.live-wave-canvas{width:100%;height:56px;display:block;background:var(--surface);border-radius:var(--radius-sm);border:1px solid var(--border)}
.live-wave-scale{display:flex;justify-content:space-between;font:10px var(--mono);color:var(--text-3)}
.transport-options{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.transport-keys{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--text-3)}
.transport-keys kbd:not(:first-child){margin-left:6px}

.popover-anchor{position:relative;display:inline-flex}
.popover{position:absolute;z-index:20;top:calc(100% + 4px);left:0;min-width:200px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);box-shadow:var(--shadow-lg);padding:4px}
.popover.menu{left:auto;right:0;display:grid}
.popover.menu.menu-start{left:0;right:auto}
.popover.menu button{display:flex;align-items:center;gap:8px;height:28px;padding:0 8px;border:0;border-radius:5px;background:none;text-align:left;cursor:pointer;color:var(--text);font-size:12px;white-space:nowrap}
.popover.menu button:hover,.popover.menu button:focus-visible{background:var(--surface-2);outline:none}
.popover.menu hr{border:0;border-top:1px solid var(--border);margin:4px 2px}
.chevron{display:inline-flex;transform:rotate(-90deg);color:var(--text-3)}
.format-popover{display:grid;gap:10px;padding:12px;width:250px}
.format-popover label{display:grid;grid-template-columns:90px 1fr;align-items:center;gap:8px;font-size:12px;color:var(--text-2)}

.pause-review{display:grid;gap:8px;padding:10px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--surface-2)}
.panel-captions{margin:0;color:var(--text-2);font-size:12.5px;background:var(--surface-2);border-radius:var(--radius-sm);padding:8px 10px;display:grid;gap:2px}
.panel-points{margin:0;padding:0 0 0 18px;color:var(--text);font-size:12.5px;display:grid;gap:3px}
.panel-points.missed li::marker{color:var(--info)}

.source-clips{border-top:1px solid var(--border);padding-top:12px}
.source-clips h3{margin:0 0 8px;display:flex;align-items:center;gap:6px}
.count{font:500 11px var(--font);color:var(--text-3);background:var(--surface-2);border-radius:999px;padding:0 6px;letter-spacing:0;text-transform:none}
.source-clips>ul{list-style:none;margin:0 0 10px;padding:0;border:1px solid var(--border);border-radius:var(--radius-md);overflow:visible}
.saved-clip{padding:9px 12px;display:grid;gap:8px;background:var(--surface)}
.saved-clip+.saved-clip{border-top:1px solid var(--border)}
.saved-clip:first-child{border-top-left-radius:var(--radius-md);border-top-right-radius:var(--radius-md)}
.saved-clip:last-child{border-bottom-left-radius:var(--radius-md);border-bottom-right-radius:var(--radius-md)}
.saved-clip.is-open{background:color-mix(in srgb,var(--surface-2) 45%,var(--surface))}
.clip-row{display:flex;align-items:center;gap:10px;min-width:0}
.clip-play{flex:none;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;border:1px solid var(--border-strong);background:var(--surface);color:var(--text);cursor:pointer;padding:0 0 0 1px;transition:background .12s,border-color .12s,color .12s}
.clip-play:hover:not(:disabled){border-color:var(--border-strong);background:var(--surface-2)}
.clip-play.is-playing,.clip-play.is-playing:hover:not(:disabled){background:var(--primary);border-color:var(--primary);color:#fff;padding:0}
.clip-play:disabled{opacity:.5;cursor:default}
.clip-meta{min-width:0;flex:1;display:flex;align-items:baseline;gap:4px 10px;flex-wrap:wrap;font-size:12.5px}
.clip-date{color:var(--text);font-weight:500}
.clip-format{color:var(--text-3);font-size:11.5px}
.clip-source{flex-basis:100%;font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.clip-buttons{display:flex;align-items:center;gap:2px;flex:none}
.clip-texts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:8px;padding-left:38px}
.recording-text{background:var(--surface-2);border-radius:var(--radius-sm);padding:8px 10px;min-width:0;display:grid;gap:3px;align-content:start}
.recording-text h4{margin:0;font-size:11px;font-weight:600;display:flex;align-items:center;gap:5px;color:var(--text-3)}
.clip-excerpt{font-size:12.5px;color:var(--text);overflow-wrap:anywhere;white-space:pre-line;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.clip-missing{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding-left:38px}
.clip-missing-text{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--text-3);margin-right:auto}
.spinner{width:12px;height:12px;border-radius:50%;border:2px solid var(--border-strong);border-top-color:var(--text-2);animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

.audio-player{min-width:0;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 10px 6px;display:grid;gap:6px;outline:none}
.saved-clip .audio-player{margin-left:38px}
.player-wave{min-width:0;cursor:pointer}
.player-marker{font:500 10px var(--font);color:var(--warn-text);padding:0 3px;white-space:nowrap}
.player-controls{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.player-play{border-radius:50%}
.player-time{font:500 12px var(--mono);font-variant-numeric:tabular-nums;margin-left:4px}
.player-rate{min-width:42px;font-family:var(--mono)}
.player-volume{width:80px;accent-color:var(--primary)}
.player-edit{border-top:1px solid var(--border);padding-top:6px;gap:6px}
.player-zoom{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-2)}
.player-zoom input{width:80px;accent-color:var(--primary)}
@media (max-width:560px){.clip-texts,.clip-missing{padding-left:0}.saved-clip .audio-player{margin-left:0}}
`;
