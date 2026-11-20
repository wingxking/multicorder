// Side panel. At the top, the recorder for the tab in front of you (record, end and save, pause,
// marker, catch up, summary mode, "Record silently", live captions). Below it: recordings in
// other tabs, tabs playing sound, the other tabs and recent recordings. Recordings started or
// controlled from the Mac app show up here and stay in sync (the capture always runs in this
// extension; the Mac app sends its controls here).

import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ACTIVE_SESSION_STATUSES, Api, applyTheme, CARD_CSS, CardState, describeDetail, EngineEvent, fmtClock, fmtTs, Icon, LevelMeter, LIVE_PEAK_WINDOW, LiveWaveform, locale, programTitle, RECORDER_CSS, Session, SummaryMode, Switch, t, tError, THEME_CSS, TextSourceBadge, TransportButton, useConfirm, useLang, useToast } from "@multicorder/ui";
import AudioPlayer, { type PlayerHandle } from "@multicorder/ui/src/AudioPlayer";
import { devReloadPage } from "./dev-reload";
import * as db from "./local/db";
import { AppConnection, loadSettings, saveSettings, SERVICE_LABEL, ServiceEnv } from "./local/settings";
import type { CaptureState } from "./protocol";

type Backend = "local" | "app";
type Card = CardState & { backend: Backend };
type Capture = CaptureState & { wave: number[]; peakCount: number };
type RecordingTabs = Record<string, { sessionId: string; backend: Backend }>;
type ControlAction = "pause" | "resume" | "mute" | "unmute" | "cancel" | "mode" | "rename";
type Naming = { id: string; value: string; fallback: string };
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

const RECENT_LIMIT = 8;

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

const sourceTitle = (session: Session) => programTitle(session.title);
const recordingName = (session: Session) => session.name?.trim() || sourceTitle(session);
const recordable = (tab?: chrome.tabs.Tab) => !!tab && tab.id !== undefined && /^https?:|^file:/.test(tab.url ?? "");
const siteOf = (tab: chrome.tabs.Tab) => { try { return new URL(tab.url ?? "").hostname.replace(/^www\./, ""); } catch { return ""; } };
const fileName = (name: string, extension: string) => `${name.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 120) || "Multicorder"}.${extension}`;

function Favicon({ tab, size = 16 }: { tab?: chrome.tabs.Tab; size?: number }) {
  const url = tab?.favIconUrl;
  return url && /^https?:|^data:/.test(url)
    ? <img className="tab-fav" src={url} width={size} height={size} alt="" />
    : <span className="tab-fav tab-fav-generic" style={{ width: size, height: size }} aria-hidden><Icon name="tab" size={Math.round(size * 0.8)} /></span>;
}

/** All tabs, and the active tab of the window this side panel belongs to. */
function useTabs() {
  const [tabs, setTabs] = useState<chrome.tabs.Tab[]>([]);
  const [windowId, setWindowId] = useState<number>();
  useEffect(() => {
    let mounted = true;
    let query = 0;
    const refresh = () => {
      const latest = ++query;
      void chrome.tabs.query({}).then((found) => { if (mounted && latest === query) setTabs(found.filter((tab) => tab.id !== undefined)); }).catch(console.error);
    };
    const updated: Parameters<typeof chrome.tabs.onUpdated.addListener>[0] = (_id, change) => {
      if (change.audible !== undefined || change.mutedInfo || change.title || change.url || change.favIconUrl) refresh();
    };
    void chrome.windows.getCurrent().then((win) => { if (mounted) setWindowId(win.id); });
    chrome.tabs.onUpdated.addListener(updated);
    const events = [chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onActivated, chrome.tabs.onAttached, chrome.tabs.onDetached];
    events.forEach((event) => event.addListener(refresh));
    refresh();
    return () => {
      mounted = false;
      chrome.tabs.onUpdated.removeListener(updated);
      events.forEach((event) => event.removeListener(refresh));
    };
  }, []);
  const active = tabs.find((tab) => tab.active && tab.windowId === windowId);
  return { tabs, active };
}

async function goToTab(tab: chrome.tabs.Tab) {
  if (tab.id === undefined) return;
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

/** The recorder for the tab in front of the user. */
function ThisTab(props: {
  tab?: chrome.tabs.Tab;
  card?: Card;
  capture?: Capture;
  sessionId?: string;
  backend?: Backend;
  prefs: { mode: SummaryMode; silent: boolean };
  setPrefs: (patch: { mode?: SummaryMode; silent?: boolean }) => void;
  missed?: string[];
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  onCancel: () => Promise<void>;
  control: (action: ControlAction, extra?: object) => Promise<void>;
  onMarker?: () => Promise<void>;
  onMissed: () => Promise<void>;
  onRetry: () => Promise<void>;
  naming: Naming | null;
  setNaming: (value: Naming | null) => void;
  /** Chrome refused to start without a toolbar click; the icon is marked REC on this tab. */
  needsClick?: { pinned: boolean };
}) {
  const { tab, card, capture, sessionId, prefs, naming } = props;
  const [busy, setBusy] = useState(false);
  const [markers, setMarkers] = useState<number[]>([]);
  const [confirmDialog, confirm] = useConfirm();
  useEffect(() => setMarkers([]), [sessionId]);
  const status = capture?.status ?? card?.session.status;
  const recording = !!sessionId;
  const paused = status === "paused";
  const waiting = status === "waiting";
  const finishing = status === "stopping";
  const live = recording && !paused && !waiting && !finishing;
  const elapsed = capture?.elapsed_ms ?? card?.session.audio_ms ?? 0;
  const mode = capture?.mode ?? card?.session.summary_mode ?? prefs.mode;
  const muted = recording ? capture?.muted ?? prefs.silent : prefs.silent;
  const degraded = (card?.asr?.state === "degraded" && (card.asr.failed_chunks ?? 0) > 0) || !!card?.detail?.startsWith("asr_unavailable");
  const note = describeDetail(card?.detail);
  const title = tab ? programTitle(tab.title, siteOf(tab)) || tab.title || t("Browser tab") : "";

  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    try { await work(); } finally { setBusy(false); }
  }

  const namePrompt = naming && naming.id !== sessionId && (
    <form className="name-prompt" onSubmit={(event) => {
      event.preventDefault();
      const name = naming.value.trim();
      props.setNaming(null);
      if (name && name !== naming.fallback) void props.control("rename", { name, sessionId: naming.id });
    }}>
      <label className="small">{t("Name this recording")}
        <input className="input input-sm" autoFocus value={naming.value} placeholder={naming.fallback} onFocus={(event) => event.target.select()}
          onChange={(event) => props.setNaming({ ...naming, value: event.target.value })} />
      </label>
      <p className="small muted">{t("Keep the suggested name to let AI name it after the summary. You can rename it later from any list.")}</p>
      <div className="name-prompt-actions">
        <button className="btn btn-sm" type="button" onClick={() => props.setNaming(null)}>{t("Skip")}</button>
        <button className="btn btn-sm btn-primary" type="submit">{t("Save")}</button>
      </div>
    </form>
  );

  if (!tab || !recordable(tab)) {
    return (
      <section className="this-tab" aria-label={t("This tab")}>
        <div className="this-tab-head"><span className="this-tab-label">{t("This tab")}</span></div>
        {namePrompt}
        <p className="small muted">{t("Open a web page with audio or video to record it here.")}</p>
      </section>
    );
  }

  return (
    <section className={`this-tab${live ? " is-live" : ""}`} aria-label={t("This tab")}>
      {confirmDialog}
      <div className="this-tab-head">
        <span className="this-tab-label">{t("This tab")}</span>
        <span className="grow" />
        {recording && <span className={`chip ${status === "capturing" ? "rec" : paused ? "warn" : "info"}`}>{status === "capturing" && <span className="dot" />}
          {paused ? t("Paused") : waiting ? t("Waiting") : finishing ? t("Saving") : t("Recording")}</span>}
      </div>
      <div className="this-tab-title">
        <Favicon tab={tab} size={20} />
        <div className="grow-min">
          <strong title={tab.title}>{title}</strong>
          <span className="small muted">{siteOf(tab)}{props.backend === "app" ? ` · ${t("Mac app")}` : ""}</span>
        </div>
      </div>
      {namePrompt}

      <div className="transport">
        <div className="transport-main">
          <div className="transport-buttons">
            {!recording ? (
              <TransportButton variant="record" label={t("Record tab")} disabled={busy} title={t("Start recording")} onClick={() => void act(props.onStart)} />
            ) : (
              <>
                <TransportButton variant={paused ? "resume" : "pause"} label={paused ? t("Resume") : t("Pause")} disabled={busy || finishing || waiting}
                  onClick={() => void act(() => props.control(paused ? "resume" : "pause"))} />
                {props.onMarker && <TransportButton variant="plain" icon="flag" label={t("Marker")} title={t("Add marker")} disabled={busy || !live}
                  onClick={() => void act(async () => { await props.onMarker!(); setMarkers((list) => [...list, elapsed]); })} />}
                {card?.lines.length ? <TransportButton variant="plain" icon="clock" label={t("Catch up")} title={t("What did I miss?")} disabled={busy} onClick={() => void act(props.onMissed)} /> : null}
                <div className="transport-end">
                  <TransportButton variant="plain" icon="close" label={t("Discard")} title={t("Cancel this recording without saving it")} disabled={busy || finishing}
                    onClick={() => void (async () => {
                      const ok = await confirm({
                        title: t("Cancel this recording?"),
                        message: t("Recording stops and everything captured so far ({time}) is thrown away. Nothing is saved, and this can't be undone.", { time: fmtClock(elapsed) }),
                        confirmLabel: t("Discard recording"),
                        cancelLabel: t("Keep recording"),
                      });
                      if (ok) await act(props.onCancel);
                    })()} />
                  <TransportButton variant="stop" label={t("End & save")} title={t("End the recording and save it")} confirmLabel={t("Click again to end")}
                    disabled={busy || finishing} onClick={() => void act(props.onStop)} />
                </div>
              </>
            )}
          </div>
          <div className="transport-clock" role="timer" aria-label={t("Recorded time {time}", { time: fmtClock(elapsed) })}>
            <span className={`clock${live ? " is-live" : paused ? " is-paused" : ""}`}>{fmtClock(elapsed)}</span>
            <span className="clock-sub">16 kHz · {t("Mono")}</span>
            <TextSourceBadge state={card?.textSource} recording={recording} />
          </div>
          <LevelMeter peaks={capture?.wave ?? []} peakCount={capture?.peakCount ?? 0} active={live} />
        </div>
        <LiveWaveform peaks={capture?.wave ?? []} peakCount={capture?.peakCount ?? 0} elapsed={elapsed} live={live} paused={paused} markers={markers} />
        <div className="transport-options">
          <select className="input input-sm" aria-label={t("Summary mode")} disabled={finishing} value={mode}
            onChange={(event) => {
              const next = event.target.value as SummaryMode;
              if (recording) void act(() => props.control("mode", { mode: next }));
              else props.setPrefs({ mode: next });
            }}>
            <option value="live">{t("Live summary")}</option>
            <option value="after">{t("Summary at end")}</option>
            <option value="off">{t("Audio only")}</option>
          </select>
          <span className="grow" />
          <Switch checked={muted} disabled={finishing} label={t("Record silently")}
            title={recording ? t("Stops or resumes playing this tab through your speakers. The recording continues either way.") : t("Records the tab without playing it through your speakers or headphones.")}
            onChange={(value) => recording ? void act(() => props.control(value ? "mute" : "unmute")) : props.setPrefs({ silent: value })} />
        </div>
      </div>

      {!recording && props.needsClick && (
        <div className="click-callout" role="alert">
          <span className="click-callout-arrow" aria-hidden>↗</span>
          <div>
            <strong>{t("One more click: the Multicorder icon in the toolbar")}</strong>
            <p className="small">{props.needsClick.pinned
              ? t("Chrome starts recording a tab only after a click on the extension's icon. It's marked REC on this tab; clicking it starts recording with these settings. You can also press")
              : t("Chrome starts recording a tab only after a click on the extension's icon. Pin it first: click the puzzle-piece icon in the toolbar, then the pin next to Multicorder. Or press")} <kbd>⌥⇧R</kbd>.</p>
          </div>
        </div>
      )}
      {!recording && !props.needsClick && <p className="small hint">{t("If recording doesn't start, click the Multicorder toolbar icon or press")} <kbd>⌥⇧R</kbd>.</p>}
      {waiting && <p className="small muted" role="status">{t("No audio detected yet. Recording starts automatically when this tab plays sound.")}</p>}
      {note && <p className="small muted" role="status">{note}</p>}
      {degraded && <div className="banner warn"><Icon name="warn" /><span className="grow">{t("Transcription unavailable — the recording itself is safe. Text fills in automatically when the service is back.")}</span>
        <button className="btn btn-sm" disabled={busy} onClick={() => void act(props.onRetry)}><Icon name="retry" size={13} />{t("Retry")}</button></div>}
      {!!card?.lines.length && recording && <div className="captions" aria-live="polite">{card.lines.slice(-2).map((line) => <p key={line.id}><span className="ts">{fmtTs(line.start_ms)}</span> {line.text}</p>)}</div>}
      {!!card?.insights.length && recording && <ul className="points" aria-label={t("Key points")}>{card.insights.slice(-3).map((point) => <li key={point.key}>{point.text}</li>)}</ul>}
      {!!props.missed?.length && recording && <ul className="points missed" aria-label={t("What you missed")}>{props.missed.map((point, index) => <li key={index}>{point}</li>)}</ul>}
    </section>
  );
}

/** A finished recording: icon, name (rename in place), date and length, play on the right. */
function RecentRow({ card, api, flash, rename, open, onDeleted }: { card: Card; api: Api | null; flash: (text: string) => void; rename: (name: string | null) => Promise<void>; open?: () => void; onDeleted: () => void }) {
  const session = card.session;
  const name = recordingName(session);
  const [confirmDialog, confirm] = useConfirm();
  const [draft, setDraft] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [audio, setAudio] = useState<{ blob: Blob; autoPlay: boolean } | null>(null);
  const player = useRef<PlayerHandle>(null);

  async function blob(): Promise<Blob | null> {
    if (card.backend === "app") {
      if (!api) throw new Error(t("Mac app offline"));
      return api.audioBlob(session.id);
    }
    return db.recordingFile(session.id);
  }

  /** The first press loads the audio into the waveform player below the row; later presses toggle it. */
  async function play() {
    if (audio) return player.current?.toggle();
    setLoading(true);
    try {
      const file = await blob();
      if (!file?.size) return flash(t("No audio recorded yet."));
      setAudio({ blob: file, autoPlay: true });
    } catch (error) {
      flash(tError(error));
    } finally {
      setLoading(false);
    }
  }

  async function download() {
    try {
      const file = await blob();
      if (file?.size) save(fileName(name, card.backend === "app" ? "wav" : "webm"), file);
      else flash(t("No audio recorded yet."));
    } catch (error) {
      flash(t("Could not save audio: {error}", { error: tError(error) }));
    }
  }

  async function remove() {
    const ok = await confirm({
      title: t("Delete this recording?"),
      message: t("“{name}” and its audio, transcript and summary will be deleted. This can't be undone.", { name }),
      confirmLabel: t("Delete"),
    });
    if (!ok) return;
    try {
      setAudio(null);
      if (card.backend === "app") {
        if (!api) throw new Error(t("Mac app offline"));
        await api.delete(session.id);
      } else {
        await db.deleteSession(session.id);
      }
      flash(t("Recording deleted."));
      onDeleted();
    } catch (error) {
      flash(tError(error));
    }
  }

  async function commit() {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    if (next === name) return;
    await rename(next && next !== sourceTitle(session) ? next : null);
  }

  const date = new Date(session.started_at).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" });
  return (
    <li className={`saved-clip${audio ? " is-open" : ""}`}>
      {confirmDialog}
      <div className="clip-row">
        <span className="clip-icon"><Icon name="tab" size={14} /></span>
        <div className="clip-meta">
          {draft !== null ? (
            <input className="input input-sm clip-name-input" autoFocus value={draft} aria-label={t("Recording name")} placeholder={sourceTitle(session)}
              onFocus={(event) => event.target.select()} onChange={(event) => setDraft(event.target.value)} onBlur={() => void commit()}
              onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); void commit(); }
                if (event.key === "Escape") { event.preventDefault(); setDraft(null); }
              }} />
          ) : (
            <span className="clip-name">
              <button className="clip-name-text clip-name-link" title={name} onClick={open} disabled={!open}>{name}</button>
              {session.name_auto && <span className="clip-name-ai" title={t("Named by AI")}><Icon name="sparkle" size={11} /></span>}
              <button className="clip-rename" aria-label={t("Rename {name}", { name })} title={t("Rename")} onClick={() => setDraft(name)}><Icon name="edit" size={12} /></button>
            </span>
          )}
          {session.name?.trim() && <span className="clip-source">{sourceTitle(session)}</span>}
          <span className="clip-date">{date}</span>
          <span className="ts">{fmtTs(session.audio_ms || 0)}</span>
        </div>
        <div className="clip-buttons">
          <button className={`clip-play${playing ? " is-playing" : ""}`} disabled={loading} aria-label={playing ? t("Pause") : t("Play {name}", { name })} title={playing ? t("Pause") : t("Play")} onClick={() => void play()}>
            {loading ? <span className="spinner" aria-hidden /> : <Icon name={playing ? "pause" : "play"} size={13} />}
          </button>
          <button className="btn btn-sm btn-ghost icon-btn" aria-label={t("Download audio")} title={t("Download audio")} onClick={() => void download()}><Icon name="download" size={14} /></button>
          <button className="btn btn-sm btn-ghost icon-btn clip-delete" aria-label={t("Delete {name}", { name })} title={t("Delete")} onClick={() => void remove()}><Icon name="trash" size={14} /></button>
          {audio && <button className="btn btn-sm btn-ghost icon-btn" aria-label={t("Close player")} title={t("Close player")} onClick={() => setAudio(null)}><Icon name="close" size={13} /></button>}
        </div>
      </div>
      {audio && <AudioPlayer ref={player} audio={audio.blob} markers={[]} editing={false} autoPlay={audio.autoPlay} onPlayingChange={setPlaying} onError={flash} onExport={async () => {}} />}
    </li>
  );
}

function App() {
  useLang();
  const [api, setApi] = useState<Api | null>(null);
  const [processing, setProcessing] = useState<AppConnection>("auto");
  const [health, setHealth] = useState<Health | null>(null);
  const [cards, setCards] = useState<Record<string, Card>>({});
  const [captures, setCaptures] = useState<Record<string, Capture>>({});
  const [recordingTabs, setRecordingTabs] = useState<RecordingTabs>({});
  const [missed, setMissed] = useState<Record<string, string[]>>({});
  const [prefs, setPrefsState] = useState<{ mode: SummaryMode; silent: boolean }>({ mode: "live", silent: true });
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const [naming, setNaming] = useState<Naming | null>(null);
  const [needsClick, setNeedsClick] = useState<{ tabId: number; pinned: boolean } | null>(null);
  const [toast, flash] = useToast(3500);
  const { tabs, active } = useTabs();
  const esRef = useRef<EventSource | null>(null);
  const apiRef = useRef<Api | null>(null);

  const apply = (e: EngineEvent | any, backend: Backend) => {
    if (e.type === "waveform") return;
    if (e.type === "status" && e.status === "renamed") return void refresh();
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
        if (e.detail === "renamed" || e.status === "stopped") void refresh();
      }
      if (e.type === "asr") n.asr = e.asr;
      if (e.type === "transcript") n.lines = [...c.lines, e.event].slice(-3);
      if (e.type === "insight") n.insights = [...c.insights.filter((i) => i.key !== e.insight.key), e.insight].filter((i) => i.state !== "retracted");
      if (e.type === "backlog") n.backlog = e.pending_chunks;
      if (e.type === "text_source") n.textSource = { source: e.source, active: e.active };
      if (e.type === "report") void refresh();
      return { ...prev, [e.session_id]: n };
    });
  };

  async function refresh() {
    const a = apiRef.current;
    const next: Record<string, Card> = {};
    for (const s of (await db.listSessions()).slice(0, 20)) next[s.id] = await localCard(s);
    if (a) {
      try {
        for (const s of (await a.sessions()).filter((x) => x.kind === "chromium_tab").slice(0, 15)) {
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
    const loadPrefs = () => loadSettings().then((s) => {
      setPrefsState({ mode: s.defaultMode, silent: s.silentCapture });
      setProcessing(s.appConnection);
    });
    chrome.storage.local.get("theme").then((v) => v.theme && applyTheme(v.theme));
    void loadPrefs();
    chrome.storage.session.get(["warnings", "tabs"]).then((v) => {
      setWarnings((v.warnings as Warning[]) || []);
      setRecordingTabs((v.tabs as RecordingTabs) || {});
    });
    const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "session" && changes.warnings) setWarnings((changes.warnings.newValue as Warning[]) || []);
      if (area === "session" && changes.tabs) {
        setRecordingTabs((changes.tabs.newValue as RecordingTabs) || {});
        void refresh();
      }
      if (area === "session" && changes.pairing) connect(changes.pairing.newValue ?? null);
      if (area === "local" && changes.settings) {
        void loadPrefs();
        void chrome.runtime.sendMessage({ type: "service-health" }).then(setHealth);
      }
    };
    chrome.storage.onChanged.addListener(onStorage);
    const onMsg = (m: any) => {
      if (m?.type === "local-event") apply(m.event, m.event?.backend === "app" ? "app" : "local");
      if (m?.type === "capture-state") {
        const recordings = (m.recordings ?? []) as CaptureState[];
        setCaptures((prev) => Object.fromEntries(recordings.map((r) => {
          const p = prev[r.session_id];
          return [r.session_id, { ...r, wave: [...(p?.wave ?? []), ...r.peaks].slice(-LIVE_PEAK_WINDOW), peakCount: (p?.peakCount ?? 0) + r.peaks.length }];
        })));
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    void chrome.runtime.sendMessage({ type: "pairing" }).then((r) => connect(r?.pairing ?? null)).catch(() => connect(null));
    const check = () => chrome.runtime.sendMessage({ type: "service-health" }).then(setHealth).catch(() => {});
    void check();
    const timer = setInterval(check, 15000);
    return () => {
      mounted = false;
      clearInterval(timer);
      chrome.runtime.onMessage.removeListener(onMsg);
      chrome.storage.onChanged.removeListener(onStorage);
      esRef.current?.close();
    };
  }, []);

  const setPrefs = (patch: { mode?: SummaryMode; silent?: boolean }) => {
    setPrefsState((current) => ({ ...current, ...patch }));
    void loadSettings().then((s) => saveSettings({ ...s, ...(patch.mode ? { defaultMode: patch.mode } : {}), ...(patch.silent !== undefined ? { silentCapture: patch.silent } : {}) }));
  };

  async function control(sessionId: string, action: ControlAction, extra: object = {}) {
    try {
      const result = await chrome.runtime.sendMessage({ type: "recording-control", ...extra, sessionId, action });
      if (result?.error) throw new Error(result.error);
      if (action === "mode") {
        const mode = (extra as { mode: SummaryMode }).mode;
        setCards((p) => p[sessionId] ? { ...p, [sessionId]: { ...p[sessionId], session: { ...p[sessionId].session, summary_mode: mode } } } : p);
      }
      if (action === "rename") void refresh();
    } catch (error) {
      flash(tError(error));
    }
  }

  async function start(tab: chrome.tabs.Tab) {
    try {
      const result = await chrome.runtime.sendMessage({ type: "start-current", tabId: tab.id, mode: prefs.mode, muted: prefs.silent });
      if (result?.needsClick && tab.id !== undefined) setNeedsClick({ tabId: tab.id, pinned: !!result.pinned });
      else if (result?.error) flash(tError(result.error));
    } catch (error) {
      flash(tError(error));
    }
  }

  async function stop(sessionId: string) {
    const card = cards[sessionId];
    await chrome.runtime.sendMessage({ type: "stop", sessionId });
    const fallback = card ? recordingName(card.session) : programTitle(captures[sessionId]?.title ?? "");
    setNaming({ id: sessionId, value: fallback, fallback });
  }

  async function onMissed(c: Card) {
    try {
      if (c.backend === "app" && !api) throw new Error(t("Mac app offline"));
      const r = c.backend === "app" ? await api!.missed(c.session.id, 5) : await chrome.runtime.sendMessage({ type: "local-missed", sessionId: c.session.id, minutes: 5 });
      setMissed((p) => ({ ...p, [c.session.id]: r?.points?.length ? r.points.map((x: { text: string }) => x.text) : [t("Nothing new in the last 5 minutes.")] }));
    } catch (e) {
      flash(tError(e));
    }
  }

  async function onRetry(c: Card) {
    try {
      if (c.backend === "app") {
        if (!api) throw new Error(t("Mac app offline"));
        const r = await api.retryAsr(c.session.id);
        flash(r.queued ? t("Retrying {n} part(s)…", { n: r.queued }) : t("Nothing to retry."));
      } else {
        const r = await chrome.runtime.sendMessage({ type: "local-retry", sessionId: c.session.id });
        flash(r?.error ? t("Retry failed: {error}", { error: tError(r.error) }) : r?.remaining ? t("Service still unavailable — {n} part(s) waiting.", { n: r.remaining }) : r?.filled ? t("Filled in {n} part(s).", { n: r.filled }) : t("Nothing to retry."));
      }
    } catch (e) {
      flash(t("Retry failed: {error}", { error: tError(e) }));
    } finally {
      void refresh();
    }
  }

  async function stopAppRecording(w: Warning) {
    await api?.stop(w.session_id).catch(() => {});
    await chrome.storage.session.set({ warnings: warnings.filter((x) => x.session_id !== w.session_id) });
  }

  // Tab ↔ recording: from the worker's map, else from the capture's live reports.
  const tabRecording = (tabId?: number) => {
    if (tabId === undefined) return undefined;
    const entry = recordingTabs[String(tabId)];
    if (entry) return entry;
    const capture = Object.values(captures).find((c) => c.tab_id === tabId);
    return capture ? { sessionId: capture.session_id, backend: capture.backend } : undefined;
  };
  const current = tabRecording(active?.id);
  const currentCard = current ? cards[current.sessionId] : undefined;

  const list = Object.values(cards).sort((a, b) => b.session.started_at.localeCompare(a.session.started_at));
  const recent = list.filter((c) => !captures[c.session.id] && !ACTIVE_SESSION_STATUSES.includes(c.session.status) && c.session.audio_ms > 0);
  const others = Object.values(captures).filter((c) => c.session_id !== current?.sessionId);
  const recordingTabIds = new Set(Object.values(captures).map((c) => c.tab_id));
  const pageTabs = tabs.filter((tab) => recordable(tab) && tab.id !== active?.id && !recordingTabIds.has(tab.id!));
  const sounding = (tab: chrome.tabs.Tab) => !!tab.audible && !tab.mutedInfo?.muted;
  const playing = pageTabs.filter(sounding);
  const idle = pageTabs.filter((tab) => !sounding(tab));
  const tabFor = (id: number) => tabs.find((tab) => tab.id === id);

  const linked = processing !== "standalone" && !!api;
  const serviceChip = processing === "app" && !api
    ? <span className="chip warn" title={t("Recordings are processed by the Mac app")}><span className="dot" />{t("Mac app offline")}</span>
    : linked ? <span className="chip ok" title={t("Recordings are processed by the Mac app and stay in sync with it")}><span className="dot" />{t("Synced with Mac app")}</span>
    : health ? <span className={`chip ${health.ok ? "ok" : "warn"}`} title={health.detail}><span className="dot" />{t(SERVICE_LABEL[health.env])}{health.ok ? "" : ` · ${t("offline")}`}</span>
    : null;

  const tabRow = (tab: chrome.tabs.Tab, sound: boolean) => (
    <li key={tab.id} className={sound ? undefined : "audio-idle"}>
      <span className={`audio-dot ${sound ? "on" : ""}`} aria-hidden />
      <Favicon tab={tab} />
      <button className="tab-name" title={tab.title} onClick={() => void goToTab(tab)}>{programTitle(tab.title, siteOf(tab)) || tab.title}</button>
      <button className="btn btn-sm btn-ghost" onClick={() => void goToTab(tab)}>{t("Go to tab")}</button>
    </li>
  );

  return (
    <div className="panel">
      <style>{THEME_CSS + CARD_CSS + RECORDER_CSS + PANEL_CSS}</style>
      <header className="top">
        <div className="brand"><span className="logo" aria-hidden><Icon name="wave" /></span><h1>Multicorder</h1></div>
        {serviceChip}
        <span className="grow" />
        <a className="btn btn-ghost icon-btn" href="library.html" target="_blank" title={t("Library")} aria-label={t("Library")}><Icon name="library" /></a>
        <a className="btn btn-ghost icon-btn" href="options.html" target="_blank" title={t("Settings")} aria-label={t("Settings")}><Icon name="gear" /></a>
      </header>

      {health && !health.ok && !linked && (
        <div className="banner warn" role="status"><Icon name="warn" /><span className="grow">{t("{service} is unavailable ({detail}). Recording still works; text will be filled in when it is back.", { service: t(SERVICE_LABEL[health.env]), detail: health.detail })}</span></div>
      )}
      {warnings.map((w) => (
        <div className="banner warn" key={w.session_id} role="alert">
          <Icon name="warn" />
          <span className="grow">{t("The Mac app is also recording this whole browser, so this audio would be captured twice.")}</span>
          <button className="btn btn-sm" onClick={() => void stopAppRecording(w)}>{t("Stop app recording")}</button>
        </div>
      ))}

      <ThisTab
        key={active?.id ?? "none"}
        tab={active}
        card={currentCard}
        capture={current ? captures[current.sessionId] : undefined}
        sessionId={current?.sessionId}
        backend={current?.backend}
        prefs={prefs}
        setPrefs={setPrefs}
        missed={current ? missed[current.sessionId] : undefined}
        onStart={() => active ? start(active) : Promise.resolve()}
        onStop={() => current ? stop(current.sessionId) : Promise.resolve()}
        onCancel={async () => {
          if (!current) return;
          await control(current.sessionId, "cancel");
          flash(t("Recording discarded."));
          void refresh();
        }}
        control={(action, extra = {}) => {
          const target = (extra as { sessionId?: string }).sessionId ?? current?.sessionId;
          return target ? control(target, action, extra) : Promise.resolve();
        }}
        onMarker={current?.backend === "app" && api ? async () => { await api.marker(current.sessionId); } : undefined}
        onMissed={() => currentCard ? onMissed(currentCard) : Promise.resolve()}
        onRetry={() => currentCard ? onRetry(currentCard) : Promise.resolve()}
        naming={naming}
        setNaming={setNaming}
        needsClick={needsClick && needsClick.tabId === active?.id && !current ? needsClick : undefined}
      />

      {others.length > 0 && <section className="group">
        <h3>{t("Recording in other tabs")}<span className="count">{others.length}</span></h3>
        <ul className="rows">{others.map((c) => {
          const tab = tabFor(c.tab_id);
          return (
            <li key={c.session_id}>
              <Favicon tab={tab} />
              <button className="tab-name" title={c.title} onClick={() => tab && void goToTab(tab)}>{programTitle(c.title)}</button>
              <span className={`chip ${c.status === "capturing" ? "rec" : c.paused ? "warn" : "info"}`}>{c.status === "capturing" && <span className="dot" />}{c.paused ? t("Paused") : c.status === "waiting" ? t("Waiting") : fmtClock(c.elapsed_ms)}</span>
              <button className="btn btn-sm btn-ghost icon-btn" aria-label={c.paused ? t("Resume") : t("Pause")} title={c.paused ? t("Resume") : t("Pause")}
                onClick={() => void control(c.session_id, c.paused ? "resume" : "pause")}><Icon name={c.paused ? "play" : "pause"} size={13} /></button>
              <button className="btn btn-sm btn-ghost icon-btn stop-btn" aria-label={t("End & save")} title={t("End & save")} onClick={() => void stop(c.session_id)}><Icon name="stop" size={12} /></button>
            </li>
          );
        })}</ul>
      </section>}

      <section className="group">
        <h3>{t("Playing now")}{playing.length > 0 && <span className="count">{playing.length}</span>}</h3>
        {playing.length ? <ul className="rows">{playing.map((tab) => tabRow(tab, true))}</ul> : <p className="small muted empty-line">{t("No other tab is playing audio.")}</p>}
        {idle.length > 0 && <details className="more-tabs">
          <summary>{t("Other tabs")}<span className="count">{idle.length}</span></summary>
          <ul className="rows">{idle.map((tab) => tabRow(tab, false))}</ul>
        </details>}
      </section>

      <section className="group">
        <h3>{t("Recent")}<span className="grow" />{recent.length > 0 && <a className="small link" href="library.html" target="_blank">{t("Open library")}</a>}</h3>
        {recent.length ? <ul className="recent">{recent.slice(0, RECENT_LIMIT).map((c) => (
          <RecentRow key={c.session.id} card={c} api={api} flash={flash} rename={(name) => control(c.session.id, "rename", { name })} onDeleted={() => void refresh()}
            open={c.backend === "local" ? () => void chrome.tabs.create({ url: chrome.runtime.getURL(`library.html#${c.session.id}`) }) : undefined} />
        ))}</ul> : <div className="empty"><Icon name="wave" size={22} /><span className="small">{t("Recordings will appear here.")}</span></div>}
      </section>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

const PANEL_CSS = `
.panel{padding:12px 12px 20px;display:flex;flex-direction:column;gap:14px;min-height:100vh}
.top{display:flex;align-items:center;gap:6px;margin:-2px -4px 0 0}
.grow{flex:1}
.brand{display:flex;align-items:center;gap:8px}
.brand h1{font-size:14px;margin:0}
.logo{width:24px;height:24px;border-radius:7px;background:linear-gradient(135deg,#ff6b6f,var(--accent) 55%,#c4252b);color:#fff;display:grid;place-items:center;box-shadow:0 1px 2px rgba(229,72,77,.35),inset 0 1px 0 rgba(255,255,255,.25)}
.this-tab{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);padding:12px;display:grid;gap:10px}
.this-tab.is-live{border-color:color-mix(in srgb,var(--accent) 40%,var(--border))}
.this-tab p{margin:0}
.this-tab-head{display:flex;align-items:center;gap:6px;min-height:20px}
.this-tab-label{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3)}
.this-tab-title{display:flex;align-items:center;gap:10px;min-width:0}
.grow-min{flex:1;min-width:0;display:grid}
.grow-min strong{font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.this-tab .transport{padding:12px}
.this-tab .transport-main{gap:10px 16px}
.this-tab .transport-clock{min-width:0}
.this-tab .clock{font-size:26px}
.this-tab .level-meter{flex-basis:100%}
.this-tab .live-wave-canvas{height:44px}
.this-tab .transport-options select{width:auto}
.hint{color:var(--text-3)}
.click-callout{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:var(--radius-sm);background:var(--accent-weak);border:1px solid color-mix(in srgb,var(--accent) 35%,transparent);color:var(--accent-text)}
.click-callout strong{display:block;font-size:13px;margin-bottom:2px}
.click-callout p{color:var(--text-2)}
.click-callout-arrow{font-size:20px;line-height:1;font-weight:600;animation:nudge 1.2s ease-in-out infinite}
@keyframes nudge{0%,100%{transform:translate(0,0)}50%{transform:translate(3px,-3px)}}
@media (prefers-reduced-motion:reduce){.click-callout-arrow{animation:none}}
.captions{margin:0;color:var(--text-2);font-size:12.5px;background:var(--surface-2);border-radius:var(--radius-sm);padding:8px 10px;display:grid;gap:2px}
.captions p{margin:0}
.points{margin:0;padding:0 0 0 18px;font-size:12.5px;display:grid;gap:3px}
.points.missed li::marker{color:var(--info)}
.name-prompt{display:grid;gap:6px;padding:10px;border-radius:var(--radius-sm);background:var(--primary-weak)}
.name-prompt label{display:grid;gap:4px;color:var(--text-2)}
.name-prompt-actions{display:flex;justify-content:flex-end;gap:6px}
.group{display:grid;gap:4px}
.group>h3{margin:0 0 2px;padding:0 4px;display:flex;align-items:center;gap:6px}
.rows{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1px}
.rows li{display:flex;align-items:center;gap:8px;padding:4px 4px 4px 6px;border-radius:var(--radius-sm);min-height:34px}
.rows li:hover{background:var(--surface-2)}
.tab-fav{flex:none;border-radius:3px}
.tab-fav-generic{display:inline-grid;place-items:center;color:var(--text-3)}
.tab-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:none;border:0;padding:0;text-align:left;color:inherit;font:inherit;cursor:pointer}
.stop-btn svg{color:var(--accent)}
.empty-line{padding:2px 6px;margin:0}
.more-tabs{margin-top:4px}
.more-tabs>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:6px;padding:4px 6px;font-size:12px;color:var(--text-2);border-radius:var(--radius-sm)}
.more-tabs>summary::-webkit-details-marker{display:none}
.more-tabs>summary::before{content:"";width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform .15s;margin-right:2px}
.more-tabs[open]>summary::before{transform:rotate(45deg)}
.more-tabs>summary:hover{background:var(--surface-2)}
.recent{list-style:none;margin:0;padding:0;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--surface)}
.recent .clip-meta{font-size:12px}
.recent .saved-clip .audio-player{margin-left:0}
.recent .player-volume{width:64px}
.clip-name-link{background:none;border:0;padding:0;text-align:left;font:inherit;cursor:pointer}
.clip-name-link:disabled{cursor:default;color:var(--text)}
.clip-name-link:not(:disabled):hover{text-decoration:underline}
.link{color:var(--primary-text);text-decoration:none;font-weight:500;letter-spacing:0;text-transform:none}
.link:hover{text-decoration:underline}
.toast{position:fixed}
`;

devReloadPage();
createRoot(document.getElementById("root")!).render(<App />);
