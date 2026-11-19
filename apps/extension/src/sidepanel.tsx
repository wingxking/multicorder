// Side panel: record the current tab, one card per recording (in-browser recordings and, when the
// Mac app is used for processing, the app's tab recordings), service status, duplicate warnings.

import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ACTIVE_SESSION_STATUSES, Api, applyTheme, CARD_CSS, CardState, EngineEvent, Icon, LangToggle, Session, SessionCard, SummaryMode, t, THEME_CSS, ThemeToggle, useLang, useToast } from "@multicorder/ui";
import * as db from "./local/db";
import { loadSettings, saveSettings, SERVICE_LABEL, ServiceEnv } from "./local/settings";
import { TabSources } from "./TabSources";

type Backend = "local" | "app";
type Card = CardState & { backend: Backend };
interface Warning {
  code: string;
  session_id: string;
  tabSessionId: string;
}
interface Health {
  env: ServiceEnv;
  ok: boolean;
  detail: string;
}

function toSession(s: db.LocalSession): Session {
  return { ...s, url: s.url ?? null } as unknown as Session;
}

async function localCard(s: db.LocalSession): Promise<Card> {
  const lines = (await db.transcript(s.id)).slice(-3).map((e) => ({ id: e.id, session_id: e.sessionId, start_ms: e.startMs, end_ms: e.endMs, state: e.state, text: e.text, engine: e.engine }));
  return { backend: "local", session: toSession(s), lines, insights: (await db.insights(s.id)) as any, asr: s.asr };
}

function save(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function App() {
  useLang();
  const [api, setApi] = useState<Api | null>(null);
  const [processing, setProcessing] = useState<"standalone" | "app">("standalone");
  const [health, setHealth] = useState<Health | null>(null);
  const [cards, setCards] = useState<Record<string, Card>>({});
  const [missed, setMissed] = useState<Record<string, string[]>>({});
  const [mode, setMode] = useState<SummaryMode>("live");
  const [silent, setSilent] = useState(true);
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const [toast, flash] = useToast(3500);
  const esRef = useRef<EventSource | null>(null);
  const apiRef = useRef<Api | null>(null);

  const apply = (e: EngineEvent | any, backend: Backend) => {
    if (e.type === "waveform") return;
    setCards((prev) => {
      const c = prev[e.session_id];
      if (!c) {
        if (e.type === "status") void refresh();
        return prev;
      }
      if (c.backend !== backend) return prev;
      const n = { ...c };
      if (e.type === "level") n.levelDb = e.rms_db;
      if (e.type === "status") {
        n.session = { ...c.session, status: e.status };
        n.detail = e.detail ?? null;
        if (e.detail === "asr_recovered") n.asr = { state: "ok", failed_chunks: 0 };
      }
      if (e.type === "asr") n.asr = e.asr;
      if (e.type === "transcript") n.lines = [...c.lines, e.event].slice(-3);
      if (e.type === "insight") n.insights = [...c.insights.filter((i) => i.key !== e.insight.key), e.insight].filter((i) => i.state !== "retracted");
      if (e.type === "backlog") n.backlog = e.pending_chunks;
      return { ...prev, [e.session_id]: n };
    });
  };

  async function refresh() {
    const a = apiRef.current;
    const next: Record<string, Card> = {};
    for (const s of (await db.listSessions()).slice(0, 15)) next[s.id] = await localCard(s);
    if (a) {
      try {
        for (const s of (await a.sessions()).filter((x) => x.kind === "chromium_tab").slice(0, 10)) {
          const [lines, insights] = await Promise.all([a.transcript(s.id), a.insights(s.id)]);
          next[s.id] = { backend: "app", session: s, lines: lines.slice(-3), insights, asr: s.asr };
        }
      } catch {
        /* app went away */
      }
    }
    setCards((prev) => {
      for (const id of Object.keys(next)) if (prev[id]?.levelDb !== undefined) next[id].levelDb = prev[id].levelDb;
      return next;
    });
  }

  useEffect(() => {
    let mounted = true;
    const connect = (pairing: Api["pairing"] | null) => {
      if (!mounted) return;
      const current = apiRef.current?.pairing;
      if (current?.port === pairing?.port && current?.token === pairing?.token) {
        if (!current) void refresh();
        return;
      }
      esRef.current?.close();
      const a = pairing ? new Api(pairing) : null;
      apiRef.current = a;
      setApi(a);
      void refresh();
      a?.events((e) => apply(e, "app")).then((es) => {
        if (mounted && apiRef.current === a) esRef.current = es;
        else es.close();
      }).catch(() => {});
    };
    chrome.storage.local.get("theme").then((v) => v.theme && applyTheme(v.theme));
    loadSettings().then((s) => {
      setMode(s.defaultMode);
      setSilent(s.silentCapture);
      setProcessing(s.appConnection);
    });
    chrome.storage.session.get("warnings").then((v) => setWarnings((v.warnings as Warning[]) || []));
    const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "session" && changes.warnings) setWarnings((changes.warnings.newValue as Warning[]) || []);
      if (area === "session" && changes.pairing) connect(changes.pairing.newValue ?? null);
      if (area === "local" && changes.settings) {
        void loadSettings().then((s) => {
          setProcessing(s.appConnection);
          setMode(s.defaultMode);
          setSilent(s.silentCapture);
        });
        void chrome.runtime.sendMessage({ type: "service-health" }).then(setHealth);
      }
    };
    chrome.storage.onChanged.addListener(onStorage);
    const onMsg = (m: any) => {
      if (m?.type === "local-event") apply(m.event, "local");
    };
    chrome.runtime.onMessage.addListener(onMsg);
    void chrome.runtime.sendMessage({ type: "pairing" }).then((r) => connect(r?.pairing ?? null)).catch(() => connect(null));
    const check = () => chrome.runtime.sendMessage({ type: "service-health" }).then(setHealth).catch(() => {});
    void check();
    const t = setInterval(check, 15000);
    return () => {
      mounted = false;
      clearInterval(t);
      chrome.runtime.onMessage.removeListener(onMsg);
      chrome.storage.onChanged.removeListener(onStorage);
      esRef.current?.close();
    };
  }, []);

  async function updateSettings(patch: { defaultMode?: SummaryMode; silentCapture?: boolean }) {
    await saveSettings({ ...(await loadSettings()), ...patch });
  }

  async function onMode(c: Card, m: SummaryMode) {
    if (c.backend === "app") await api?.setMode(c.session.id, m);
    else await chrome.runtime.sendMessage({ type: "local-mode", sessionId: c.session.id, mode: m });
    setCards((p) => ({ ...p, [c.session.id]: { ...p[c.session.id], session: { ...p[c.session.id].session, summary_mode: m } } }));
  }

  async function onMissed(c: Card) {
    try {
      if (c.backend === "app" && !api) throw new Error(t("Mac app offline"));
      const r = c.backend === "app" ? await api!.missed(c.session.id, 5) : await chrome.runtime.sendMessage({ type: "local-missed", sessionId: c.session.id, minutes: 5 });
      setMissed((p) => ({ ...p, [c.session.id]: r?.points?.length ? r.points.map((x: { text: string }) => x.text) : [t("Nothing new in the last 5 minutes.")] }));
    } catch (e) {
      flash(String(e));
    }
  }

  async function onRetry(c: Card) {
    setCards((p) => ({ ...p, [c.session.id]: { ...p[c.session.id], retrying: true } }));
    try {
      if (c.backend === "app") {
        if (!api) throw new Error(t("Mac app offline"));
        const r = await api.retryAsr(c.session.id);
        flash(r.queued ? t("Retrying {n} part(s)…", { n: r.queued }) : t("Nothing to retry."));
      } else {
        const r = await chrome.runtime.sendMessage({ type: "local-retry", sessionId: c.session.id });
        flash(r?.error ? t("Retry failed: {error}", { error: r.error }) : r?.remaining ? t("Service still unavailable — {n} part(s) waiting.", { n: r.remaining }) : r?.filled ? t("Filled in {n} part(s).", { n: r.filled }) : t("Nothing to retry."));
      }
    } catch (e) {
      flash(t("Retry failed: {error}", { error: String(e) }));
    } finally {
      setCards((p) => ({ ...p, [c.session.id]: { ...p[c.session.id], retrying: false } }));
      void refresh();
    }
  }

  async function onSaveAudio(c: Card) {
    try {
      if (c.backend === "app") {
        if (!api) throw new Error(t("Mac app offline"));
        return save(`multicorder-${c.session.id}.wav`, await api.audioBlob(c.session.id));
      }
      await chrome.runtime.sendMessage({ type: "local-flush", sessionId: c.session.id });
      const f = await db.recordingFile(c.session.id);
      if (f && f.size) save(`multicorder-${c.session.id}.webm`, f);
      else flash(t("No audio recorded yet."));
    } catch (e) {
      flash(t("Could not save audio: {error}", { error: String(e) }));
    }
  }

  async function stopAppRecording(w: Warning) {
    await api?.stop(w.session_id).catch(() => {});
    await chrome.storage.session.set({ warnings: warnings.filter((x) => x.session_id !== w.session_id) });
  }

  const list = Object.values(cards).sort((a, b) => b.session.started_at.localeCompare(a.session.started_at));
  const active = list.filter((c) => ACTIVE_SESSION_STATUSES.includes(c.session.status));
  const recent = list.filter((c) => !active.includes(c));
  const card = (c: Card) => (
    <SessionCard
      key={c.session.id}
      state={c}
      missed={missed[c.session.id]}
      onMode={(m) => void onMode(c, m)}
      onStop={() => chrome.runtime.sendMessage({ type: "stop", sessionId: c.session.id })}
      onMarker={c.backend === "app" ? () => api?.marker(c.session.id) : undefined}
      onMissed={() => void onMissed(c)}
      onRetry={() => void onRetry(c)}
      onSaveAudio={() => void onSaveAudio(c)}
      onOpen={c.backend === "local" ? () => chrome.tabs.create({ url: chrome.runtime.getURL(`library.html#${c.session.id}`) }) : undefined}
    />
  );
  const serviceChip =
    processing === "app" ? (
      <span className={`chip ${api ? "ok" : "warn"}`} title={t("Recordings are processed by the Mac app")}><span className="dot" />{api ? t("Mac app") : t("Mac app offline")}</span>
    ) : health ? (
      <span className={`chip ${health.ok ? "ok" : "warn"}`} title={health.detail}><span className="dot" />{t(SERVICE_LABEL[health.env])}{health.ok ? "" : ` · ${t("offline")}`}</span>
    ) : null;

  return (
    <div className="panel">
      <style>{THEME_CSS + CARD_CSS + PANEL_CSS}</style>
      <header className="top">
        <div className="brand"><span className="logo" aria-hidden><Icon name="wave" /></span><h1>Multicorder</h1></div>
        <span className="grow" />
        <a className="btn btn-ghost icon-btn" href="library.html" target="_blank" title={t("Library")} aria-label={t("Library")}><Icon name="library" /></a>
        <a className="btn btn-ghost icon-btn" href="options.html" target="_blank" title={t("Settings")} aria-label={t("Settings")}><Icon name="gear" /></a>
        <LangToggle />
        <ThemeToggle persist={(p) => chrome.storage.local.set({ theme: p })} />
      </header>
      {serviceChip && <div className="svc-row">{serviceChip}</div>}

      <div className="record">
        <div className="opts">
          <div className="seg" role="group" aria-label={t("Summary for new recordings")}>
            {(["live", "after", "off"] as SummaryMode[]).map((m) => (
              <button key={m} aria-pressed={mode === m} onClick={() => { setMode(m); void updateSettings({ defaultMode: m }); }}>{m === "live" ? t("Live") : m === "after" ? t("At end") : t("Off")}</button>
            ))}
          </div>
          <label className="switch" title={t("Don't play the tab's sound while recording it")}>
            <input type="checkbox" checked={silent} onChange={(e) => { setSilent(e.target.checked); void updateSettings({ silentCapture: e.target.checked }); }} />
            <span>{t("Mute playback")}</span>
          </label>
        </div>
        <TabSources recordings={Object.fromEntries(active.map(({ session, levelDb }) => [session.id, { status: session.status, levelDb }]))} onNotice={flash} />
        <p className="muted small hint">{t("Click the Multicorder toolbar icon or press")} <kbd>⌥⇧R</kbd> {t("to record the current tab.")}</p>
      </div>

      {health && !health.ok && processing === "standalone" && (
        <div className="banner warn" role="status"><Icon name="warn" /><span className="grow">{t("{service} is unavailable ({detail}). Recording still works; text will be filled in when it is back.", { service: t(SERVICE_LABEL[health.env]), detail: health.detail })}</span></div>
      )}
      {warnings.map((w) => (
        <div className="banner warn" key={w.session_id} role="alert">
          <Icon name="warn" />
          <span className="grow">{t("The Mac app is also recording this whole browser, so this audio would be captured twice.")}</span>
          <button className="btn btn-sm" onClick={() => void stopAppRecording(w)}>{t("Stop app recording")}</button>
        </div>
      ))}

      {active.length > 0 && <h3>{t("Recording now")}<span className="count">{active.length}</span></h3>}
      {active.length > 0 && <div className="cards">{active.map(card)}</div>}
      {recent.length > 0 && <h3>{t("Recent")}</h3>}
      {recent.length > 0 && <div className="cards">{recent.map(card)}</div>}
      {list.length === 0 && <div className="empty"><Icon name="wave" size={26} /><span className="small">{t("Recordings will appear here.")}</span></div>}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

const PANEL_CSS = `
.panel{padding:12px 12px 20px;display:flex;flex-direction:column;gap:10px;min-height:100vh}
.top{display:flex;align-items:center;gap:2px;margin:-2px -4px 0 0}
.top .grow{flex:1}
.brand{display:flex;align-items:center;gap:8px}
.logo{width:24px;height:24px;border-radius:7px;background:linear-gradient(135deg,#ff6b6f,var(--accent) 55%,#c4252b);color:#fff;display:grid;place-items:center;box-shadow:0 1px 2px rgba(229,72,77,.35),inset 0 1px 0 rgba(255,255,255,.25)}
.svc-row{display:flex;margin-top:-4px}
.record{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);padding:12px;display:flex;flex-direction:column;gap:10px}
.opts{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.record p{margin:0}
.hint{border-top:1px solid var(--border);padding-top:8px}
.tab-sources{max-height:260px;overflow:auto;margin:0 -4px;padding:0 4px}
.tab-sources h3{margin:6px 0 4px}
.tab-sources ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1px}
.tab-sources li{display:flex;align-items:center;gap:8px;padding:4px 4px 4px 6px;border-radius:var(--radius-sm);min-height:34px}
.tab-sources li:hover{background:var(--surface-2)}
.tab-fav{width:16px;height:16px;flex:none;border-radius:3px}
.tab-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.switch{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--text-2);cursor:pointer}
.switch input{accent-color:var(--accent);margin:0}
.cards{display:flex;flex-direction:column;gap:8px}
.panel>h3{margin:8px 0 0;display:flex;align-items:center;gap:6px}
.count{font:500 11px var(--font);color:var(--text-3);background:var(--surface-3);border-radius:999px;padding:0 6px;letter-spacing:0;text-transform:none}
.toast{position:fixed}
`;

createRoot(document.getElementById("root")!).render(<App />);
