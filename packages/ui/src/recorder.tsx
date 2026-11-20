// Recorder widgets shared by the Mac app and the Chrome extension: the transport buttons, the
// clock, the segmented level meter, the scrolling 12-second waveform and the on/off switch.

import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { Icon } from "./icons";
import { t } from "./i18n";

type IconName = Parameters<typeof Icon>[0]["name"];

/** Waveform peaks arrive 40 per second; the live strip shows the last 12 seconds. */
export const PEAKS_PER_SECOND = 40;
export const LIVE_PEAK_WINDOW = PEAKS_PER_SECOND * 12;

export const fmtClock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, "0")).join(":");
};

const cssVar = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/** A small menu or popover anchored to a button: closes on an outside click or Escape. */
export function usePopover() {
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
export function useCanvas(draw: (context: CanvasRenderingContext2D, width: number, height: number) => void) {
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
export function LevelMeter({ peaks, peakCount, active }: { peaks: number[]; peakCount: number; active: boolean }) {
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
export function LiveWaveform({ peaks, peakCount, elapsed, live, paused, markers }: { peaks: number[]; peakCount: number; elapsed: number; live: boolean; paused: boolean; markers: number[] }) {
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

const CONFIRM_WINDOW_MS = 3000;
/** A second click sooner than this after arming counts as part of a double-click, not a confirmation. */
const CONFIRM_MIN_GAP_MS = 400;

/**
 * Round transport button with its label underneath, like a recorder's front panel. Colour follows
 * the action: "record" (start) and "resume" are green, "pause" and "plain" are neutral, "stop" is
 * red. With `confirmLabel`, it needs a second click (not part of the same double-click) within
 * three seconds, so a recording is hard to end by accident.
 */
export function TransportButton({ variant, icon, label, title, confirmLabel, disabled, onClick }: {
  variant: "record" | "resume" | "pause" | "stop" | "plain"; icon?: IconName; label: string; title?: string; confirmLabel?: string; disabled?: boolean; onClick: () => void;
}) {
  const [armedAt, setArmedAt] = useState(0);
  useEffect(() => {
    if (!armedAt) return;
    const timer = window.setTimeout(() => setArmedAt(0), CONFIRM_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [armedAt]);
  useEffect(() => { if (disabled) setArmedAt(0); }, [disabled]);
  const armed = !!armedAt && !!confirmLabel;
  const click = () => {
    if (!confirmLabel) return onClick();
    if (!armedAt) return setArmedAt(Date.now());
    if (Date.now() - armedAt < CONFIRM_MIN_GAP_MS) return;
    setArmedAt(0);
    onClick();
  };
  const shown = armed ? confirmLabel : label;
  return (
    <button className={`transport-btn transport-${variant}${armed ? " is-armed" : ""}`} disabled={disabled} title={armed ? confirmLabel : title ?? label}
      aria-label={shown} onClick={click} onBlur={() => setArmedAt(0)} onKeyDown={(event) => { if (event.key === "Escape") setArmedAt(0); }}>
      <span className="transport-circle">
        {variant === "record" || variant === "stop" ? <span className="transport-glyph" /> : <Icon name={variant === "resume" ? "play" : variant === "pause" ? "pause" : icon ?? "pause"} size={16} />}
      </span>
      <span className="transport-label" aria-live={confirmLabel ? "polite" : undefined}>{shown}</span>
    </button>
  );
}


/** An on/off switch (role="switch") with its label to the right. */
export function Switch({ checked, onChange, label, title, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; title?: string; disabled?: boolean }) {
  const id = useId();
  return (
    <label className={`mc-switch${disabled ? " is-disabled" : ""}`} htmlFor={id} title={title}>
      <button id={id} type="button" role="switch" aria-checked={checked} disabled={disabled} className="mc-switch-track" onClick={() => onChange(!checked)}>
        <span className="mc-switch-thumb" />
      </button>
      <span>{label}</span>
    </label>
  );
}

export const RECORDER_CSS = `
.btn.is-pressed{background:var(--surface-3);border-color:var(--border-strong);color:var(--text)}
.input-sm{height:26px;font-size:12px;padding:0 7px}
select.input.input-sm{padding-right:26px;background-position:right 8px center}
kbd{font:500 10.5px var(--mono);color:var(--text-2);background:var(--surface);border:1px solid var(--border);border-bottom-width:2px;border-radius:4px;padding:0 4px;line-height:15px}
.transport{background:var(--surface-2);border-radius:var(--radius-md);padding:14px;display:grid;gap:12px}
.transport-main{display:flex;align-items:center;gap:12px 20px;flex-wrap:wrap}
.transport-buttons{display:flex;align-items:flex-start;gap:6px}
.transport-note{padding:10px 14px}
.transport-btn{display:flex;flex-direction:column;align-items:center;gap:5px;background:none;border:0;padding:0;cursor:pointer;color:var(--text-2);font-size:11px;font-weight:500;line-height:1.2;min-width:56px;text-align:center;white-space:nowrap}
.transport-btn:disabled{opacity:.45;cursor:default}
.transport-circle{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;background:var(--surface);border:1px solid var(--border);box-shadow:var(--shadow-sm);color:var(--text);transition:border-color .12s,background .12s,transform .06s}
.transport-circle svg{display:block}
.transport-btn:not(:disabled):hover .transport-circle{border-color:var(--border-strong);background:var(--surface-3)}
.transport-btn:not(:disabled):active .transport-circle{transform:scale(.96)}
.transport-btn:focus-visible{outline:none}.transport-btn:focus-visible .transport-circle{box-shadow:0 0 0 3px var(--focus)}
.transport-label{display:block}
.transport-record .transport-circle,.transport-resume .transport-circle,.transport-btn.transport-record:not(:disabled):hover .transport-circle,.transport-btn.transport-resume:not(:disabled):hover .transport-circle{background:var(--ok);border-color:var(--ok);color:#fff}
.transport-btn.transport-record:not(:disabled):hover .transport-circle,.transport-btn.transport-resume:not(:disabled):hover .transport-circle{filter:brightness(1.08)}
.transport-record .transport-glyph{width:14px;height:14px;border-radius:50%;background:#fff}
.transport-resume .transport-circle svg{margin-left:2px}
.transport-record .transport-label,.transport-resume .transport-label{color:var(--ok-text)}
.transport-pause .transport-label{color:var(--text)}
.transport-stop .transport-circle{border-color:color-mix(in srgb,var(--accent) 45%,var(--border))}
.transport-stop .transport-glyph{width:12px;height:12px;border-radius:3px;background:var(--accent)}
.transport-stop .transport-label{color:var(--accent-text)}
.transport-end{display:flex;align-self:stretch;align-items:flex-start;margin-left:6px;padding-left:12px;border-left:1px solid var(--border)}
.transport-btn.transport-stop.is-armed .transport-circle,.transport-btn.transport-stop.is-armed:not(:disabled):hover .transport-circle{background:var(--accent);border-color:var(--accent)}
.transport-stop.is-armed .transport-glyph{background:#fff}
.transport-stop.is-armed .transport-label{font-weight:600}
.transport-clock{display:grid;gap:3px;min-width:150px}
.clock{font:500 30px/1 var(--mono);font-variant-numeric:tabular-nums;letter-spacing:-.02em;color:var(--text)}
.clock.is-live{color:var(--accent-text)}
.clock.is-paused{color:var(--warn-text)}
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
.count{font:500 11px var(--font);color:var(--text-3);background:var(--surface-2);border-radius:999px;padding:0 6px;letter-spacing:0;text-transform:none}
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
.clip-icon{flex:none;width:28px;height:28px;display:grid;place-items:center;border-radius:7px;background:var(--surface-2);color:var(--text-2);align-self:flex-start}
.clip-meta{min-width:0;flex:1;display:flex;align-items:baseline;gap:2px 10px;flex-wrap:wrap;font-size:12.5px}
.clip-name{flex-basis:100%;min-width:0;display:flex;align-items:center;gap:4px}
.clip-name-text{min-width:0;font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.clip-name-ai{display:inline-flex;color:var(--primary-text)}
.clip-rename{flex:none;display:grid;place-items:center;width:22px;height:22px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--text-3);cursor:pointer;opacity:0;transition:opacity .12s}
.saved-clip:hover .clip-rename,.clip-rename:focus-visible{opacity:1}
.clip-rename:hover{background:var(--surface-3);color:var(--text)}
.clip-name-input{flex-basis:100%;max-width:420px;font-size:13px;font-weight:600}
.clip-date{color:var(--text);font-weight:500}
.clip-format{color:var(--text-3);font-size:11.5px}
.clip-source{color:var(--text-2);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.clip-buttons{display:flex;align-items:center;gap:2px;flex:none}
.clip-buttons .clip-play{margin-right:4px}
.clip-texts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:8px;padding-left:38px}
.recording-text{background:var(--surface-2);border-radius:var(--radius-sm);padding:8px 10px;min-width:0;display:grid;gap:3px;align-content:start}
.recording-text h4{margin:0;font-size:11px;font-weight:600;display:flex;align-items:center;gap:5px;color:var(--text-3)}
.clip-excerpt{font-size:12.5px;color:var(--text);overflow-wrap:anywhere;white-space:pre-line;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.clip-missing{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding-left:38px}
.clip-missing-text{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--text-3);margin-right:auto}
.spinner{width:12px;height:12px;border-radius:50%;border:2px solid var(--border-strong);border-top-color:var(--text-2);animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.saved-clip .audio-player{margin-left:38px}
.audio-player{min-width:0;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 10px 6px;display:grid;gap:6px;outline:none}
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
.audio-player .grow{flex:1}
.mc-switch{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--text-2);cursor:pointer;user-select:none}
.mc-switch.is-disabled{opacity:.5;cursor:default}
.mc-switch-track{position:relative;flex:none;width:30px;height:18px;border-radius:999px;border:0;padding:0;background:var(--border-strong);cursor:inherit;transition:background .15s}
.mc-switch-track[aria-checked="true"]{background:var(--primary)}
.mc-switch-track:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.mc-switch-thumb{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgb(0 0 0 / 25%);transition:transform .15s}
.mc-switch-track[aria-checked="true"] .mc-switch-thumb{transform:translateX(12px)}
`;
