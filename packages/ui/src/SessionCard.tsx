import React from "react";
import { CaptionSource, fmtTs, Insight, Session, SummaryMode, TranscriptEvent } from "./api";
import { Icon } from "./icons";
import { locale, t, tError } from "./i18n";

export interface AsrHealth {
  state: "ok" | "degraded";
  failed_chunks: number;
  failed_ms?: number;
}

export interface CardState {
  session: Session;
  levelDb?: number;
  detail?: string | null;
  lines: TranscriptEvent[];
  insights: Insight[];
  backlog?: number;
  asr?: AsrHealth;
  retrying?: boolean;
  /** Where the text comes from right now (platform subtitles or speech recognition). */
  textSource?: { source: CaptionSource | null; active: boolean };
}

export const ACTIVE_SESSION_STATUSES = ["starting", "waiting", "capturing", "paused", "reconnecting", "stopping"];
export const WAITING_FOR_AUDIO = "No audio detected yet. Recording starts automatically when this source plays sound.";
const MODES: { m: SummaryMode; label: string; hint: string }[] = [
  { m: "live", label: "Live", hint: "Transcribe and summarise while recording" },
  { m: "after", label: "At end", hint: "Transcribe and summarise when recording stops" },
  { m: "off", label: "Off", hint: "Record audio only" },
];

export function levelPct(db?: number): number {
  if (db === undefined) return 0;
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
}

function statusChip(status: string, degraded: boolean, empty: boolean) {
  if (status === "waiting") return <span className="chip info"><span className="dot" />{t("Waiting for audio")}</span>;
  if (status === "paused") return <span className="chip warn">{t("Paused")}</span>;
  if (status === "capturing" || status === "starting") return <span className="chip rec"><span className="dot" />{t("Recording")}</span>;
  if (status === "reconnecting") return <span className="chip warn"><span className="dot" />{t("Reconnecting")}</span>;
  if (status === "stopping") return <span className="chip info">{t("Finishing")}</span>;
  if (status === "processing") return <span className="chip info">{t("Processing")}</span>;
  if (status === "failed") return <span className="chip err">{t("Failed")}</span>;
  if (empty) return <span className="chip">{t("No audio")}</span>;
  return degraded ? <span className="chip warn">{t("Text missing")}</span> : <span className="chip">{t("Done")}</span>;
}

/** Human message for status details coming from the engines. */
export function describeDetail(detail?: string | null): string | null {
  if (!detail) return null;
  if (detail.startsWith("asr_unavailable") || detail.startsWith("asr_error")) return null; // shown by the ASR banner
  if (detail === "asr_recovered") return t("Transcription is back; missing text was filled in.");
  if (detail === "permission_suspected") return t("No sound received. Allow “System Audio Recording” for Multicorder in System Settings.");
  if (detail === "source_silent") return t("The source is silent.");
  if (detail === "no_audio") return t("No sound was detected, so no audio was saved.");
  if (detail.startsWith("model_error") || detail.startsWith("report_error")) return t("Summary service unavailable; it will be retried.");
  if (detail.startsWith("mode:") || detail === "user" || detail.startsWith("retap")) return null;
  return tError(detail);
}

/** One card per audio source (shared by the extension side panel and the desktop app). */
export function SessionCard(props: {
  state: CardState;
  onMode: (m: SummaryMode) => void;
  onStop: () => void;
  onMissed?: () => void;
  onMarker?: () => void;
  onRetry?: () => void;
  onSaveAudio?: () => void;
  onOpen?: () => void;
  missed?: string[];
}) {
  const { session, levelDb, detail, lines, insights, backlog, asr, retrying } = props.state;
  const active = ACTIVE_SESSION_STATUSES.includes(session.status);
  const waiting = session.status === "waiting";
  const empty = session.failure === "no_audio" || detail === "no_audio";
  const degraded = (asr?.state === "degraded" && (asr.failed_chunks ?? 0) > 0) || !!detail?.startsWith("asr_unavailable") || !!detail?.startsWith("asr_error");
  const icon = session.kind === "chromium_tab" ? "tab" : session.kind === "mac_app" ? "app" : "mic";
  const note = describeDetail(detail);
  return (
    <section className={`mc-card${active ? " mc-active" : ""}`} aria-label={session.title}>
      <header className="mc-head">
        <span className="mc-src"><Icon name={icon} /></span>
        <div className="mc-titles">
          <button className="mc-title" onClick={props.onOpen} disabled={!props.onOpen} title={session.title}>{session.title}</button>
          <span className="ts">{fmtTs(session.audio_ms || 0)} · {new Date(session.started_at).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
        {statusChip(session.status, degraded, empty)}
      </header>
      {active && (
        <div className="mc-meter" role="meter" aria-label={t("Input level")} aria-valuenow={Math.round(levelPct(levelDb))} aria-valuemin={0} aria-valuemax={100}>
          <div style={{ width: `${levelPct(levelDb)}%` }} />
        </div>
      )}
      {degraded && (
        <div className="banner warn" role="status">
          <Icon name="warn" />
          <span className="grow">
            {t("Transcription unavailable — the recording itself is safe.")}{" "}
            {asr?.failed_chunks ? t("{n} part(s) waiting; text fills in automatically when the service is back.", { n: asr.failed_chunks }) : t("Text fills in automatically when the service is back.")}
          </span>
          {props.onRetry && (
            <button className="btn" onClick={props.onRetry} disabled={retrying}>
              <Icon name="retry" />{retrying ? t("Retrying…") : t("Retry")}
            </button>
          )}
        </div>
      )}
      {note && <p className="mc-note">{note}</p>}
      {waiting && <p className="mc-note" role="status">{t(WAITING_FOR_AUDIO)}</p>}
      {!!backlog && backlog > 1 && !degraded && <p className="mc-note">{t("Captions catching up · {n} queued", { n: backlog })}</p>}
      <div className="mc-controls">
        <div className="seg" role="group" aria-label={t("Summary")}>
          {MODES.map(({ m, label, hint }) => (
            <button key={m} title={t(hint)} aria-pressed={session.summary_mode === m} disabled={!active} onClick={() => props.onMode(m)}>{t(label)}</button>
          ))}
        </div>
        <span className="grow" />
        {active && !waiting && props.onMarker && <button className="btn btn-ghost icon-btn" title={t("Add a marker")} aria-label={t("Add a marker")} onClick={props.onMarker}><Icon name="flag" /></button>}
        {props.onMissed && <button className="btn btn-ghost icon-btn" title={t("What did I miss? (last 5 min)")} aria-label={t("What did I miss?")} onClick={props.onMissed}><Icon name="clock" /></button>}
        {props.onSaveAudio && !waiting && !empty && <button className="btn btn-ghost icon-btn" title={t("Save audio")} aria-label={t("Save audio")} onClick={props.onSaveAudio}><Icon name="download" /></button>}
        {!active && !degraded && !empty && props.onRetry && <button className="btn btn-ghost icon-btn" title={t("Transcribe again")} aria-label={t("Transcribe again")} onClick={props.onRetry}><Icon name="retry" /></button>}
        {active && <button className="btn mc-stop" onClick={props.onStop}><Icon name="stop" />{t("Stop")}</button>}
      </div>
      {props.missed && props.missed.length > 0 && (
        <ul className="mc-list mc-missed" aria-label={t("What you missed")}>
          {props.missed.map((m, i) => <li key={i}>{m}</li>)}
        </ul>
      )}
      {insights.length > 0 && (
        <ul className="mc-list" aria-label={t("Key points")}>
          {insights.slice(-3).map((i) => (
            <li key={i.key} className={i.state === "tentative" ? "mc-tentative" : ""}>
              <span>{i.text}</span> <span className="ts">{fmtTs(i.evidence[0]?.start_ms ?? 0)}</span>
            </li>
          ))}
        </ul>
      )}
      {lines.length > 0 && (
        <div className="mc-captions" aria-live="polite">
          {lines.slice(-2).map((l) => (
            <p key={l.id}><span className="ts">{fmtTs(l.start_ms)}</span> {l.text}</p>
          ))}
        </div>
      )}
    </section>
  );
}

export const CARD_CSS = `
.mc-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:12px 12px 10px;box-shadow:var(--shadow);display:flex;flex-direction:column;gap:9px;transition:border-color .15s}
.mc-card.mc-active{border-color:color-mix(in srgb,var(--accent) 35%,var(--border))}
.mc-head{display:flex;gap:10px;align-items:center}
.mc-src{width:30px;height:30px;border-radius:8px;background:var(--surface-2);color:var(--text-2);display:grid;place-items:center;flex:none}
.mc-active .mc-src{background:var(--accent-weak);color:var(--accent-text)}
.mc-titles{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.mc-title{all:unset;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
.mc-title:disabled{cursor:default}
.mc-title:not(:disabled):hover{color:var(--primary-text)}
.mc-title:focus-visible{outline:2px solid var(--focus);border-radius:4px}
.mc-meter{height:4px;background:var(--surface-2);border-radius:4px;overflow:hidden}
.mc-meter div{height:4px;background:linear-gradient(90deg,var(--ok),var(--accent));border-radius:4px;transition:width .25s}
.mc-controls{display:flex;gap:4px;align-items:center;flex-wrap:wrap}
.mc-controls .grow{flex:1}
.mc-stop{color:var(--accent-text)}
.mc-stop:hover{background:var(--accent-weak);border-color:color-mix(in srgb,var(--accent) 35%,transparent)}
.mc-note{margin:0;font-size:12px;color:var(--text-2)}
.mc-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}
.mc-list li{position:relative;padding-left:13px;font-size:12.5px;line-height:1.5}
.mc-list li::before{content:"";position:absolute;left:3px;top:.62em;width:5px;height:5px;border-radius:50%;background:var(--text-3)}
.mc-tentative span:first-child{color:var(--text-2)}
.mc-missed li::before{background:var(--info)}
.mc-captions{border-top:1px solid var(--border);padding-top:7px;font-size:12px;color:var(--text-2)}
.mc-captions p{margin:2px 0}
`;
