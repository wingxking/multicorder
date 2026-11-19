import React, { lazy, Suspense, useEffect, useId, useState } from "react";
import { CardState, describeDetail, fmtTs, Icon, locale, Session, SummaryMode, t, WAITING_FOR_AUDIO } from "@multicorder/ui";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
const AudioEditor = lazy(() => import("./AudioEditor"));
export type RecordingFormat = { sample_rate: number; bits_per_sample: number };
export const DEFAULT_RECORDING_FORMAT: RecordingFormat = { sample_rate: 16000, bits_per_sample: 16 };

type Part = "transcript" | "summary";
type TextPreview = Record<Part, string | null>;
export type LiveCard = Omit<CardState, "session"> & { status?: string; peaks?: number[]; elapsed?: number; textRevision?: number };

const fmtFormat = (rate?: number, bits?: number) => `${(rate ?? 16000) / 1000} kHz · ${bits ?? 16}-bit`;

function TextAsset({ label, part, value, busy, saving, onGenerate, onCopy, onExport }: {
  label: string;
  part: Part;
  value: string | null;
  busy: boolean;
  saving: boolean;
  onGenerate: () => void;
  onCopy: () => void;
  onExport: (format: "txt" | "pdf") => void;
}) {
  const empty = part === "transcript" ? t("No transcript yet.") : t("No AI summary yet.");
  return (
    <section className="recording-text" aria-label={label}>
      <h4><Icon name={part === "transcript" ? "text" : "sparkle"} size={13} />{label}</h4>
      <p className={value ? "clip-excerpt" : "small muted"}>{value ?? empty}</p>
      <div className="clip-actions">
        {value ? <>
          <button className="btn btn-sm" aria-label={t("Copy {label}", { label })} onClick={onCopy}><Icon name="copy" size={13} />{t("Copy")}</button>
          {(["txt", "pdf"] as const).map((format) => (
            <button className="btn btn-sm" key={format} aria-label={t("Export {label} as {format}", { label, format: format.toUpperCase() })} onClick={() => onExport(format)}>{format.toUpperCase()}</button>
          ))}
        </> : (
          <button className="btn btn-sm" disabled={busy || saving} onClick={onGenerate}>
            {busy ? t("Generating…") : part === "transcript" ? t("Generate transcript") : t("Generate summary")}
          </button>
        )}
      </div>
    </section>
  );
}

export function SavedClip({ clip, revision, invoke, flash, showSource, onDetails }: { clip: Session; revision?: number; invoke: Invoke; flash: (text: string) => void; showSource?: boolean; onDetails?: () => void }) {
  const [preview, setPreview] = useState<TextPreview | null>(null);
  const [busy, setBusy] = useState<Part | "audio" | null>(null);
  const [audio, setAudio] = useState<Blob | null>(null);
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
      flash(String(error));
    }
  }

  async function loadAudio() {
    setBusy("audio");
    try {
      const bytes = await invoke<ArrayBuffer>("load_recording_audio", { id: clip.id });
      setAudio(new Blob([bytes], { type: "audio/wav" }));
    } catch (error) {
      flash(String(error));
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
      flash(String(error));
    } finally {
      setBusy(null);
    }
  }

  async function exportText(part: Part, format: "txt" | "pdf") {
    try {
      const path = await invoke<string>("export_recording_text", { id: clip.id, part, format });
      flash(t("Saved {path}", { path }));
    } catch (error) {
      flash(String(error));
    }
  }

  return (
    <li className="saved-clip">
      <header className="clip-head">
        <div className="clip-meta">
          {showSource && <h3 className="clip-source">{clip.title}</h3>}
          <div className="clip-sub">
            <span>{new Date(clip.started_at).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" })}</span>
            <span className="ts">{fmtTs(clip.audio_ms)}</span>
            <span className="small muted">{fmtFormat(clip.sample_rate, clip.bits_per_sample)}</span>
            {processing && <span className="chip info">{t("Processing")}</span>}
          </div>
        </div>
        <div className="clip-buttons">
          {onDetails && <button className="btn btn-sm" onClick={onDetails}>{t("Details")}</button>}
          <button className="btn btn-sm" disabled={busy !== null || saving} onClick={() => audio ? setAudio(null) : void loadAudio()}>
            <Icon name="scissors" size={13} />{busy === "audio" ? t("Loading…") : audio ? t("Close editor") : t("Edit audio")}
          </button>
          <button className="btn btn-sm" disabled={saving} onClick={() => void run("export_audio", {}, t("WAV saved to Downloads."))}><Icon name="download" size={13} />WAV</button>
        </div>
      </header>
      {audio && <Suspense fallback={<p className="small muted">{t("Opening waveform editor…")}</p>}>
        <AudioEditor audio={audio} onError={flash} onExport={async (startMs, endMs) => {
          const path = await invoke<string>("export_recording_selection", { id: clip.id, startMs, endMs });
          flash(t("Saved {path}", { path }));
        }} />
      </Suspense>}
      {preview && <div className="clip-texts">
        {(["transcript", "summary"] as const).map((part) => {
          const label = part === "transcript" ? t("Transcript") : t("AI summary");
          return (
            <TextAsset
              key={part} label={label} part={part}
              value={preview[part]} busy={busy === part} saving={saving || processing || (busy !== null && busy !== part)}
              onGenerate={() => void generate(part)}
              onCopy={() => void run("copy_recording_text", { part }, t("Copied."))}
              onExport={(format) => void exportText(part, format)}
            />
          );
        })}
      </div>}
    </li>
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

export function RecordingPanel({ title, originalName, kind, session, card, clips, cards, canStart, willWait, lastFailure, format, setFormat, invoke, flash, onStart, refresh }: {
  title: string;
  originalName?: string;
  kind: Session["kind"];
  format: RecordingFormat;
  setFormat: (format: RecordingFormat) => void;
  session?: Session;
  card?: LiveCard;
  clips: Session[];
  cards: Record<string, LiveCard>;
  canStart: boolean;
  willWait: boolean;
  lastFailure?: string | null;
  invoke: Invoke;
  flash: (text: string) => void;
  onStart: () => Promise<void>;
  refresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(5);
  const [missed, setMissed] = useState<string[]>([]);
  const headingId = useId();
  const phase = card?.status ?? session?.status;
  const paused = phase === "paused";
  const waiting = phase === "waiting";
  const finishing = phase === "stopping" || phase === "stopped" || phase === "failed";
  const live = !!session && !paused && !waiting && !finishing;
  const note = describeDetail(card?.detail);
  const elapsed = card?.elapsed ?? session?.audio_ms ?? 0;
  const peaks = card?.peaks ?? [];
  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    try {
      await work();
      refresh();
    } catch (error) {
      flash(String(error));
    } finally {
      setBusy(false);
    }
  }
  const changeMode = (mode: SummaryMode) => session && action(() => invoke("set_mode", { id: session.id, mode }));

  return (
    <article className={`source-panel${live ? " is-live" : ""}`} aria-labelledby={headingId}>
      <header className="source-panel-head">
        <span className="source-panel-icon"><Icon name={kind === "mic" ? "mic" : kind === "chromium_tab" ? "tab" : "app"} /></span>
        <div className="source-panel-title">
          <h2 id={headingId}>{title}</h2>
          {originalName && <div className="source-original-name">{originalName}</div>}
        </div>
        <span className={`chip ${phase === "capturing" ? "rec" : session ? "info" : canStart ? "ok" : ""}`}>
          {phase === "capturing" && <span className="dot" />}
          {phaseLabel(phase, !!session, canStart, kind)}
        </span>
      </header>
      <div className="wave-block">
        <div className={`waveform ${paused || !peaks.length ? "waveform-paused" : ""}`} role="img" aria-label={t("Audio waveform, {time} recorded", { time: fmtTs(elapsed) })}>
          {Array.from({ length: 96 }, (_, i) => {
            const sample = peaks[i + peaks.length - 96] ?? 0;
            const height = Math.max(3, Math.min(100, Math.sqrt(sample) * 100));
            return <span key={i} style={{ height: `${height}%` }} />;
          })}
        </div>
        <span className="wave-time">{fmtTs(elapsed)}</span>
      </div>
      {waiting && <p className="small muted" role="status">{t(WAITING_FOR_AUDIO)}</p>}
      {!session && lastFailure === "no_audio" && <p className="small muted" role="status">{t("No sound was detected, so no audio was saved.")}</p>}
      {!session && lastFailure?.startsWith("capture_failed: ") && <p className="banner warn" role="status">{lastFailure.slice("capture_failed: ".length)}</p>}
      {note && <p className="small muted" role="status">{note}</p>}
      <div className="recording-bar">
        <div className="recording-controls">
          {!session ? kind === "chromium_tab" ? (
            <p className="small muted">{t("Start this source from the Multicorder extension in Chrome.")}</p>
          ) : (
            <button className="btn btn-primary btn-lg" disabled={!canStart || busy} title={willWait ? t(WAITING_FOR_AUDIO) : undefined} onClick={() => void action(onStart)}><Icon name="record" />{t("Start recording")}</button>
          ) : (
            <>
              <button className="btn" disabled={busy || finishing || phase === "starting"} onClick={() => void action(() => invoke("pause_session", { id: session.id, paused: !paused }))}>
                <Icon name={paused ? "play" : "pause"} />{paused ? t("Resume") : t("Pause")}
              </button>
              <button className="btn mc-stop" disabled={busy || finishing} onClick={() => void action(() => invoke("stop_session", { id: session.id }))}><Icon name="stop" />{t("End & save")}</button>
              {!waiting && !paused && !finishing && <button className="btn icon-btn" title={t("Add marker")} aria-label={t("Add marker")} onClick={() => void action(() => invoke("add_marker", { id: session.id }))}><Icon name="flag" /></button>}
              {card?.lines.length ? <button className="btn icon-btn" title={t("What did I miss?")} aria-label={t("What did I miss?")} onClick={() => void action(async () => {
                const result = await invoke<{ points: { text: string }[] }>("missed", { id: session.id, minutes: 5 });
                setMissed(result?.points.map((point) => point.text) ?? []);
              })}><Icon name="clock" /></button> : null}
            </>
          )}
        </div>
        <div className="recording-format">
          {session ? (
            <>
              <select className="input" aria-label={t("Summary mode")} disabled={finishing} value={session.summary_mode} onChange={(e) => void changeMode(e.target.value as SummaryMode)}>
                <option value="live">{t("Live summary")}</option>
                <option value="after">{t("Summary at end")}</option>
                <option value="off">{t("Audio only")}</option>
              </select>
              <span className="small muted">{fmtFormat(session.sample_rate, session.bits_per_sample)} · {t("Mono")}</span>
            </>
          ) : kind === "chromium_tab" ? (
            <span className="small muted">16 kHz · 16-bit · {t("Mono")}</span>
          ) : <>
            <label><span>{t("Sample rate")}</span><select className="input" value={format.sample_rate} disabled={busy} onChange={(e) => setFormat({ ...format, sample_rate: Number(e.target.value) })}>
              {[16000, 24000, 32000, 44100, 48000].map((rate) => <option key={rate} value={rate}>{rate / 1000} kHz</option>)}
            </select></label>
            <label><span>{t("Audio quality")}</span><select className="input" value={format.bits_per_sample} disabled={busy} onChange={(e) => setFormat({ ...format, bits_per_sample: Number(e.target.value) })}>
              <option value={16}>16-bit PCM</option><option value={24}>24-bit PCM</option>
            </select></label>
            <span className="small muted">{t("Mono")}</span>
          </>}
        </div>
      </div>
      {session && !!card?.lines.length && <div className="panel-captions" aria-live="polite">{card.lines.slice(-2).map((line) => <p key={line.id}><span className="ts">{fmtTs(line.start_ms)}</span> {line.text}</p>)}</div>}
      {session && !!card?.insights.length && <ul className="panel-points" aria-label={t("Key points")}>{card.insights.slice(-3).map((point) => <li key={point.key}>{point.text}</li>)}</ul>}
      {session && missed.length > 0 && <ul className="panel-points missed" aria-label={t("What you missed")}>{missed.map((point, index) => <li key={index}>{point}</li>)}</ul>}
      <section className="source-clips">
        <h3>{t("Recordings")}{clips.length > 0 && <span className="count">{clips.length}</span>}</h3>
        {clips.length ? (
          <ul>{clips.slice(0, visible).map((clip) => (
            <SavedClip key={clip.id} clip={clip} revision={cards[clip.id]?.textRevision} invoke={invoke} flash={flash} />
          ))}</ul>
        ) : <p className="small muted">{t("Recordings from this source are saved locally.")}</p>}
        {visible < clips.length && <button className="btn" onClick={() => setVisible((count) => count + 5)}>{t("Show more recordings")}</button>}
      </section>
    </article>
  );
}

export const RECORDING_CSS = `
.source-panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);padding:18px;display:grid;gap:14px}
.source-panel-head{display:flex;align-items:center;gap:12px}
.source-panel-icon{width:38px;height:38px;flex:none;display:grid;place-items:center;border-radius:10px;background:var(--surface-2);color:var(--text-2)}
.is-live .source-panel-icon{background:var(--accent-weak);color:var(--accent-text)}
.source-panel-title{min-width:0;flex:1}.source-panel-title h2{margin:0;font-size:17px;overflow-wrap:anywhere}
.source-panel .grow{flex:1}
.source-panel p{margin:0}
.wave-block{position:relative}
.waveform{height:84px;display:flex;align-items:center;gap:2px;background:var(--surface-2);padding:12px 74px 12px 12px;border-radius:var(--radius-md);overflow:hidden}
.waveform span{flex:1;min-width:1px;background:var(--accent);border-radius:2px;transition:height .12s}
.waveform-paused span{background:var(--border-strong)}
.wave-time{position:absolute;right:12px;top:50%;transform:translateY(-50%);font:600 15px var(--mono);font-variant-numeric:tabular-nums;color:var(--text)}
.recording-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.recording-controls,.clip-actions,.clip-buttons{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.btn-lg{height:34px;padding:0 16px;font-size:13px}
.recording-format,.editor-controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.recording-format label,.editor-zoom{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-2)}
.panel-captions{margin:0;color:var(--text-2);font-size:12.5px;background:var(--surface-2);border-radius:var(--radius-sm);padding:8px 10px;display:grid;gap:2px}
.panel-points{margin:0;padding:0 0 0 18px;color:var(--text);font-size:12.5px;display:grid;gap:3px}
.panel-points.missed li::marker{color:var(--info)}
.source-clips{border-top:1px solid var(--border);padding-top:12px}
.source-clips h3{margin:0 0 10px;display:flex;align-items:center;gap:6px}
.count{font:500 11px var(--font);color:var(--text-3);background:var(--surface-2);border-radius:999px;padding:0 6px;letter-spacing:0;text-transform:none}
.source-clips>ul{list-style:none;margin:0 0 10px;padding:0;display:grid;gap:10px}
.saved-clip{border:1px solid var(--border);border-radius:var(--radius-md);padding:12px;display:grid;gap:10px;background:var(--surface)}
.clip-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap}
.clip-meta{min-width:0;display:grid;gap:2px}
.clip-sub{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--text-2);font-size:12px}
.clip-source{margin:0;font-size:14px;font-weight:600;color:var(--text);text-transform:none;letter-spacing:-.01em}
.audio-editor{min-width:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px;display:grid;gap:8px}
.editor-wave{min-width:0}.editor-seek{flex:1;min-width:100px;accent-color:var(--accent)}.editor-zoom input{width:80px;accent-color:var(--accent)}
.clip-texts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:8px}
.recording-text{background:var(--surface-2);border-radius:var(--radius-sm);padding:10px;min-width:0;display:grid;gap:6px;align-content:start}
.recording-text h4{margin:0;font-size:12px;font-weight:600;display:flex;align-items:center;gap:5px;color:var(--text-2)}
.clip-excerpt{font-size:12.5px;color:var(--text);overflow-wrap:anywhere;white-space:pre-line;display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}
`;
