// Side panel: one card per recording in this browser (shared SessionCard), fed by the app's SSE.

import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Api, CARD_CSS, CardState, EngineEvent, SessionCard, SummaryMode } from "@multicorder/ui";

function App() {
  const [api, setApi] = useState<Api | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cards, setCards] = useState<Record<string, CardState>>({});
  const [missed, setMissed] = useState<Record<string, string[]>>({});
  const [mode, setMode] = useState<SummaryMode>("live");
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    chrome.storage.local.get("defaultMode").then((v) => v.defaultMode && setMode(v.defaultMode));
    chrome.runtime.sendMessage({ type: "pairing" }).then((r) => {
      if (r?.pairing) setApi(new Api(r.pairing));
      else setError("Multicorder for Mac is not running or not installed.");
    });
  }, []);

  async function refresh(a: Api) {
    const sessions = await a.sessions();
    const recent = sessions.filter((s) => s.kind === "chromium_tab").slice(0, 12);
    const next: Record<string, CardState> = {};
    for (const s of recent) {
      const [lines, insights] = await Promise.all([a.transcript(s.id), a.insights(s.id)]);
      next[s.id] = { session: s, lines: lines.slice(-3), insights, ...(cards[s.id] ? { levelDb: cards[s.id].levelDb } : {}) };
    }
    setCards(next);
  }

  useEffect(() => {
    if (!api) return;
    refresh(api).catch((e) => setError(String(e)));
    api
      .events((e: EngineEvent) => {
        setCards((prev) => {
          const c = prev[e.session_id];
          if (!c) {
            if (e.type === "status") refresh(api).catch(() => {});
            return prev;
          }
          const n = { ...c };
          if (e.type === "level") n.levelDb = e.rms_db;
          if (e.type === "status") {
            n.session = { ...c.session, status: e.status };
            n.detail = e.detail ?? null;
          }
          if (e.type === "transcript") n.lines = [...c.lines, e.event].slice(-3);
          if (e.type === "insight") n.insights = [...c.insights.filter((i) => i.key !== e.insight.key), e.insight].filter((i) => i.state !== "retracted");
          if (e.type === "backlog") n.backlog = e.pending_chunks;
          return { ...prev, [e.session_id]: n };
        });
      })
      .then((es) => (esRef.current = es))
      .catch((e) => setError(String(e)));
    return () => esRef.current?.close();
  }, [api]);

  const list = Object.values(cards).sort((a, b) => b.session.started_at.localeCompare(a.session.started_at));
  return (
    <main>
      <style>{CARD_CSS + PANEL_CSS}</style>
      <h1>Multicorder</h1>
      {error && (
        <p className="err">
          {error} <a href="onboarding.html" target="_blank">Set up</a>
        </p>
      )}
      <div className="row">
        <button className="primary" onClick={() => chrome.runtime.sendMessage({ type: "start-current" })}>Record this tab</button>
        <label>
          New recordings:{" "}
          <select value={mode} onChange={(e) => { setMode(e.target.value as SummaryMode); chrome.storage.local.set({ defaultMode: e.target.value }); }}>
            <option value="live">Live summary</option>
            <option value="after">Summary at end</option>
            <option value="off">Record only</option>
          </select>
        </label>
      </div>
      <p className="hint">Tip: click the toolbar icon or press Alt+Shift+R on any tab to add it. Each tab is recorded and summarised separately.</p>
      {list.length === 0 && !error && <p className="hint">No recordings yet.</p>}
      {list.map((c) => (
        <SessionCard
          key={c.session.id}
          state={c}
          missed={missed[c.session.id]}
          onMode={(m) => api?.setMode(c.session.id, m).then(() => setCards((p) => ({ ...p, [c.session.id]: { ...p[c.session.id], session: { ...p[c.session.id].session, summary_mode: m } } })))}
          onStop={() => chrome.runtime.sendMessage({ type: "stop", sessionId: c.session.id })}
          onMarker={() => api?.marker(c.session.id)}
          onMissed={() => api?.missed(c.session.id, 5).then((r) => setMissed((p) => ({ ...p, [c.session.id]: r.points.length ? r.points.map((x) => x.text) : ["Nothing new in the last 5 minutes."] })))}
        />
      ))}
    </main>
  );
}

const PANEL_CSS = `
body{font:13px -apple-system,system-ui,sans-serif;margin:0;padding:10px;color-scheme:light dark}
h1{font-size:15px;margin:0 0 8px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.primary{background:#d9482e;color:#fff;border:0;border-radius:6px;padding:6px 10px;cursor:pointer}
.hint{color:#888;font-size:12px}
.err{color:#b3261e}
`;

createRoot(document.getElementById("root")!).render(<App />);
