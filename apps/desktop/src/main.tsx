// Desktop UI: live board (sources playing now + one card per recording), library with session
// detail (transcript, key points with evidence, report, export) and settings.

import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CARD_CSS, CardState, EngineEvent, fmtTs, Insight, Session, SessionCard, SummaryMode, TranscriptEvent } from "@multicorder/ui";

interface AppInfo {
  app_id: string;
  name: string;
  pids: number[];
  is_emitting: boolean;
  capturing: boolean;
}

interface Status {
  asr: string;
  asr_ready: boolean;
  llm_ready: boolean;
  api_port: number;
  data_dir: string;
  spent_today_usd: number;
  daily_cap_usd: number;
}

const ACTIVE = ["starting", "capturing", "reconnecting", "stopping"];

function Live({ sessions, cards, setCards, refresh }: { sessions: Session[]; cards: Record<string, CardState>; setCards: React.Dispatch<React.SetStateAction<Record<string, CardState>>>; refresh: () => void }) {
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [mode, setMode] = useState<SummaryMode>("live");
  const [error, setError] = useState<string | null>(null);
  const [missed, setMissed] = useState<Record<string, string[]>>({});
  useEffect(() => {
    const load = () => invoke<AppInfo[]>("list_apps").then(setApps).catch((e) => setError(String(e)));
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, []);
  const active = sessions.filter((s) => ACTIVE.includes(s.status));
  return (
    <div className="live">
      <aside>
        <h2>Playing now</h2>
        <label className="small">
          Summary{" "}
          <select value={mode} onChange={(e) => setMode(e.target.value as SummaryMode)}>
            <option value="live">Live</option>
            <option value="after">At end</option>
            <option value="off">Record only</option>
          </select>
        </label>
        {error && <p className="err">{error}</p>}
        <ul className="apps">
          {apps.map((a) => (
            <li key={a.app_id} className={a.is_emitting ? "on" : ""}>
              <span>{a.is_emitting ? "🔊" : "·"} {a.name}</span>
              <button disabled={a.capturing} onClick={() => invoke("start_app_session", { appId: a.app_id, mode }).then(refresh).catch((e) => setError(String(e)))}>
                {a.capturing ? "Recording" : "Record"}
              </button>
            </li>
          ))}
        </ul>
        <p className="small">Browser tabs are recorded one by one with the Multicorder Chrome extension.</p>
      </aside>
      <section className="board">
        {active.length === 0 && <p className="hint">Nothing is recording. Pick an app on the left, or click the extension icon in a browser tab.</p>}
        {active.map((s) => {
          const c = cards[s.id] || { session: s, lines: [], insights: [] };
          return (
            <SessionCard
              key={s.id}
              state={{ ...c, session: { ...s, status: c.session.status || s.status } }}
              missed={missed[s.id]}
              onMode={(m) => invoke("set_mode", { id: s.id, mode: m }).then(refresh)}
              onStop={() => invoke("stop_session", { id: s.id }).then(refresh)}
              onMarker={() => invoke("add_marker", { id: s.id })}
              onMissed={() => invoke<{ points: { text: string }[] }>("missed", { id: s.id, minutes: 5 }).then((r) => setMissed((p) => ({ ...p, [s.id]: r.points.length ? r.points.map((x) => x.text) : ["Nothing new in the last 5 minutes."] })))}
            />
          );
        })}
      </section>
    </div>
  );
}

function Detail({ session, onBack }: { session: Session; onBack: () => void }) {
  const [lines, setLines] = useState<TranscriptEvent[]>([]);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [report, setReport] = useState<{ body: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    invoke<TranscriptEvent[]>("transcript", { id: session.id }).then(setLines);
    invoke<Insight[]>("insights", { id: session.id }).then(setInsights);
    invoke<{ body: string } | null>("report", { id: session.id }).then(setReport);
  }, [session.id]);
  const byId = useMemo(() => new Map(lines.map((l) => [l.id, l])), [lines]);
  const [focus, setFocus] = useState<string | null>(null);
  return (
    <div className="detail">
      <button onClick={onBack}>← Back</button>
      <h2>{session.title}</h2>
      <p className="small">{session.kind} · {session.status} · {fmtTs(session.audio_ms)} · started {new Date(session.started_at).toLocaleString()}</p>
      <div className="row">
        {(["md", "srt", "vtt", "json"] as const).map((f) => (
          <button key={f} onClick={() => invoke<string>("export", { id: session.id, format: f }).then((p) => setMsg(`Saved ${p}`))}>Export {f.toUpperCase()}</button>
        ))}
        {!ACTIVE.includes(session.status) && <button className="danger" onClick={() => invoke("delete_session", { id: session.id }).then(onBack)}>Delete</button>}
      </div>
      {msg && <p className="small">{msg}</p>}
      <div className="cols">
        <section>
          <h3>Key points</h3>
          <ul>
            {insights.map((i) => (
              <li key={i.key} className={`mc-${i.state}`}>
                {i.text}{" "}
                {i.evidence.map((e) => (
                  <a key={e.event_id} href="#" className="mc-ts" onClick={(ev) => { ev.preventDefault(); setFocus(e.event_id); document.getElementById(e.event_id)?.scrollIntoView({ block: "center" }); }}>
                    [{fmtTs(e.start_ms)}]
                  </a>
                ))}
              </li>
            ))}
          </ul>
          <h3>Report</h3>
          <pre className="report">{report?.body || "No report yet."}</pre>
        </section>
        <section className="transcript">
          <h3>Transcript</h3>
          {lines.map((l) => (
            <p key={l.id} id={l.id} className={focus === l.id ? "focus" : ""}>
              <span className="mc-ts">{fmtTs(l.start_ms)}</span> {l.text}
            </p>
          ))}
          {byId.size === 0 && <p className="hint">No transcript.</p>}
        </section>
      </div>
    </div>
  );
}

function App() {
  const [tab, setTab] = useState<"live" | "library" | "settings">("live");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [cards, setCards] = useState<Record<string, CardState>>({});
  const [selected, setSelected] = useState<Session | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const refresh = () => invoke<Session[]>("list_sessions").then(setSessions);
  useEffect(() => {
    refresh();
    invoke<Status>("status").then(setStatus);
    const un = listen<EngineEvent>("engine", ({ payload: e }) => {
      if (e.type === "status") refresh();
      setCards((prev) => {
        const c = prev[e.session_id] || ({ session: { id: e.session_id } as Session, lines: [], insights: [] } as CardState);
        const n = { ...c };
        if (e.type === "level") n.levelDb = e.rms_db;
        if (e.type === "status") { n.detail = e.detail ?? null; n.session = { ...c.session, status: e.status }; }
        if (e.type === "transcript") n.lines = [...c.lines, e.event].slice(-3);
        if (e.type === "insight") n.insights = [...c.insights.filter((i) => i.key !== e.insight.key), e.insight].filter((i) => i.state !== "retracted");
        if (e.type === "backlog") n.backlog = e.pending_chunks;
        return { ...prev, [e.session_id]: n };
      });
    });
    return () => { un.then((f) => f()); };
  }, []);
  return (
    <div className="app">
      <style>{CARD_CSS + APP_CSS}</style>
      <nav>
        <strong>Multicorder</strong>
        {(["live", "library", "settings"] as const).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => { setTab(t); setSelected(null); }}>{t[0].toUpperCase() + t.slice(1)}</button>
        ))}
      </nav>
      {tab === "live" && <Live sessions={sessions} cards={cards} setCards={setCards} refresh={refresh} />}
      {tab === "library" && !selected && (
        <table className="lib">
          <thead><tr><th>Source</th><th>Kind</th><th>Status</th><th>Length</th><th>Started</th></tr></thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id} onClick={() => setSelected(s)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setSelected(s)}>
                <td>{s.title}</td><td>{s.kind}</td><td>{s.status}</td><td>{fmtTs(s.audio_ms)}</td><td>{new Date(s.started_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {tab === "library" && selected && <Detail session={selected} onBack={() => setSelected(null)} />}
      {tab === "settings" && status && (
        <div className="settings">
          <p>Transcription: <strong>{status.asr}</strong> {status.asr_ready ? "✅" : "⚠️ no key"}</p>
          <p>Summaries: {status.llm_ready ? "✅ ready" : "⚠️ no model key"}</p>
          <p>Spent today: ${status.spent_today_usd.toFixed(3)} of ${status.daily_cap_usd.toFixed(2)}</p>
          <p>Local API for the extension: 127.0.0.1:{status.api_port}</p>
          <p className="small">Data folder: {status.data_dir} (config.json holds providers and keys).</p>
        </div>
      )}
    </div>
  );
}

const APP_CSS = `
:root{color-scheme:light dark}
body{margin:0;font:13px -apple-system,system-ui,sans-serif}
nav{display:flex;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid #8883}
nav button{border:0;background:none;padding:4px 8px;border-radius:6px;cursor:pointer}
nav button.on{background:#d9482e22;color:#d9482e}
.live{display:flex;height:calc(100vh - 42px)}
aside{width:260px;border-right:1px solid #8883;padding:10px;overflow:auto}
.apps{list-style:none;padding:0}
.apps li{display:flex;justify-content:space-between;align-items:center;padding:4px 0;gap:6px}
.apps li.on span{font-weight:600}
.board{flex:1;overflow:auto;padding:10px;display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:8px;align-content:start}
.small,.hint{color:#888;font-size:12px}
.err{color:#b3261e}
.lib{width:100%;border-collapse:collapse}.lib td,.lib th{padding:6px 10px;text-align:left;border-bottom:1px solid #8882}.lib tr{cursor:pointer}
.detail{padding:12px}.row{display:flex;gap:6px;flex-wrap:wrap}.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.transcript{max-height:70vh;overflow:auto}.focus{background:#d9482e22}
.report{white-space:pre-wrap;font:12px ui-monospace,monospace;background:#8881;padding:8px;border-radius:6px}
.danger{color:#b3261e}
.settings{padding:16px}
`;

createRoot(document.getElementById("root")!).render(<App />);
