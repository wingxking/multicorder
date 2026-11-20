// Desktop UI: a sidebar (All sources, Recording, History, Settings) next to a source list and the
// selected source's recording panel. Strings go through t() (English / 中文, follows the system by
// default); the theme follows the system unless the user picks one. Opened outside the app (`pnpm dev` in a browser) it runs on mock data for review.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ACTIVE_SESSION_STATUSES as ACTIVE, CARD_CSS, RECORDER_CSS, EngineEvent, fmtTs, Icon, Insight, LangToggle, locale, PreferenceControls, PREFS_CSS, programTitle, Session, SummaryMode, t, tError, THEME_CSS, ThemeToggle, TranscriptEvent, captionFromEngine, captionLabel, useConfirm, useLang, useToast, WAITING_FOR_AUDIO } from "@multicorder/ui";
import { mockEngineEvents, mockInvoke } from "./mock";
import { AI_SETTINGS_CSS, AiSettings, ServiceDevOptions } from "./AiSettings";
import { AppIcon, DEFAULT_RECORDING_FORMAT, DownloadMenu, LIVE_PEAK_WINDOW, LiveCard, RECORDING_CSS, RecordingFormat, RecordingPanel, recordingName, SavedClip, sourceTitle } from "./RecordingPanel";

const inApp = "__TAURI_INTERNALS__" in window;
const invoke = <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => (inApp ? tauriInvoke<T>(cmd, args) : mockInvoke<T>(cmd, args));

interface AppInfo {
  app_id: string;
  name: string;
  bundle_path?: string | null;
  pids: number[];
  is_emitting: boolean;
  capturing: boolean;
  waiting_for_audio?: boolean;
  tab_recording?: boolean;
}

interface BrowserSource {
  source_id: string;
  app: string;
  bundle_id?: string;
  title: string;
  site: string;
  audible: boolean;
  ordinal: number;
  standalone_recording: boolean;
  /** Live state of the tab's recording, reported by the extension that captures it. */
  recording?: TabRecording | null;
}

interface TabRecording {
  tab_id: number;
  session_id: string;
  /** "local": processed in Chrome (no engine session here); "app": streamed to this app. */
  backend: "local" | "app";
  status: string;
  paused: boolean;
  muted: boolean;
  mode?: SummaryMode | null;
  title: string;
  started_at: string;
  elapsed_ms: number;
}

/** A Chrome-processed recording shown with this app's recorder controls (routed to Chrome). */
function remoteSession(browser: BrowserSource): Session | undefined {
  const r = browser.recording;
  if (!r || r.backend !== "local") return undefined;
  return {
    id: r.session_id, kind: "chromium_tab", title: r.title || browser.title, app_bundle_id: browser.bundle_id, capture_source_id: browser.source_id,
    status: r.paused ? "paused" : r.status, summary_mode: r.mode ?? "live", started_at: r.started_at || new Date().toISOString(), audio_ms: r.elapsed_ms, muted: r.muted,
  };
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
  app_version?: string;
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

type Source = { key: string; name: string; kind: Session["kind"]; app?: AppInfo; mic?: Microphone; browser?: BrowserSource; iconPath?: string | null; sessions: Row[] };
type View = "sources" | "recording" | "history" | "settings";
type SourceRemarks = Record<string, string>;

const SOURCE_REMARKS_KEY = "mc-source-remarks";
const MUTE_PLAYBACK_KEY = "mc-mute-playback";
const SIDEBAR_WIDTH_KEY = "mc-sidebar-width";
/** New recordings are transcribed and summarised live (transcription is on by default); the
 *  panel's summary menu switches a recording to "At end" or "Audio only". */
const NEW_RECORDING_MODE: SummaryMode = "live";
const MIN_SOURCE_WIDTH = 240;
const SIDEBAR = { min: 168, max: 340, initial: 216, compact: 58, snap: 120 };
const MIN_BOARD_WIDTH = 320;

function loadSourceRemarks(): SourceRemarks {
  const entries = Object.entries(readJson<Record<string, unknown>>(SOURCE_REMARKS_KEY, {})).filter((entry): entry is [string, string] =>
    typeof entry[1] === "string" && entry[1].trim().length > 0);
  return Object.fromEntries(entries);
}


function phaseText(phase: string) {
  return phase === "capturing" ? t("Recording") : phase === "paused" ? t("Paused") : phase === "waiting" ? t("Waiting") : phase === "stopping" ? t("Saving") : t("Connecting");
}

/** Chip colour for a session phase: red while recording, amber when paused, blue while in progress. */
const phaseChip = (phase: string) => (phase === "capturing" ? "rec" : phase === "paused" || phase === "reconnecting" ? "warn" : "info");

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
  const [browserSources, setBrowserSources] = useState<BrowserSource[]>([]);
  const [endedSource, setEndedSource] = useState<string | null>(null);
  const mode = NEW_RECORDING_MODE;
  // One choice for every source: record without playing through the speakers (default on).
  const [mutePlayback, setMutePlayback] = useState(() => {
    try { return localStorage.getItem(MUTE_PLAYBACK_KEY) !== "false"; } catch { return true; }
  });
  const changeMutePlayback = (value: boolean) => {
    setMutePlayback(value);
    store(MUTE_PLAYBACK_KEY, String(value));
  };
  const [formats, setFormats] = useState<Record<string, RecordingFormat>>(() => readJson("mc-source-formats", {}));
  const [starting, setStarting] = useState<string[]>([]);
  const [remarkEdit, setRemarkEdit] = useState<{ key: string; name: string; value: string } | null>(null);
  const [remarkError, setRemarkError] = useState(false);
  // Asked when the user ends a recording here: what to call it (prefilled with the source's name).
  const [naming, setNaming] = useState<{ id: string; fallback: string; value: string } | null>(null);
  const nameDialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const remarkDialog = useRef<HTMLDialogElement>(null);
  const remarkInput = useRef<HTMLInputElement>(null);
  const live = useRef<HTMLDivElement>(null);
  const resizeDrag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const [preferredWidth, setPreferredWidth] = useState<number>();
  const [resizing, setResizing] = useState(false);
  const [layout, setLayout] = useState(() => ({ width: 0, narrow: window.matchMedia("(max-width: 820px)").matches }));
  const defaultWidth = layout.narrow ? 260 : 300;
  const maxSourceWidth = layout.width ? Math.max(MIN_SOURCE_WIDTH, layout.width - MIN_BOARD_WIDTH) : defaultWidth;
  const clampSourceWidth = (width: number) => Math.min(maxSourceWidth, Math.max(MIN_SOURCE_WIDTH, width));
  const sourceWidth = clampSourceWidth(preferredWidth ?? defaultWidth);

  useEffect(() => {
    const element = live.current;
    if (!element) return;
    const narrow = window.matchMedia("(max-width: 820px)");
    const updateLayout = () => setLayout({ width: element.clientWidth, narrow: narrow.matches });
    const observer = new ResizeObserver(updateLayout);
    observer.observe(element);
    narrow.addEventListener("change", updateLayout);
    return () => {
      observer.disconnect();
      narrow.removeEventListener("change", updateLayout);
    };
  }, []);

  function finishResize(event: React.PointerEvent) {
    if (resizeDrag.current?.pointerId !== event.pointerId) return;
    resizeDrag.current = null;
    setResizing(false);
  }

  useEffect(() => {
    let mounted = true;
    const load = () => {
      void invoke<AppInfo[]>("list_apps").then((items) => { if (mounted) setApps(items ?? []); }).catch(console.error);
      void invoke<Microphone[]>("list_microphones").then((items) => { if (mounted) setMicrophones(items ?? []); }).catch(console.error);
      void invoke<BrowserSource[]>("list_browser_sources").then((items) => { if (mounted) setBrowserSources(items ?? []); }).catch(console.error);
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
    sources.set(key, { key, name: app.name, kind: "mac_app", app, iconPath: app.bundle_path, sessions: [] });
  }
  for (const mic of microphones) {
    const key = `mic:${mic.id}`;
    sources.set(key, { key, name: mic.name, kind: "mic", mic, sessions: [] });
  }
  const tabNameCounts = new Map<string, number>();
  const tabName = (tab: BrowserSource) => programTitle(tab.title, tab.site) || tab.site;
  const browserIcon = (bundle?: string | null) => apps.find((app) => app.app_id === (bundle ?? "com.google.chrome"))?.bundle_path;
  for (const browser of browserSources) {
    const name = tabName(browser);
    tabNameCounts.set(name, (tabNameCounts.get(name) ?? 0) + 1);
  }
  for (const browser of browserSources) {
    const key = `chromium_tab:${browser.source_id}`;
    const fallback = t("Tab {number}", { number: browser.ordinal });
    const description = tabName(browser);
    const title = description && (tabNameCounts.get(description) ?? 0) > 1
      ? `${description} · ${fallback}` : description || fallback;
    sources.set(key, { key, name: title, browser, kind: "chromium_tab", iconPath: browserIcon(browser.bundle_id), sessions: [] });
  }
  for (const session of sessions) {
    const key = sourceKey(session);
    if (!sources.has(key)) {
      const tab = session.kind === "chromium_tab";
      const iconPath = tab ? browserIcon(session.app_bundle_id) : apps.find((item) => item.app_id === session.app_bundle_id)?.bundle_path;
      sources.set(key, { key, name: tab ? programTitle(session.title) : session.title, kind: session.kind, iconPath, sessions: [] });
    }
    sources.get(key)!.sessions.push(session);
  }
  const activeSession = (source: Source) => source.sessions.find((session) => ACTIVE.includes(session.status)) ?? (source.browser ? remoteSession(source.browser) : undefined);
  const isAudible = (item: Source) => {
    if (item.app?.is_emitting || item.browser?.audible) return true;
    const session = activeSession(item);
    return !!session && session.status === "capturing" && (cards[session.id]?.levelDb ?? -120) >= -55;
  };
  const all = [...sources.values()];
  const running = all.filter((source) => activeSession(source) || source.browser?.standalone_recording);
  const playing = all.filter((source) => !source.mic && isAudible(source));
  const mics = all.filter((source) => source.mic);
  const idle = all.filter((source) => source.app && !isAudible(source));
  const tabs = all.filter((source) => source.browser && !isAudible(source));
  const offline = all.filter((source) => !source.app && !source.mic && !source.browser && !isAudible(source) &&
    (activeSession(source) || source.sessions.some(isSaved)));
  const shown = activeOnly ? running : [...playing, ...mics, ...idle, ...tabs, ...offline];
  const source = shown.find((item) => item.key === selected) ??
    (activeOnly ? (endedSource && endedSource === selected ? sources.get(endedSource) : undefined) ?? running[0] : null);
  const current = source ? activeSession(source) : undefined;

  async function start(source: Source) {
    if (starting.includes(source.key)) return;
    setSelected(source.key);
    setEndedSource(null);
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
      } else if (source.browser) {
        const gesture = await invoke<"sent" | "needs_permission" | "not_focused">("open_browser_source", { sourceId: source.browser.source_id, mode, mutePlayback });
        flash(gesture === "sent" ? t("Starting the recording in Chrome…")
          : gesture === "needs_permission" ? t("To start Chrome tab recordings from here, allow Multicorder in System Settings → Privacy & Security → Accessibility. Until then, click the Multicorder icon in Chrome.")
          : t("Click the Multicorder icon in Chrome to start recording this tab."));
        // The extension creates the session; pick it up without waiting for the next poll.
        for (const delay of [1200, 3000, 6000]) setTimeout(refresh, delay);
        return;
      } else {
        return;
      }
      if (result?.session?.status === "waiting" && !source.app?.is_emitting) flash(t(WAITING_FOR_AUDIO));
      refresh();
    } catch (failure) {
      flash(tError(failure));
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
    const audible = isAudible(item);
    const canStart = !!(item.app || item.mic || item.browser) && !item.browser?.standalone_recording;
    const label = t("Record");
    const remark = remarks[item.key];
    const name = remark || item.name;
    const editLabel = t("Edit audio source remark for {name}", { name });
    const selectedRow = item.key === source?.key;
    return (
      <li key={item.key} className={["source-row", audible ? "" : "audio-idle", item.mic?.channel ? "mic-channel" : "", selectedRow ? "is-selected" : ""].join(" ")}>
        <span className={`audio-dot ${audible ? "on" : ""}`} aria-hidden />
        <AppIcon path={item.iconPath} invoke={invoke} fallback={item.mic ? "mic" : item.browser ? "tab" : "app"} size={18} />
        <div className="source-row-label">
          <div className="source-row-primary">
            <button type="button" className="source-row-name" aria-current={selectedRow} title={name} onClick={() => { setSelected(item.key); setEndedSource(null); }}>{name}</button>
            <button type="button" className="source-remark-edit" aria-label={editLabel} title={editLabel} onClick={() => openRemark(item)}><Icon name="edit" size={12} /></button>
          </div>
          {remark && <div className="source-original-name">{item.name}</div>}
          {!remark && item.browser?.site && item.browser.title && <div className="source-original-name" title={item.browser.app}>{item.browser.site}</div>}
        </div>
        {item.mic?.is_default && !activeOnly && <span className="chip default">{t("Default")}</span>}
        {phase ? <span className={`chip ${phaseChip(phase)}`}>{phase === "capturing" && <span className="dot" />}{phaseText(phase)}</span>
          : item.browser?.standalone_recording ? <span className="chip rec"><span className="dot" />{t("Recording in Chrome")}</span>
          : canStart && <button className={`btn btn-sm btn-record${audible ? " is-ready" : ""}`} disabled={starting.includes(item.key)} aria-label={`${label} ${name}`} title={audible ? undefined : t(WAITING_FOR_AUDIO)} onClick={() => void start(item)}><Icon name="record" size={13} />{label}</button>}
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
    <div ref={live} className={`live${resizing ? " is-resizing" : ""}`} style={{ gridTemplateColumns: `${sourceWidth}px minmax(0, 1fr)` }}>
      <section id="audio-sources" className="sources" aria-label={activeOnly ? t("Active sources") : t("Audio sources")}>
        {activeOnly ? (
          <>
            <div className="pane-title"><h2>{t("Recording now")}</h2></div>
            <ul className="apps">{running.map(row)}{!running.length && <li className="small muted source-empty">{t("No active recordings.")}</li>}</ul>
          </>
        ) : <>
          <div className="pane-title"><h2>{t("Audio sources")}</h2></div>
          {group(t("Playing now"), playing, t("No app is playing audio."))}
          {group(t("Microphones"), mics, t("No microphone is connected."))}
          {group(t("No sound detected"), idle)}
          {group(t("Chrome tabs"), tabs)}
          {group(t("Offline sources"), offline)}
        </>}
      </section>
      <div
        className="sources-resize"
        role="separator"
        tabIndex={0}
        aria-label={t("Resize audio sources column")}
        aria-controls="audio-sources"
        aria-orientation="vertical"
        aria-valuemin={MIN_SOURCE_WIDTH}
        aria-valuemax={maxSourceWidth}
        aria-valuenow={sourceWidth}
        onPointerDown={(event) => {
          if (event.button !== 0 || resizeDrag.current) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          resizeDrag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: sourceWidth };
          setResizing(true);
        }}
        onPointerMove={(event) => {
          const drag = resizeDrag.current;
          if (drag?.pointerId === event.pointerId) {
            setPreferredWidth(clampSourceWidth(drag.startWidth + event.clientX - drag.startX));
          }
        }}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onLostPointerCapture={finishResize}
        onKeyDown={(event) => {
          const widths: Record<string, number> = {
            ArrowLeft: sourceWidth - 16,
            ArrowRight: sourceWidth + 16,
            Home: MIN_SOURCE_WIDTH,
            End: maxSourceWidth,
          };
          if (!Object.hasOwn(widths, event.key)) return;
          event.preventDefault();
          setPreferredWidth(clampSourceWidth(widths[event.key]));
        }}
      />
      <section className="board" key={source?.key ?? "empty"}>
        {source ? <RecordingPanel key={source.key} title={remarks[source.key] || source.name} iconPath={source.iconPath}
          mutePlayback={mutePlayback} setMutePlayback={source.mic ? undefined : changeMutePlayback}
          sessionMuted={current ? source.browser?.recording?.session_id === current.id ? source.browser.recording.muted : current.muted : undefined}
          remote={!!current && !!source.browser && remoteSession(source.browser)?.id === current.id} originalName={remarks[source.key] ? source.name : undefined} kind={source.kind}
          session={current} card={current ? cards[current.id] : undefined} cards={cards}
          clips={(source.app ? sessions.filter((session) => sourceKey(session) === source.key ||
            (session.kind === "chromium_tab" && session.app_bundle_id === source.app?.app_id)) : source.sessions).filter(isSaved)}
          canStart={!!(source.app || source.mic || source.browser) && !source.browser?.standalone_recording && !starting.includes(source.key)}
          standaloneRecording={!!source.browser?.standalone_recording}
          willWait={!isAudible(source)} lastFailure={source.sessions[0]?.failure}
          format={formats[source.key] ?? DEFAULT_RECORDING_FORMAT}
          setFormat={(format) => setFormats((current) => ({ ...current, [source.key]: format }))}
          onStart={() => start(source)} onStop={async (id) => {
            await invoke("stop_session", { id });
            setSelected(source.key);
            setEndedSource(source.key);
            const ended = sessions.find((session) => session.id === id);
            const fallback = ended ? recordingName(ended) : remarks[source.key] || source.name;
            setNaming({ id, fallback, value: fallback });
            nameDialog.current?.showModal();
            requestAnimationFrame(() => nameInput.current?.select());
          }} invoke={invoke} flash={flash} refresh={refresh} />
          : <div className="empty board-empty"><Icon name={activeOnly ? "live" : "speaker"} size={28} /><strong>{activeOnly ? t("Nothing is recording") : t("Pick an audio source")}</strong><span className="small">{activeOnly ? t("Start a source from All sources.") : t("Select an audio source to open its recording panel.")}</span></div>}
      </section>
      <dialog className="source-remark-dialog" ref={nameDialog} aria-labelledby="recording-name-title" onClose={() => setNaming(null)}>
        <form onSubmit={async (event) => {
          event.preventDefault();
          const edit = naming;
          nameDialog.current?.close();
          const name = edit?.value.trim();
          if (!edit || !name || name === edit.fallback) return;
          try {
            await invoke("rename_session", { id: edit.id, name });
            refresh();
          } catch (failure) {
            flash(tError(failure));
          }
        }}>
          <h2 id="recording-name-title">{t("Name this recording")}</h2>
          <label>{t("Name")}
            <input className="input" ref={nameInput} value={naming?.value ?? ""} placeholder={naming?.fallback} aria-describedby="recording-name-hint"
              onChange={(event) => { if (naming) setNaming({ ...naming, value: event.target.value }); }} />
          </label>
          <p className="source-original-name" id="recording-name-hint">{t("Keep the suggested name to let AI name it after the summary. You can rename it later from any list.")}</p>
          <div className="source-remark-actions">
            <button className="btn" type="button" onClick={() => nameDialog.current?.close()}>{t("Skip")}</button>
            <button className="btn btn-primary" type="submit">{t("Save")}</button>
          </div>
        </form>
      </dialog>
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
      flash(t("Retry failed: {error}", { error: tError(e) }));
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const [confirmDialog, confirm] = useConfirm();
  const remove = async () => {
    const ok = await confirm({
      title: t("Delete this recording?"),
      message: t("“{name}” and its audio, transcript and summary will be deleted. This can't be undone.", { name: recordingName(session) }),
      confirmLabel: t("Delete"),
    });
    if (!ok) return;
    try {
      await invoke("delete_session", { id: session.id });
      refresh();
    } catch (e) {
      flash(tError(e));
    }
  };
  const title = recordingName(session);
  const caption = captionFromEngine(lines.find((l) => l.engine?.startsWith("caption:"))?.engine);
  const asrInstead = async () => {
    const ok = await confirm({
      title: t("Transcribe with speech recognition?"),
      message: t("The platform subtitles, key points and summary of this recording are replaced by speech recognition of its audio. This uses your transcription service."),
      confirmLabel: t("Transcribe"),
      danger: false,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const n = await invoke<number>("transcribe_with_asr", { id: session.id });
      flash(t("Transcribing {n} part(s)…", { n }));
    } catch (e) {
      flash(tError(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const save = async (format: string) => {
    try {
      const path = format === "wav"
        ? await invoke<string | null>("export_audio", { id: session.id, name: title, title: t("Save audio") })
        : await invoke<string | null>("export", { id: session.id, format, name: title, title: t("Save transcript") });
      if (path) flash(t("Saved {path}", { path }));
    } catch (e) {
      flash(format === "wav" ? t("Could not save audio: {error}", { error: tError(e) }) : tError(e));
    }
  };
  const jump = (id: string) => {
    setFocus(id);
    document.getElementById(id)?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  return (
    <article className="detail">
      {confirmDialog}
      <header className="dhead">
        <div>
          <h2>{title}</h2>
          <p className="small muted">{t(KIND[session.kind] ?? session.kind)}{session.name?.trim() ? ` · ${sourceTitle(session)}` : ""} · {fmtTs(session.audio_ms)} · {new Date(session.started_at).toLocaleString(locale())}</p>
        </div>
        {waiting ? <span className="chip info">{t("Waiting for audio")}</span> : active ? <span className="chip rec"><span className="dot" />{t("Recording")}</span> : missing ? <span className="chip warn">{t("Text missing")}</span> : <span className="chip">{empty ? t("No audio") : t("Done")}</span>}
      </header>
      {waiting && <p className="small muted" role="status">{t(WAITING_FOR_AUDIO)}</p>}
      {missing > 0 && (
        <div className="banner warn"><Icon name="warn" /><span className="grow">{t("{n} part(s) are not transcribed yet ({time} of audio). The recording is saved; text fills in automatically when the service is back.", { n: missing, time: fmtTs(session.asr?.failed_ms ?? 0) })}</span><button className="btn btn-sm" disabled={busy} onClick={() => void retry()}><Icon name="retry" size={13} />{busy ? t("Retrying…") : t("Retry now")}</button></div>
      )}
      <div className="toolbar">
        <DownloadMenu options={[
          { key: "md", label: "Markdown (MD)" },
          { key: "srt", label: t("Subtitles (SRT)") },
          { key: "vtt", label: t("Subtitles (VTT)") },
          { key: "json", label: "JSON" },
          ...(!waiting && !empty ? [{ key: "wav", label: t("Audio (WAV)") }] : []),
        ]} onPick={(format) => void save(format)} />
        {caption && <span className="source-tag" title={t("This recording's text comes from the platform's subtitles, not speech recognition.")}><Icon name="captions" size={12} />{captionLabel(caption)}</span>}
        {!missing && !active && !empty && (caption
          ? <button className="btn btn-sm" disabled={busy} onClick={() => void asrInstead()}><Icon name="mic" size={13} />{t("Transcribe with speech recognition")}</button>
          : <button className="btn btn-sm" disabled={busy} onClick={() => void retry()}><Icon name="retry" size={13} />{t("Transcribe again")}</button>)}
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

type TimeRange = "all" | "today" | "week" | "month";
type SortOrder = "newest" | "oldest" | "longest" | "shortest" | "name";
const HISTORY_VIEW_KEY = "mc-history-view";
const TIME_RANGES: TimeRange[] = ["all", "today", "week", "month"];
const SORT_ORDERS: SortOrder[] = ["newest", "oldest", "longest", "shortest", "name"];

/** Since when a time filter keeps recordings (ms since epoch); 0 keeps everything. */
function rangeStart(range: TimeRange) {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  if (range === "today") return day.getTime();
  if (range === "week") return day.getTime() - 6 * 86400000;
  if (range === "month") return day.getTime() - 29 * 86400000;
  return 0;
}

function History({ sessions, cards, refresh, flash }: { sessions: Row[]; cards: Cards; refresh: () => void; flash: (text: string) => void }) {
  const [detail, setDetail] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [visible, setVisible] = useState(12);
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [view, setView] = useState(() => {
    const saved = readJson<{ app?: unknown; range?: unknown; sort?: unknown }>(HISTORY_VIEW_KEY, {});
    return {
      app: typeof saved.app === "string" ? saved.app : "",
      range: TIME_RANGES.includes(saved.range as TimeRange) ? saved.range as TimeRange : "all",
      sort: SORT_ORDERS.includes(saved.sort as SortOrder) ? saved.sort as SortOrder : "newest",
    };
  });
  const change = (next: Partial<typeof view>) => {
    const value = { ...view, ...next };
    setView(value);
    setVisible(12);
    store(HISTORY_VIEW_KEY, JSON.stringify(value));
  };
  useEffect(() => { void invoke<AppInfo[]>("list_apps").then((items) => setApps(items ?? [])).catch(() => {}); }, []);
  const appFor = (bundle?: string | null) => bundle ? apps.find((app) => app.app_id.toLowerCase() === bundle.toLowerCase()) : undefined;
  const browserFor = (row: Row) => appFor(row.app_bundle_id ?? "com.google.chrome");
  const iconFor = (row: Row) => row.kind === "mic" ? null : (row.kind === "chromium_tab" ? browserFor(row) : appFor(row.app_bundle_id))?.bundle_path;
  /** The app filter groups recordings by app: each Mac app, each browser's tabs, each microphone. */
  const appOf = (row: Row): { key: string; label: string } => row.kind === "chromium_tab"
    ? { key: `tab:${(row.app_bundle_id ?? "com.google.chrome").toLowerCase()}`, label: t("{browser} tabs", { browser: browserFor(row)?.name ?? "Chrome" }) }
    : row.kind === "mic" ? { key: `mic:${row.title}`, label: row.title }
    : { key: `app:${(row.app_bundle_id ?? row.title).toLowerCase()}`, label: appFor(row.app_bundle_id)?.name ?? row.title };

  const query = search.trim().toLowerCase();
  const saved = useMemo(() => sessions.filter(isSaved), [sessions]);
  const appOptions = useMemo(() => {
    const options = new Map<string, { label: string; count: number }>();
    for (const row of saved) {
      const { key, label } = appOf(row);
      options.set(key, { label, count: (options.get(key)?.count ?? 0) + 1 });
    }
    return [...options].sort((a, b) => a[1].label.localeCompare(b[1].label, locale()));
  }, [saved, apps]);
  const app = appOptions.some(([key]) => key === view.app) ? view.app : "";
  const shown = useMemo(() => {
    const since = rangeStart(view.range);
    const rows = saved.filter((row) => (!app || appOf(row).key === app)
      && (!since || Date.parse(row.started_at) >= since)
      && (!query || [recordingName(row), row.title, appOf(row).label].some((text) => text.toLowerCase().includes(query))));
    const time = (row: Row) => Date.parse(row.started_at);
    const compare: Record<SortOrder, (a: Row, b: Row) => number> = {
      newest: (a, b) => time(b) - time(a),
      oldest: (a, b) => time(a) - time(b),
      longest: (a, b) => b.audio_ms - a.audio_ms,
      shortest: (a, b) => a.audio_ms - b.audio_ms,
      name: (a, b) => recordingName(a).localeCompare(recordingName(b), locale(), { numeric: true }),
    };
    return rows.sort(compare[view.sort]);
  }, [saved, app, view.range, view.sort, query, apps]);
  const filtered = !!(query || app || view.range !== "all");
  const current = saved.find((row) => row.id === detail);
  const rangeLabel: Record<TimeRange, string> = { all: t("All time"), today: t("Today"), week: t("Last 7 days"), month: t("Last 30 days") };
  const sortLabel: Record<SortOrder, string> = { newest: t("Newest first"), oldest: t("Oldest first"), longest: t("Longest first"), shortest: t("Shortest first"), name: t("Name (A–Z)") };
  return (
    <div className="history">
      {current ? <>
        <button className="btn btn-ghost back" onClick={() => setDetail(null)}><Icon name="back" />{t("Back to history")}</button>
        <Detail key={current.id} session={current} refresh={refresh} flash={flash} />
      </> : <div className="history-inner">
        <div className="pane-title history-head">
          <h2>{t("History")}{saved.length > 0 && <span className="count">{filtered ? `${shown.length} / ${saved.length}` : saved.length}</span>}</h2>
          <div className="history-filter"><Icon name="search" /><input className="input" placeholder={t("Search recordings")} aria-label={t("Search recordings")} value={search} onChange={(e) => { setSearch(e.target.value); setVisible(12); }} /></div>
        </div>
        {saved.length > 0 && <div className="history-tools">
          <select className="input input-sm" aria-label={t("Filter by app")} value={app} onChange={(e) => change({ app: e.target.value })}>
            <option value="">{t("All apps")}</option>
            {appOptions.map(([key, { label, count }]) => <option key={key} value={key}>{label} ({count})</option>)}
          </select>
          <select className="input input-sm" aria-label={t("Filter by time")} value={view.range} onChange={(e) => change({ range: e.target.value as TimeRange })}>
            {TIME_RANGES.map((range) => <option key={range} value={range}>{rangeLabel[range]}</option>)}
          </select>
          <span className="grow" />
          <label className="history-sort"><span>{t("Sort")}</span>
            <select className="input input-sm" value={view.sort} onChange={(e) => change({ sort: e.target.value as SortOrder })}>
              {SORT_ORDERS.map((sort) => <option key={sort} value={sort}>{sortLabel[sort]}</option>)}
            </select>
          </label>
          {filtered && <button className="btn btn-sm btn-ghost" onClick={() => { setSearch(""); change({ app: "", range: "all" }); }}>{t("Clear filters")}</button>}
        </div>}
        {shown.length ? <ul className="history-clips">{shown.slice(0, visible).map((row) => (
          <SavedClip key={row.id} clip={row} iconPath={iconFor(row)} revision={cards[row.id]?.textRevision} invoke={invoke} flash={flash} showSource onDetails={() => setDetail(row.id)} onRenamed={refresh} onDeleted={refresh} />
        ))}</ul> : <div className="empty"><Icon name="history" size={28} /><span>{filtered ? t("No matching recordings.") : t("Finished recordings will appear here.")}</span></div>}
        {shown.length > visible && <button className="btn" onClick={() => setVisible((count) => count + 12)}>{t("Show more recordings")}</button>}
      </div>}
    </div>
  );
}

function Settings({ status, reloadStatus, flash }: { status: Status | null; reloadStatus: () => void; flash: (text: string) => void }) {
  const row = (label: string, value: React.ReactNode) => <div className="srow"><span className="muted">{label}</span><span>{value}</span></div>;
  return (
    <div className="settings">
      <div className="settings-inner">
        <div className="pane-title"><h2>{t("Settings")}</h2></div>
        <section className="card">
          <h3>{t("General")}</h3>
          <PreferenceControls />
        </section>
        <section className="card">
          <h3>{t("Transcription and summaries")}</h3>
          <AiSettings invoke={invoke} onSaved={reloadStatus} flash={flash} />
          {status && <>
            {row(t("Transcription"), status.asr_ready ? <span className="chip ok"><span className="dot" />{status.asr.startsWith("service:") ? t("Multicorder service") : status.asr}</span> : <span className="chip warn">{t("No key configured")}</span>)}
            {row(t("Summaries"), status.llm_ready ? <span className="chip ok"><span className="dot" />{t("Ready")}</span> : <span className="chip warn">{t("No model key")}</span>)}
            {row(t("Spent today"), t("${spent} of ${cap}", { spent: status.spent_today_usd.toFixed(3), cap: status.daily_cap_usd.toFixed(2) }))}
          </>}
        </section>
        <details className="card dev-options">
          <summary><h3>{t("Developer options")}</h3></summary>
          <ServiceDevOptions invoke={invoke} onSaved={reloadStatus} flash={flash} />
          {status && <>
            {row(t("Address for the extension"), <code>127.0.0.1:{status.api_port}</code>)}
            {status.app_version && row(t("App version"), <code>{status.app_version}</code>)}
            {row(t("Data folder"), <code>{status.data_dir}</code>)}
          </>}
          <p className="small muted">{t("The Chrome extension can use this Mac as its transcription and summary service (Settings → “This Mac”).")}</p>
        </details>
      </div>
    </div>
  );
}

/** Sidebar width, dragged by its right edge; dragging past the snap point leaves only icons. */
function useSidebarWidth() {
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
      return saved === SIDEBAR.compact || (saved >= SIDEBAR.min && saved <= SIDEBAR.max) ? saved : SIDEBAR.initial;
    } catch { return SIDEBAR.initial; }
  });
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 960px)").matches);
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 960px)");
    const update = () => setNarrow(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const clamp = (value: number) => value < SIDEBAR.snap ? SIDEBAR.compact : Math.min(SIDEBAR.max, Math.max(SIDEBAR.min, value));
  const commit = (value: number) => {
    const next = clamp(value);
    setWidth(next);
    store(SIDEBAR_WIDTH_KEY, String(next));
  };
  const shown = narrow ? SIDEBAR.compact : width;
  const finish = (event: React.PointerEvent) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
  };
  const handle = (
    <div className="sidebar-resize" role="separator" tabIndex={0} aria-label={t("Resize sidebar")} aria-orientation="vertical"
      aria-valuemin={SIDEBAR.compact} aria-valuemax={SIDEBAR.max} aria-valuenow={shown} hidden={narrow}
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: shown };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (current?.pointerId === event.pointerId) commit(current.startWidth + event.clientX - current.startX);
      }}
      onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
      onDoubleClick={() => commit(shown === SIDEBAR.compact ? SIDEBAR.initial : SIDEBAR.compact)}
      onKeyDown={(event) => {
        const next: Record<string, number> = { ArrowLeft: shown === SIDEBAR.min ? SIDEBAR.compact : shown - 16, ArrowRight: shown === SIDEBAR.compact ? SIDEBAR.min : shown + 16, Home: SIDEBAR.compact, End: SIDEBAR.max };
        if (!Object.hasOwn(next, event.key)) return;
        event.preventDefault();
        commit(next[event.key]);
      }} />
  );
  return { width: shown, compact: shown === SIDEBAR.compact, dragging, handle };
}

function App() {
  useLang();
  const sidebar = useSidebarWidth();
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
  const reloadStatus = () => void invoke<Status>("status").then(setStatus).catch(() => {});
  const refresh = () => invoke<Row[]>("list_sessions").then((x) => setSessions(x ?? [])).catch(() => {});
  useEffect(() => {
    void refresh();
    reloadStatus();
    const timer = setInterval(refresh, 15000);
    const apply = (e: EngineEvent) => {
      if (e.type === "status" || e.type === "report") void refresh();
      setCards((prev) => {
        const c = prev[e.session_id] ?? { lines: [], insights: [] };
        const n = { ...c };
        if (e.type === "level") n.levelDb = e.rms_db;
        if (e.type === "waveform") {
          n.peaks = [...(c.peaks ?? []), ...e.peaks].slice(-LIVE_PEAK_WINDOW);
          n.peakCount = (c.peakCount ?? 0) + e.peaks.length;
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
        if (e.type === "text_source") n.textSource = { source: e.source, active: e.active };
        return { ...prev, [e.session_id]: n };
      });
    };
    if (!inApp) {
      const stopMock = mockEngineEvents(apply);
      return () => {
        clearInterval(timer);
        stopMock();
      };
    }
    const un = listen<EngineEvent>("engine", ({ payload }) => apply(payload));
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
    <div className={`app${sidebar.compact ? " sidebar-compact" : ""}${sidebar.dragging ? " is-resizing" : ""}`} style={{ gridTemplateColumns: `${sidebar.width}px minmax(0, 1fr)` }}>
      <style>{THEME_CSS + PREFS_CSS + CARD_CSS + APP_CSS + RECORDER_CSS + RECORDING_CSS + AI_SETTINGS_CSS}</style>
      <aside className="sidebar">
        <div className="brand"><span className="logo" aria-hidden><Icon name="wave" /></span><strong className="nav-text">Multicorder</strong></div>
        <nav className="nav" aria-label="Recording views">
          {nav.map(({ id, label, icon }) => <button key={id} className="navbtn" aria-label={id === "recording" && recording > 0 ? `${label} ${recording}` : label} title={label} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>
            <Icon name={icon} /><span className="nav-text">{label}</span>{id === "recording" && recording > 0 && <span className="badge">{recording}</span>}
          </button>)}
        </nav>
        <div className="sidebar-foot">
          {status && <div className={`svc-status ${status.asr_ready && !degraded ? "ok" : "warn"}`} title={degraded ? t("Some recordings are waiting for transcription") : status.asr}><span className="dot" /><span className="nav-text">{health}</span></div>}
          <div className="quick-prefs">
            <ThemeToggle /><LangToggle />
            <button className="btn btn-ghost icon-btn settings-btn" aria-label={t("Settings")} title={t("Settings")} aria-current={tab === "settings" ? "page" : undefined} onClick={() => setTab("settings")}><Icon name="gear" /></button>
          </div>
        </div>
        {sidebar.handle}
      </aside>
      <main>
        {(tab === "sources" || tab === "recording") && <Live activeOnly={tab === "recording"} selected={selected} setSelected={setSelected} sessions={sessions} cards={cards} remarks={remarks} saveRemark={saveRemark} refresh={refresh} flash={flash} />}
        {tab === "history" && <History sessions={sessions} cards={cards} refresh={refresh} flash={flash} />}
        {tab === "settings" && <Settings status={status} reloadStatus={reloadStatus} flash={flash} />}
      </main>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

const APP_CSS = `
html,body,#root{height:100%}
body{overflow:hidden}
.app{display:grid;grid-template-columns:216px minmax(0,1fr);height:100vh}
.sidebar{display:flex;flex-direction:column;gap:14px;padding:14px 10px 12px;background:var(--sidebar);border-right:1px solid var(--border);min-height:0;min-width:0;position:relative}
.sidebar-resize{position:absolute;top:0;bottom:0;right:-6px;width:12px;z-index:3;cursor:col-resize;touch-action:none}
.sidebar-resize:hover::after,.sidebar-resize:focus-visible::after,.is-resizing>.sidebar .sidebar-resize::after{content:"";position:absolute;inset:0 5px;background:var(--primary)}
.sidebar-resize:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
.nav-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
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
.quick-prefs{display:flex;align-items:center;gap:2px;padding:0 2px}
.quick-prefs .icon-btn{color:var(--text-2)}
.quick-prefs .icon-btn:hover{color:var(--text)}
.settings-btn{margin-left:auto}
.settings-btn[aria-current="page"]{background:var(--surface);color:var(--text);box-shadow:var(--shadow)}
.sidebar-compact .sidebar{padding:12px 8px;align-items:center}
.sidebar-compact .nav-text{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.sidebar-compact .navbtn{justify-content:center;width:40px;padding:0;position:relative}
.sidebar-compact .badge{position:absolute;top:-3px;right:-3px;line-height:16px;min-width:16px;padding:0 4px;font-size:10px}
.sidebar-compact .svc-status{padding:8px;justify-content:center}
.sidebar-compact .quick-prefs{flex-direction:column;padding:0}
.sidebar-compact .settings-btn{margin-left:0;order:-1}
.sidebar-compact .brand{padding:2px 0 4px}
main{min-width:0;min-height:0;overflow:hidden}
.pane-title{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:30px}
.pane-title h2{margin:0;font-size:16px;display:flex;align-items:center;gap:8px}
.live{display:grid;grid-template-rows:minmax(0,1fr);height:100%}
@media (max-width:820px){.source-row .chip.default{display:none}}
.sources{grid-area:1/1;border-right:1px solid var(--border);padding:16px 12px;overflow:auto;display:flex;flex-direction:column;gap:14px;background:var(--surface)}
.sources-resize{grid-area:1/1;justify-self:end;width:12px;margin-right:-5px;z-index:2;cursor:col-resize;touch-action:none;position:relative}
.sources-resize:hover::after,.sources-resize:focus-visible::after,.live.is-resizing .sources-resize::after{content:"";position:absolute;inset:0 5px;background:var(--primary)}
.sources-resize:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
.is-resizing{cursor:col-resize;user-select:none}
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
.source-remark-edit{display:grid;place-items:center;flex:none;width:22px;height:22px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--text-3);cursor:pointer}
.source-remark-edit:hover{background:var(--surface-3);color:var(--text)}
.source-remark-dialog{width:min(380px,calc(100% - 32px));padding:20px;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);color:var(--text);box-shadow:var(--shadow-lg)}
.source-remark-dialog::backdrop{background:rgb(0 0 0 / 35%);backdrop-filter:blur(2px)}
.source-remark-dialog form{display:grid;gap:8px}
.source-remark-dialog h2,.source-remark-dialog p{margin:0}
.source-remark-dialog label{display:grid;gap:6px;margin-top:6px;font-size:12px;color:var(--text-2)}
.source-remark-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:8px}
.board{grid-area:1/2;padding:20px;min-width:0;overflow:auto}
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
.history-tools{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.history-tools .grow{flex:1}
.history-tools select{width:auto;max-width:220px}
.history-sort{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-3)}
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
