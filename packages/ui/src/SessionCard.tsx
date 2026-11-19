import React from "react";
import { fmtTs, Insight, Session, SummaryMode, TranscriptEvent } from "./api";

export interface CardState {
  session: Session;
  levelDb?: number;
  detail?: string | null;
  lines: TranscriptEvent[];
  insights: Insight[];
  backlog?: number;
}

const MODE_LABEL: Record<SummaryMode, string> = { off: "Record only", live: "Live summary", after: "Summary at end" };

export function levelPct(db?: number): number {
  if (db === undefined) return 0;
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
}

/** One card per audio source (shared by the extension side panel and the desktop app). */
export function SessionCard(props: {
  state: CardState;
  onMode: (m: SummaryMode) => void;
  onStop: () => void;
  onMissed?: () => void;
  onMarker?: () => void;
  missed?: string[];
}) {
  const { session, levelDb, detail, lines, insights, backlog } = props.state;
  const active = ["starting", "capturing", "reconnecting", "stopping"].includes(session.status);
  const icon = session.kind === "chromium_tab" ? "🌐" : session.kind === "mac_app" ? "🖥️" : "🎙️";
  return (
    <section className="mc-card" aria-label={`${session.title}, ${session.status}`}>
      <header>
        <span className="mc-icon" aria-hidden>{icon}</span>
        <strong className="mc-title" title={session.title}>{session.title}</strong>
        <span className={`mc-status mc-status-${session.status}`}>{session.status}</span>
      </header>
      {active && (
        <div className="mc-meter" role="meter" aria-label="Input level" aria-valuenow={Math.round(levelPct(levelDb))} aria-valuemin={0} aria-valuemax={100}>
          <div style={{ width: `${levelPct(levelDb)}%` }} />
        </div>
      )}
      {detail && <p className="mc-detail" role="status">{detail}</p>}
      {!!backlog && backlog > 0 && <p className="mc-detail">Captions behind: {backlog} chunk(s) queued</p>}
      <div className="mc-controls">
        <label>
          Summary{" "}
          <select value={session.summary_mode} onChange={(e) => props.onMode(e.target.value as SummaryMode)} disabled={!active}>
            {(Object.keys(MODE_LABEL) as SummaryMode[]).map((m) => (
              <option key={m} value={m}>{MODE_LABEL[m]}</option>
            ))}
          </select>
        </label>
        {active && props.onMarker && <button onClick={props.onMarker}>Mark</button>}
        {props.onMissed && <button onClick={props.onMissed}>What did I miss?</button>}
        {active && <button className="mc-stop" onClick={props.onStop}>Stop</button>}
      </div>
      {props.missed && props.missed.length > 0 && (
        <ul className="mc-missed" aria-label="What you missed">
          {props.missed.map((m, i) => <li key={i}>{m}</li>)}
        </ul>
      )}
      {insights.length > 0 && (
        <ul className="mc-insights" aria-label="Key points">
          {insights.slice(-3).map((i) => (
            <li key={i.key} className={`mc-${i.state}`}>
              {i.text} <span className="mc-ts">[{fmtTs(i.evidence[0]?.start_ms ?? 0)}]</span>
            </li>
          ))}
        </ul>
      )}
      {lines.length > 0 && (
        <div className="mc-captions" aria-live="polite">
          {lines.slice(-2).map((l) => (
            <p key={l.id}><span className="mc-ts">{fmtTs(l.start_ms)}</span> {l.text}</p>
          ))}
        </div>
      )}
    </section>
  );
}

export const CARD_CSS = `
.mc-card{border:1px solid var(--mc-border,#ddd);border-radius:10px;padding:10px 12px;margin:8px 0;background:var(--mc-bg,#fff)}
.mc-card header{display:flex;gap:6px;align-items:center}
.mc-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mc-status{font-size:11px;padding:1px 6px;border-radius:8px;background:#eee}
.mc-status-capturing{background:#fde2dd;color:#b3261e}
.mc-meter{height:4px;background:#eee;border-radius:2px;margin:6px 0}
.mc-meter div{height:4px;background:#d9482e;border-radius:2px;transition:width .2s}
.mc-controls{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:6px 0}
.mc-controls button,.mc-controls select{font-size:12px}
.mc-stop{color:#b3261e}
.mc-detail{font-size:11px;color:#8a5a00;margin:2px 0}
.mc-insights,.mc-missed{margin:6px 0;padding-left:18px;font-size:13px}
.mc-tentative{opacity:.75}
.mc-captions{font-size:12px;color:#555}
.mc-captions p{margin:2px 0}
.mc-ts{font-family:ui-monospace,monospace;font-size:11px;color:#888}
@media (prefers-color-scheme: dark){.mc-card{--mc-bg:#1f1f1f;--mc-border:#333;color:#eee}.mc-status{background:#333}.mc-captions{color:#bbb}.mc-meter{background:#333}}
`;
