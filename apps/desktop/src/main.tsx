// Desktop UI: a sidebar (All sources, Recording, History, Settings) next to a source list and the
// selected source's recording panel. Strings go through t() (English / 中文, follows the system by
// default); the theme follows the system unless the user picks one. Opened outside the app (`pnpm dev` in a browser) it runs on mock data for review.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ACTIVE_SESSION_STATUSES as ACTIVE, CARD_CSS, EngineEvent, fmtTs, Icon, Insight, LangToggle, locale, PreferenceControls, PREFS_CSS, Session, SummaryMode, t, THEME_CSS, ThemeToggle, TranscriptEvent, useLang, useToast, WAITING_FOR_AUDIO } from "@multicorder/ui";
import { mockInvoke } from "./mock";
import { DEFAULT_RECORDING_FORMAT, LiveCard, RECORDING_CSS, RecordingFormat, RecordingPanel, SavedClip } from "./RecordingPanel";

const inApp = "__TAURI_INTERNALS__" in window;
const invoke = <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => (inApp ? tauriInvoke<T>(cmd, args) : mockInvoke<T>(cmd, args));

interface AppInfo {
  app_id: string;
  name: string;
  pids: number[];
  is_emitting: boolean;
  capturing: boolean;
  waiting_for_audio?: boolean;
  tab_recording?: boolean;
}

interface Microphone {
  id: string;
  name: string;
  is_default: boolean;
  channel: number | null;
  capturing: boolean;
  waiting_for_audio: boolean;
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

type Row = Session;
type Cards = Record<string, LiveCard>;

const KIND: Record<string, string> = { mac_app: "App", chromium_tab: "Browser tab", mic: "Microphone" };

function readJson<T>(key: string, fallback: T): T {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the choice lasts for this session only */
  }
}

function sourceKey(session: Session) {
  const id = session.kind === "chromium_tab"
    ? session.capture_source_id ?? JSON.stringify([session.app_bundle_id, session.video_key ?? session.url ?? session.title])
    : session.capture_source_id ?? session.app_bundle_id ?? `archive:${session.title}`;
  return `${session.kind}:${id}`;
}

type Source = { key: string; name: string; kind: Session["kind"]; app?: AppInfo; mic?: Microphone; sessions: Row[] };
type View = "sources" | "recording" | "history" | "settings";
type SourceRemarks = Record<string, string>;

const SOURCE_REMARKS_KEY = "mc-source-remarks";

function loadSourceRemarks(): SourceRemarks {
  const entries = Object.entries(readJson<Record<string, unknown>>(SOURCE_REMARKS_KEY, {})).filter((entry): entry is [string, string] =>
    typeof entry[1] === "string" && entry[1].trim().length > 0);
  return Object.fromEntries(entries);
}


function phaseText(phase: string) {
  return phase === "capturing" ? t("Recording") : phase === "paused" ? t("Paused") : phase === "waiting" ? t("Waiting") : phase === "stopping" ? t("Saving") : t("Connecting");
}

function Live({ activeOnly, selected, setSelected, sessions, cards, remarks, saveRemark, refresh, flash }: {
  activeOnly: boolean;
  selected: string | null;
  setSelected: (key: string) => void;
  sessions: Row[];
  cards: Cards;
  remarks: SourceRemarks;
  saveRemark: (key: string, value: string) => void;
  refresh: () => void;
  flash: (text: string) => void;
}) {
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [microphones, setMicrophones] = useState<Microphone[]>([]);
  const [mode, setMode] = useState<SummaryMode>("off");
  const [mutePlayback, setMutePlayback] = useState(() => {
    try { return localStorage.getItem("mc-mute-playback") !== "false"; } catch { return true; }
  });
  const [formats, setFormats] = useState<Record<string, RecordingFormat>>(() => readJson("mc-source-formats", {}));
  const [starting, setStarting] = useState<string[]>([]);
  const [remarkEdit, setRemarkEdit] = useState<{ key: string; name: string; value: string } | null>(null);
  const [remarkError, setRemarkError] = useState(false);
  const remarkDialog = useRef<HTMLDialogElement>(null);
  const remarkInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let mounted = true;
    const load = () => {
      void invoke<AppInfo[]>("list_apps").then((items) => { if (mounted) setApps(items ?? []); }).catch(console.error);
      void invoke<Microphone[]>("list_microphones").then((items) => { if (mounted) setMicrophones(items ?? []); }).catch(console.error);
    };
    load();
    const timer = setInterval(load, 2000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => store("mc-source-formats", JSON.stringify(formats)), [formats]);

  const sources = new Map<string, Source>();
  for (const app of apps) {
    const key = `mac_app:${app.app_id}`;
    sources.set(key, { key, name: app.name, kind: "mac_app", app, sessions: [] });
  }
  for (const mic of microphones) {
    const key = `mic:${mic.id}`;
    sources.set(key, { key, name: mic.name, kind: "mic", mic, sessions: [] });
  }
  for (const session of sessions) {
    const key = sourceKey(session);
    if (!sources.has(key)) sources.set(key, { key, name: session.title, kind: session.kind, sessions: [] });
    sources.get(key)!.sessions.push(session);
  }
  const activeSession = (source: Source) => source.sessions.find((session) => ACTIVE.includes(session.status));
  const all = [...sources.values()];
  const running = all.filter((source) => activeSession(source));
  const playing = all.filter((source) => source.app?.is_emitting);
  const mics = all.filter((source) => source.mic);
  const idle = all.filter((source) => source.app && !source.app.is_emitting);
  const tabs = all.filter((source) => source.kind === "chromium_tab");
  const offline = all.filter((source) => source.kind !== "chromium_tab" && !source.app && !source.mic && source.sessions.some((session) => session.audio_ms > 0));
  const shown = activeOnly ? running : [...playing, ...mics, ...idle, ...tabs, ...offline];
  const source = shown.find((item) => item.key === selected) ?? (activeOnly ? running[0] : null);
  const current = source ? activeSession(source) : undefined;

  async function start(source: Source) {
    if (starting.includes(source.key)) return;
    setSelected(source.key);
    setStarting((keys) => [...keys, source.key]);
    const format = formats[source.key] ?? DEFAULT_RECORDING_FORMAT;
    try {
      let result: { session: Row };
      if (source.app) {
        const args = { appId: source.app.app_id, mode, waitForAudio: true, mutePlayback, format };
        try {
          result = await invoke("start_app_session", args);
        } catch (failure) {
          if (!String(failure).includes("duplicate_browser_tabs")) throw failure;
          if (!window.confirm(t("The extension is already recording tabs in this browser. Also record the whole browser?"))) return;
          result = await invoke("start_app_session", { ...args, force: true });
        }
      } else if (source.mic) {
        result = await invoke("start_mic_session", { deviceId: source.mic.id, mode, format });
      } else {
        return;
      }
      if (result?.session?.status === "waiting" && !source.app?.is_emitting) flash(t(WAITING_FOR_AUDIO));
      refresh();
    } catch (failure) {
      flash(String(failure));
    } finally {
      setStarting((keys) => keys.filter((key) => key !== source.key));
    }
  }

  function openRemark(item: Source) {
    setRemarkEdit({ key: item.key, name: item.name, value: remarks[item.key] ?? "" });
    setRemarkError(false);
    remarkDialog.current?.showModal();
    requestAnimationFrame(() => remarkInput.current?.focus());
  }

  function row(item: Source) {
    const active = activeSession(item);
    const phase = active ? cards[active.id]?.status ?? active.status : undefined;
    const audible = item.app?.is_emitting ?? false;
    const canStart = !!(item.app || item.mic);
    const label = audible ? t("Record") : t("Arm");
    const remark = remarks[item.key];
    const name = remark || item.name;
    const editLabel = t("Edit audio source remark for {name}", { name });
    const selectedRow = item.key === source?.key;
    return (
      <li key={item.key} className={["source-row", audible ? "" : "audio-idle", item.mic?.channel ? "mic-channel" : "", selectedRow ? "is-selected" : ""].join(" ")}>
        <span className={`audio-dot ${audible ? "on" : ""}`} aria-hidden />
        <div className="source-row-label">
          <div className="source-row-primary">
            <button type="button" className="source-row-name" aria-current={selectedRow} title={name} onClick={() => setSelected(item.key)}>{name}</button>
            <button type="button" className="source-remark-edit" aria-label={editLabel} title={editLabel} onClick={() => openRemark(item)}><Icon name="edit" size={12} /></button>
          </div>
          {remark && <div className="source-original-name">{item.name}</div>}
        </div>
        {item.mic?.is_default && !activeOnly && <span className="chip default">{t("Default")}</span>}
        {phase ? <span className={`chip ${phase === "capturing" ? "rec" : "info"}`}>{phase === "capturing" && <span className="dot" />}{phaseText(phase)}</span>
          : canStart && <button className={`btn btn-sm ${audible ? "btn-audible" : ""}`} disabled={starting.includes(item.key)} aria-label={`${label} ${name}`} title={audible ? undefined : t(WAITING_FOR_AUDIO)} onClick={() => void start(item)}><Icon name={item.mic ? "mic" : "record"} size={13} />{label}</button>}
      </li>
    );
  }

  const group = (title: string, items: Source[], empty?: string) => (items.length || empty) ? (
    <div className="source-group">
      <h3>{title}{items.length > 0 && <span className="count">{items.length}</span>}</h3>
      <ul className="apps">{items.length ? items.map(row) : <li className="muted small source-empty">{empty}</li>}</ul>
    </div>
  ) : null;

  return (
    <div className="live">
      <section className="sources" aria-label={activeOnly ? t("Active sources") : t("Audio sources")}>
        {activeOnly ? (
          <>
            <div className="pane-title"><h2>{t("Recording now")}</h2></div>
            <ul className="apps">{running.map(row)}{!running.length && <li className="small muted source-empty">{t("No active recordings.")}</li>}</ul>
          </>
        ) : <>
          <div className="pane-title"><h2>{t("Audio sources")}</h2></div>
          <div className="new-rec">
            <span className="field-label">{t("Processing for new recordings")}</span>
            <div className="seg seg-full" role="group" aria-label={t("Processing for new recordings")}>
              {(["live", "after", "off"] as SummaryMode[]).map((value) => <button key={value} aria-pressed={mode === value} onClick={() => setMode(value)}>{value === "live" ? t("Live") : value === "after" ? t("At end") : t("Audio only")}</button>)}
            </div>
            <label className="source-playback">
              <input type="checkbox" checked={mutePlayback} onChange={(e) => {
                setMutePlayback(e.target.checked);
                store("mc-mute-playback", String(e.target.checked));
              }} />
              {t("Mute playback for new recordings")}
            </label>
          </div>
          {group(t("Playing now"), playing, t("No app is playing audio."))}
          {group(t("Microphones"), mics, t("No microphone is connected."))}
          {group(t("No sound detected"), idle)}
          {group(t("Chrome tabs"), tabs)}
          {group(t("Offline sources"), offline)}
          <p className="small muted hint">{t("Use the Multicorder extension to start recording a Chrome tab.")}</p>
        </>}
      </section>
      <section className="board" key={source?.key ?? "empty"}>
        {source ? <RecordingPanel key={source.key} title={remarks[source.key] || source.name} originalName={remarks[source.key] ? source.name : undefined} kind={source.kind}
          session={current} card={current ? cards[current.id] : undefined} cards={cards}
          clips={source.sessions.filter(isSaved)} canStart={!!(source.app || source.mic) && !starting.includes(source.key)}
          willWait={!source.app?.is_emitting} lastFailure={source.sessions[0]?.failure}
          format={formats[source.key] ?? DEFAULT_RECORDING_FORMAT}
          setFormat={(format) => setFormats((current) => ({ ...current, [source.key]: format }))}
          onStart={() => start(source)} invoke={invoke} flash={flash} refresh={refresh} />
          : <div className="empty board-empty"><Icon name={activeOnly ? "live" : "speaker"} size={28} /><strong>{activeOnly ? t("Nothing is recording") : t("Pick an audio source")}</strong><span className="small">{activeOnly ? t("Start a source from All sources.") : t("Select an audio source to open its recording panel.")}</span></div>}
      </section>
      <dialog className="source-remark-dialog" ref={remarkDialog} aria-labelledby="source-remark-title">
        <form onSubmit={(event) => {
          event.preventDefault();
          if (!remarkEdit) return;
          try {
            saveRemark(remarkEdit.key, remarkEdit.value);
            remarkDialog.current?.close();
          } catch {
            setRemarkError(true);
          }
        }}>
          <h2 id="source-remark-title">{t("Edit audio source remark")}</h2>
          <div className="source-original-name">{remarkEdit?.name}</div>
          <label>{t("Remark")}
            <input className="input" ref={remarkInput} value={remarkEdit?.value ?? ""} onChange={(event) => {
              if (remarkEdit) setRemarkEdit({ ...remarkEdit, value: event.target.value });
            }} aria-describedby="source-remark-hint" />
          </label>
          <p className="source-original-name" id="source-remark-hint">{t("Leave blank to use the default name.")}</p>
          {remarkError && <p className="banner warn" role="alert">{t("Could not save the remark locally.")}</p>}
          <div className="source-remark-actions">
            <button className="btn" type="button" onClick={() => remarkDialog.current?.close()}>{t("Cancel")}</button>
            <button className="btn btn-primary" type="submit">{t("Save")}</button>
          </div>
        </form>
      </dialog>
    </div>
  );
}

function isSaved(session: Session) {
  return session.audio_ms > 0 && (session.status === "stopped" || session.status === "failed" || session.status === "processing");
}

function Detail({ session, refresh, flash }: { session: Row; refresh: () => void; flash: (t: string) => void }) {
  const [lines, setLines] = useState<TranscriptEvent[]>([]);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [report, setReport] = useState<{ body: string } | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    const keep = <T,>(set: (value: T) => void) => (value: T) => { if (current) set(value); };
    invoke<TranscriptEvent[]>("transcript", { id: session.id }).then((x) => keep(setLines)(x ?? [])).catch(console.error);
    invoke<Insight[]>("insights", { id: session.id }).then((x) => keep(setInsights)(x ?? [])).catch(console.error);
    invoke<{ body: string } | null>("report", { id: session.id }).then(keep(setReport)).catch(console.error);
    return () => { current = false; };
  }, [session.id, session.asr?.failed_chunks]);
  const active = ACTIVE.includes(session.status);
  const waiting = session.status === "waiting";
  const empty = session.failure === "no_audio";
  const missing = session.asr?.failed_chunks ?? 0;
  const retry = async () => {
    setBusy(true);
    try {
      const r = await invoke<{ queued: number }>("retry_asr", { id: session.id });
      flash(r?.queued ? t("Retrying {n} part(s)…", { n: r.queued }) : t("Nothing to retry."));
    } catch (e) {
      flash(t("Retry failed: {error}", { error: String(e) }));
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const remove = async () => {
    if (!confirm(t("Delete this recording, its transcript and summary?"))) return;
    try {
      await invoke("delete_session", { id: session.id });
      refresh();
    } catch (e) {
      flash(String(e));
    }
  };
  const jump = (id: string) => {
    setFocus(id);
    document.getElementById(id)?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  return (
    <article className="detail">
      <header className="dhead">
        <div>
          <h2>{session.title}</h2>
          <p className="small muted">{t(KIND[session.kind] ?? session.kind)} · {fmtTs(session.audio_ms)} · {new Date(session.started_at).toLocaleString(locale())}</p>
        </div>
        {waiting ? <span className="chip info">{t("Waiting for audio")}</span> : active ? <span className="chip rec"><span className="dot" />{t("Recording")}</span> : missing ? <span className="chip warn">{t("Text missing")}</span> : <span className="chip">{empty ? t("No audio") : t("Done")}</span>}
      </header>
      {waiting && <p className="small muted" role="status">{t(WAITING_FOR_AUDIO)}</p>}
      {missing > 0 && (
        <div className="banner warn"><Icon name="warn" /><span className="grow">{t("{n} part(s) are not transcribed yet ({time} of audio). The recording is saved; text fills in automatically when the service is back.", { n: missing, time: fmtTs(session.asr?.failed_ms ?? 0) })}</span><button className="btn btn-sm" disabled={busy} onClick={() => void retry()}><Icon name="retry" size={13} />{busy ? t("Retrying…") : t("Retry now")}</button></div>
      )}
      <div className="toolbar">
        {(["md", "srt", "vtt", "json"] as const).map((f) => (
          <button key={f} className="btn btn-sm" onClick={() => invoke<string>("export", { id: session.id, format: f }).then((p) => flash(t("Saved {path}", { path: p }))).catch((e) => flash(String(e)))}><Icon name="download" size={13} />{f.toUpperCase()}</button>
        ))}
        {!waiting && !empty && <button className="btn btn-sm" onClick={() => invoke<string>("export_audio", { id: session.id }).then((p) => flash(t("Saved {path}", { path: p }))).catch((e) => flash(t("Could not save audio: {error}", { error: String(e) })))}><Icon name="download" size={13} />{t("Audio (WAV)")}</button>}
        {!missing && !active && !empty && <button className="btn btn-sm" disabled={busy} onClick={() => void retry()}><Icon name="retry" size={13} />{t("Transcribe again")}</button>}
        <span className="grow" />
        {!active && <button className="btn btn-sm btn-ghost btn-danger" onClick={() => void remove()}><Icon name="trash" size={13} />{t("Delete")}</button>}
      </div>
      <div className="cols">
        <section className="panel-block">
          <h3>{t("Key points")}</h3>
          {insights.length === 0 && <p className="muted small">{t("No key points yet.")}</p>}
          <ul className="points">
            {insights.map((i) => (
              <li key={i.key} className={i.state === "tentative" ? "tentative" : ""}>
                <span>{i.text}</span>
                {i.evidence.map((e) => <button key={e.event_id} className="tsbtn" onClick={() => jump(e.event_id)}>{fmtTs(e.start_ms)}</button>)}
              </li>
            ))}
          </ul>
          <h3>{t("Report")}</h3>
          <pre className="report">{report?.body || (missing ? t("Waiting for transcription to finish.") : t("No report yet."))}</pre>
        </section>
        <section className="panel-block transcript">
          <h3>{t("Transcript")}</h3>
          {lines.length === 0 && <p className="muted small">{t("No transcript yet.")}</p>}
          {lines.map((l) => <p key={l.id} id={l.id} className={focus === l.id ? "focus" : ""}><span className="ts">{fmtTs(l.start_ms)}</span> {l.text}</p>)}
        </section>
      </div>
    </article>
  );
}

function History({ sessions, cards, refresh, flash }: { sessions: Row[]; cards: Cards; refresh: () => void; flash: (text: string) => void }) {
  const [detail, setDetail] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [visible, setVisible] = useState(12);
  const query = search.trim().toLowerCase();
  const saved = useMemo(() => sessions.filter(isSaved), [sessions]);
  const shown = useMemo(() => saved.filter((row) => !query || row.title.toLowerCase().includes(query)), [saved, query]);
  const current = saved.find((row) => row.id === detail);
  return (
    <div className="history">
      {current ? <>
        <button className="btn btn-ghost back" onClick={() => setDetail(null)}><Icon name="back" />{t("Back to history")}</button>
        <Detail key={current.id} session={current} refresh={refresh} flash={flash} />
      </> : <div className="history-inner">
        <div className="pane-title history-head">
          <h2>{t("History")}{saved.length > 0 && <span className="count">{saved.length}</span>}</h2>
          <div className="history-filter"><Icon name="search" /><input className="input" placeholder={t("Filter by audio source")} aria-label={t("Filter by audio source")} value={search} onChange={(e) => { setSearch(e.target.value); setVisible(12); }} /></div>
        </div>
        {shown.length ? <ul className="history-clips">{shown.slice(0, visible).map((row) => (
          <SavedClip key={row.id} clip={row} revision={cards[row.id]?.textRevision} invoke={invoke} flash={flash} showSource onDetails={() => setDetail(row.id)} />
        ))}</ul> : <div className="empty"><Icon name="history" size={28} /><span>{query ? t("No matching recordings.") : t("Finished recordings will appear here.")}</span></div>}
        {shown.length > visible && <button className="btn" onClick={() => setVisible((count) => count + 12)}>{t("Show more recordings")}</button>}
      </div>}
    </div>
  );
}

function Settings({ status }: { status: Status | null }) {
  const row = (label: string, value: React.ReactNode) => <div className="srow"><span className="muted">{label}</span><span>{value}</span></div>;
  return (
    <div className="settings">
      <div className="settings-inner">
        <div className="pane-title"><h2>{t("Settings")}</h2></div>
        <section className="card">
          <h3>{t("General")}</h3>
          <PreferenceControls />
        </section>
        {!status ? <div className="empty">{t("Loading…")}</div> : <>
          <section className="card">
            <h3>{t("Services")}</h3>
            {row(t("Transcription"), status.asr_ready ? <span className="chip ok"><span className="dot" />{status.asr}</span> : <span className="chip warn">{t("No key configured")}</span>)}
            {row(t("Summaries"), status.llm_ready ? <span className="chip ok"><span className="dot" />{t("Ready")}</span> : <span className="chip warn">{t("No model key")}</span>)}
            {row(t("Spent today"), t("${spent} of ${cap}", { spent: status.spent_today_usd.toFixed(3), cap: status.daily_cap_usd.toFixed(2) }))}
          </section>
          <section className="card">
            <h3>{t("Local service")}</h3>
            {row(t("Address for the extension"), <code>127.0.0.1:{status.api_port}</code>)}
            {row(t("Data folder"), <code>{status.data_dir}</code>)}
            <p className="small muted">{t("Providers and keys are in config.json inside the data folder. The Chrome extension can use this Mac as its transcription and summary service (Settings → “This Mac”).")}</p>
          </section>
        </>}
      </div>
    </div>
  );
}

function App() {
  useLang();
  const [tab, setTab] = useState<View>("sources");
  const [selected, setSelected] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Row[]>([]);
  const [cards, setCards] = useState<Cards>({});
  const [status, setStatus] = useState<Status | null>(null);
  const [toast, flash] = useToast(4000);
  const [remarks, setRemarks] = useState(loadSourceRemarks);
  const saveRemark = (key: string, value: string) => {
    const next = { ...remarks };
    const trimmed = value.trim();
    if (trimmed) next[key] = trimmed;
    else delete next[key];
    localStorage.setItem(SOURCE_REMARKS_KEY, JSON.stringify(next)); // throws on failure: the dialog reports it
    setRemarks(next);
  };
  const refresh = () => invoke<Row[]>("list_sessions").then((x) => setSessions(x ?? [])).catch(() => {});
  useEffect(() => {
    void refresh();
    invoke<Status>("status").then(setStatus).catch(() => {});
    const timer = setInterval(refresh, 15000);
    if (!inApp) return () => clearInterval(timer);
    const un = listen<EngineEvent>("engine", ({ payload: e }) => {
      if (e.type === "status" || e.type === "report") void refresh();
      setCards((prev) => {
        const c = prev[e.session_id] ?? { lines: [], insights: [] };
        const n = { ...c };
        if (e.type === "level") n.levelDb = e.rms_db;
        if (e.type === "waveform") {
          n.peaks = [...(c.peaks ?? []), ...e.peaks].slice(-96);
          n.elapsed = e.audio_ms;
        }
        if (e.type === "status") {
          n.detail = e.detail ?? null;
          n.status = e.status;
        }
        if (e.type === "transcript") n.lines = [...c.lines, e.event].slice(-3);
        if (e.type === "transcript" || e.type === "report") n.textRevision = (c.textRevision ?? 0) + 1;
        if (e.type === "insight") n.insights = [...c.insights.filter((i) => i.key !== e.insight.key), e.insight].filter((i) => i.state !== "retracted");
        if (e.type === "backlog") n.backlog = e.pending_chunks;
        return { ...prev, [e.session_id]: n };
      });
    });
    return () => {
      clearInterval(timer);
      void un.then((f) => f());
    };
  }, []);
  const activeIds = sessions.filter((session) => ACTIVE.includes(session.status)).map(({ id }) => id).join(",");
  useEffect(() => {
    if (!activeIds) return;
    let current = true;
    for (const id of activeIds.split(",")) {
      void Promise.all([
        invoke<TranscriptEvent[]>("transcript", { id }),
        invoke<Insight[]>("insights", { id }),
      ]).then(([lines, insights]) => {
        if (!current) return;
        setCards((previous) => {
          const card = previous[id];
          return { ...previous, [id]: {
            ...card,
            lines: card?.lines.length ? card.lines : (lines ?? []).slice(-3),
            insights: card?.insights.length ? card.insights : (insights ?? []).filter((item) => item.state !== "retracted"),
          } };
        });
      }).catch(console.error);
    }
    return () => { current = false; };
  }, [activeIds]);

  const recording = sessions.filter((s) => ACTIVE.includes(s.status)).length;
  const degraded = sessions.some((s) => s.asr?.failed_chunks);
  const nav = [
    { id: "sources", label: t("All sources"), icon: "speaker" },
    { id: "recording", label: t("Recording"), icon: "live" },
    { id: "history", label: t("History"), icon: "history" },
  ] as const;
  const health = status ? (!status.asr_ready ? t("No transcription key") : degraded ? t("Transcription degraded") : t("Services ready")) : null;
  return (
    <div className="app">
      <style>{THEME_CSS + PREFS_CSS + CARD_CSS + APP_CSS + RECORDING_CSS}</style>
      <aside className="sidebar">
        <div className="brand"><span className="logo" aria-hidden><Icon name="wave" /></span><strong className="nav-text">Multicorder</strong></div>
        <nav className="nav" aria-label="Recording views">
          {nav.map(({ id, label, icon }) => <button key={id} className="navbtn" aria-label={id === "recording" && recording > 0 ? `${label} ${recording}` : label} title={label} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>
            <Icon name={icon} /><span className="nav-text">{label}</span>{id === "recording" && recording > 0 && <span className="badge">{recording}</span>}
          </button>)}
        </nav>
        <div className="sidebar-foot">
          {status && <div className={`svc-status ${status.asr_ready && !degraded ? "ok" : "warn"}`} title={degraded ? t("Some recordings are waiting for transcription") : status.asr}><span className="dot" /><span className="nav-text">{health}</span></div>}
          <button className="navbtn" aria-label={t("Settings")} title={t("Settings")} aria-current={tab === "settings" ? "page" : undefined} onClick={() => setTab("settings")}><Icon name="gear" /><span className="nav-text">{t("Settings")}</span></button>
          <div className="quick-prefs"><ThemeToggle /><LangToggle /></div>
        </div>
      </aside>
      <main>
        {(tab === "sources" || tab === "recording") && <Live activeOnly={tab === "recording"} selected={selected} setSelected={setSelected} sessions={sessions} cards={cards} remarks={remarks} saveRemark={saveRemark} refresh={refresh} flash={flash} />}
        {tab === "history" && <History sessions={sessions} cards={cards} refresh={refresh} flash={flash} />}
        {tab === "settings" && <Settings status={status} />}
      </main>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

const APP_CSS = `
html,body,#root{height:100%}
body{overflow:hidden}
.app{display:grid;grid-template-columns:216px minmax(0,1fr);height:100vh}
.sidebar{display:flex;flex-direction:column;gap:14px;padding:14px 10px 12px;background:var(--sidebar);border-right:1px solid var(--border);min-height:0}
.brand{display:flex;align-items:center;gap:9px;padding:2px 6px 4px;font-size:14px;letter-spacing:-.01em}
.logo{width:26px;height:26px;flex:none;border-radius:8px;background:linear-gradient(135deg,#ff6b6f,var(--accent) 55%,#c4252b);color:#fff;display:grid;place-items:center;box-shadow:0 1px 2px rgba(229,72,77,.35),inset 0 1px 0 rgba(255,255,255,.25)}
.nav{display:flex;flex-direction:column;gap:2px;flex:1}
.navbtn{all:unset;display:flex;align-items:center;gap:10px;height:32px;padding:0 9px;border-radius:var(--radius-sm);color:var(--text-2);cursor:pointer;font-weight:500;transition:background .12s,color .12s}
.navbtn svg{flex:none}
.navbtn:hover{background:var(--surface-3);color:var(--text)}
.navbtn[aria-current="page"]{background:var(--surface);color:var(--text);box-shadow:var(--shadow)}
.navbtn:focus-visible{outline:2px solid var(--focus)}
.badge{margin-left:auto;background:var(--accent);color:#fff;border-radius:999px;font-size:11px;font-weight:600;line-height:18px;padding:0 6px;min-width:18px;text-align:center}
.sidebar-foot{display:flex;flex-direction:column;gap:6px}
.svc-status{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:var(--radius-sm);font-size:12px;font-weight:500}
.svc-status .dot{flex:none}
.svc-status.ok{color:var(--ok-text);background:var(--ok-weak)}
.svc-status.warn{color:var(--warn-text);background:var(--warn-weak)}
.quick-prefs{display:flex;gap:2px;padding:0 2px}
@media (max-width:960px){
  .app{grid-template-columns:58px minmax(0,1fr)}
  .sidebar{padding:12px 8px;align-items:center}
  .nav-text{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
  .navbtn{justify-content:center;width:40px;padding:0;position:relative}
  .badge{position:absolute;top:-3px;right:-3px;line-height:16px;min-width:16px;padding:0 4px;font-size:10px}
  .svc-status{padding:8px;justify-content:center}
  .quick-prefs{flex-direction:column}
  .brand{padding:2px 0 4px}
}
main{min-width:0;min-height:0;overflow:hidden}
.pane-title{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:30px}
.pane-title h2{margin:0;font-size:16px;display:flex;align-items:center;gap:8px}
.live{display:grid;grid-template-columns:300px minmax(0,1fr);height:100%}
@media (max-width:820px){.live{grid-template-columns:260px minmax(0,1fr)}.seg-full button{padding:0 6px}.source-row .chip.default{display:none}}
.sources{border-right:1px solid var(--border);padding:16px 12px;overflow:auto;display:flex;flex-direction:column;gap:14px;background:var(--surface)}
.new-rec{display:flex;flex-direction:column;gap:8px;padding:10px;background:var(--surface-2);border-radius:var(--radius-md)}
.field-label{font-size:12px;color:var(--text-2);font-weight:500}
.seg-full{display:flex}.seg-full button{flex:1}
.source-playback{display:flex;align-items:center;gap:7px;color:var(--text-2);font-size:12px;cursor:pointer}
.source-playback input{accent-color:var(--accent);margin:0}
.source-group h3{margin:0 0 4px;padding:0 6px;display:flex;align-items:center;gap:6px}
.apps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1px}
.source-row{display:flex;align-items:center;gap:8px;padding:5px 6px 5px 8px;border-radius:var(--radius-sm);min-height:34px;position:relative;transition:background .12s}
.source-row:hover{background:var(--surface-2)}
.source-row.is-selected{background:var(--primary-weak)}
.source-row.is-selected::before{content:"";position:absolute;left:0;top:7px;bottom:7px;width:3px;border-radius:3px;background:var(--primary)}
.source-empty{padding:6px 8px}
.apps .mic-channel{padding-left:18px}.apps .mic-channel .source-row-name{font-size:12px}
.source-row-label{flex:1;min-width:0}
.source-row-primary{display:flex;align-items:center;gap:2px}
.source-row-name{min-width:0;background:none;border:0;padding:0;text-align:left;cursor:pointer;color:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.source-row-name::after{content:"";position:absolute;inset:0}
.source-row .btn,.source-row .chip,.source-remark-edit{position:relative;z-index:1}
.source-row-name[aria-current="true"]{color:var(--text)}
.source-row-name:focus-visible{outline:2px solid var(--focus);border-radius:3px}
.source-original-name{color:var(--text-3);font-size:11px;overflow-wrap:anywhere}
.source-remark-edit{display:grid;place-items:center;flex:none;width:22px;height:22px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--text-3);cursor:pointer;opacity:0;transition:opacity .12s}
.source-row:hover .source-remark-edit,.source-remark-edit:focus-visible{opacity:1}
.source-remark-edit:hover{background:var(--surface-3);color:var(--text)}
.hint{padding:0 6px;margin:0}
.source-remark-dialog{width:min(380px,calc(100% - 32px));padding:20px;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);color:var(--text);box-shadow:var(--shadow-lg)}
.source-remark-dialog::backdrop{background:rgb(0 0 0 / 35%);backdrop-filter:blur(2px)}
.source-remark-dialog form{display:grid;gap:8px}
.source-remark-dialog h2,.source-remark-dialog p{margin:0}
.source-remark-dialog label{display:grid;gap:6px;margin-top:6px;font-size:12px;color:var(--text-2)}
.source-remark-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:8px}
.board{padding:20px;min-width:0;overflow:auto}
.board>.source-panel{max-width:980px;margin:0 auto}
.board-empty{height:100%;max-width:520px;margin:0 auto;border-style:dashed}
.board-empty strong{color:var(--text);font-size:14px}
.history,.settings{height:100%;overflow:auto;padding:20px 24px}
.history-inner,.settings-inner{max-width:980px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
.settings-inner{max-width:720px}
.history-head{flex-wrap:wrap}
.history-filter{display:flex;align-items:center;gap:8px;color:var(--text-3);position:relative}
.history-filter svg{position:absolute;left:9px;pointer-events:none}
.history-filter .input{padding-left:30px;width:260px;max-width:100%}
.history-clips{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.history-clips>.saved-clip{box-shadow:var(--shadow);padding:14px}
.back{align-self:flex-start;margin:0 0 4px -6px}
.detail{max-width:980px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
.dhead{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.dhead h2{font-size:20px;margin:0 0 4px}.dhead p{margin:0}
.toolbar{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.toolbar .grow{flex:1}
.cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px}
@media (max-width:900px){.cols{grid-template-columns:1fr}}
.panel-block{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:4px 16px 16px;min-width:0}
.points{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.points li{display:flex;gap:6px;align-items:baseline;flex-wrap:wrap}.points li.tentative{color:var(--text-2)}
.tsbtn{all:unset;cursor:pointer;font-family:var(--mono);font-size:11px;color:var(--primary-text);padding:0 5px;border-radius:4px;background:var(--primary-weak)}.tsbtn:hover{filter:brightness(.95)}
.transcript p{margin:0 0 8px;line-height:1.6;padding:2px 4px;border-radius:4px}.focus{background:var(--warn-weak)}
.report{white-space:pre-wrap;font:12px/1.6 var(--mono);background:var(--surface-2);padding:12px;border-radius:var(--radius-sm);margin:0;overflow-wrap:anywhere}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:6px 16px 14px;display:flex;flex-direction:column;gap:6px;box-shadow:var(--shadow)}
.card h3{margin:10px 0 4px}
.srow{display:flex;justify-content:space-between;align-items:center;gap:12px;min-height:34px;border-top:1px solid var(--border)}
.card h3+.srow{border-top:0}
.srow code{overflow-wrap:anywhere}
`;

createRoot(document.getElementById("root")!).render(<App />);
