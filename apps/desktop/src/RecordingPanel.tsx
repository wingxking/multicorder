import React, { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from "react";
import { CardState, describeDetail, fmtClock, fmtTs, Icon, LevelMeter, LIVE_PEAK_WINDOW, LiveWaveform, locale, programTitle, Session, SummaryMode, Switch, t, tError, TextSourceBadge, TransportButton, useConfirm, usePopover, WAITING_FOR_AUDIO } from "@multicorder/ui";
export { LIVE_PEAK_WINDOW, PEAKS_PER_SECOND } from "@multicorder/ui";
import type { Marker, PlayerHandle } from "@multicorder/ui/src/AudioPlayer";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
const AudioPlayer = lazy(() => import("@multicorder/ui/src/AudioPlayer"));
export type RecordingFormat = { sample_rate: number; bits_per_sample: number };
export const DEFAULT_RECORDING_FORMAT: RecordingFormat = { sample_rate: 16000, bits_per_sample: 16 };

type Part = "transcript" | "summary";
type TextPreview = Record<Part, string | null>;
export type LiveCard = Omit<CardState, "session"> & { status?: string; peaks?: number[]; peakCount?: number; elapsed?: number; textRevision?: number };

type IconName = Parameters<typeof Icon>[0]["name"];
const iconUrls = new Map<string, Promise<string | null>>();

/** The app's own icon (from its bundle), or a generic one while it loads or if there is none. */
export function AppIcon({ path, invoke, fallback, size = 18 }: { path?: string | null; invoke: Invoke; fallback: IconName; size?: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!path || !("__TAURI_INTERNALS__" in window)) return;
    let current = true;
    if (!iconUrls.has(path)) {
      iconUrls.set(path, invoke<ArrayBuffer>("app_icon", { bundlePath: path })
        .then((bytes) => URL.createObjectURL(new Blob([bytes], { type: "image/png" })))
        .catch(() => null));
    }
    void iconUrls.get(path)!.then((value) => { if (current) setUrl(value); });
    return () => { current = false; };
  }, [path, invoke]);
  return url ? <img className="app-icon" src={url} width={size} height={size} alt="" draggable={false} />
    : <span className="app-icon app-icon-generic" style={{ width: size, height: size }} aria-hidden><Icon name={fallback} size={Math.round(size * 0.72)} /></span>;
}

/** The source a recording came from: a tab's video or page title, else the app or microphone. */
export const sourceTitle = (session: Session) => session.kind === "chromium_tab" ? programTitle(session.title) : session.title;
/** What a recording is called: its own name, else its source's title. */
export const recordingName = (session: Session) => session.name?.trim() || sourceTitle(session);
export const iconFallback = (kind: Session["kind"]): IconName => kind === "mic" ? "mic" : kind === "chromium_tab" ? "tab" : "app";

/** Inline rename: the name as a button-like label with a pencil; Enter saves, Escape cancels. */
function ClipName({ clip, invoke, flash, onRenamed }: { clip: Session; invoke: Invoke; flash: (text: string) => void; onRenamed?: () => void }) {
  const name = recordingName(clip);
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (draft !== null) input.current?.select(); }, [draft !== null]);
  async function save() {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    if (next === name) return;
    try {
      // Clearing the name, or typing the source's own title, goes back to the default.
      await invoke("rename_session", { id: clip.id, name: next && next !== sourceTitle(clip) ? next : null });
      onRenamed?.();
    } catch (error) {
      flash(tError(error));
    }
  }
  if (draft !== null) {
    return <input ref={input} className="input input-sm clip-name-input" value={draft} aria-label={t("Recording name")} placeholder={sourceTitle(clip)}
      onChange={(event) => setDraft(event.target.value)} onBlur={() => void save()}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); void save(); }
        if (event.key === "Escape") { event.preventDefault(); setDraft(null); }
      }} />;
  }
  return (
    <span className="clip-name">
      <span className="clip-name-text" title={name}>{name}</span>
      {clip.name_auto && <span className="clip-name-ai" title={t("Named by AI")}><Icon name="sparkle" size={11} /></span>}
      <button className="clip-rename" aria-label={t("Rename {name}", { name })} title={t("Rename")} onClick={() => setDraft(name)}><Icon name="edit" size={12} /></button>
    </span>
  );
}

const fmtFormat = (rate?: number, bits?: number) => `${(rate ?? 16000) / 1000} kHz · ${bits ?? 16}-bit`;
/** Bytes per second of a mono PCM recording. */
const byteRate = (format: RecordingFormat) => format.sample_rate * (format.bits_per_sample / 8);
const fmtMegabytes = (bytes: number) => {
  const mb = bytes / 1e6;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
};

type TextFormat = "pdf" | "docx" | "txt" | "md";
const TEXT_FORMATS: { format: TextFormat; label: string }[] = [
  { format: "pdf", label: "PDF" },
  { format: "docx", label: "Word (DOCX)" },
  { format: "txt", label: "TXT" },
  { format: "md", label: "Markdown (MD)" },
];

function ClipMenu({ parts, onCopy, onExport }: { parts: { part: Part; label: string }[]; onCopy: (part: Part) => void; onExport: (part: Part, format: TextFormat) => void }) {
  const { open, setOpen, root } = usePopover();
  const [picking, setPicking] = useState<Part | null>(null);
  const menuId = useId();
  useEffect(() => { if (!open) setPicking(null); }, [open]);
  useEffect(() => { if (picking) root.current?.querySelector<HTMLButtonElement>("[role=menu] button")?.focus(); }, [picking, root]);
  const choose = (work: () => void) => () => { setOpen(false); work(); };
  const picked = parts.find(({ part }) => part === picking);
  return (
    <div className="popover-anchor" ref={root}>
      <button className="btn btn-sm btn-ghost icon-btn" aria-label={t("More actions")} title={t("More actions")} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen(!open)}>
        <Icon name="more" size={14} />
      </button>
      {open && <div className="popover menu" role="menu" id={menuId} aria-label={picked ? t("Download {label} as", { label: picked.label }) : undefined}>
        {picked ? <>
          <button role="menuitem" onClick={() => setPicking(null)}><Icon name="back" size={13} />{t("Download {label} as", { label: picked.label })}</button>
          <hr />
          {TEXT_FORMATS.map(({ format, label }) => (
            <button role="menuitem" key={format} onClick={choose(() => onExport(picked.part, format))}><Icon name="download" size={13} />{label}</button>
          ))}
        </> : parts.map(({ part, label }, index) => (
          <React.Fragment key={part}>
            {index > 0 && <hr />}
            <button role="menuitem" onClick={choose(() => onCopy(part))}><Icon name="copy" size={13} />{t("Copy {label}", { label })}</button>
            <button role="menuitem" aria-haspopup="menu" onClick={() => setPicking(part)}><Icon name="download" size={13} />{t("Download {label}…", { label })}</button>
          </React.Fragment>
        ))}
      </div>}
    </div>
  );
}

/** One "Download" button that lists the formats to save as; the caller shows the save panel. */
export function DownloadMenu({ options, onPick }: { options: { key: string; label: string }[]; onPick: (key: string) => void }) {
  const { open, setOpen, root } = usePopover();
  const menuId = useId();
  return (
    <div className="popover-anchor" ref={root}>
      <button className="btn btn-sm" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen(!open)}>
        <Icon name="download" size={13} />{t("Download…")}
      </button>
      {open && <div className="popover menu menu-start" role="menu" id={menuId} aria-label={t("Download as")}>
        {options.map(({ key, label }) => (
          <button role="menuitem" key={key} onClick={() => { setOpen(false); onPick(key); }}>{label}</button>
        ))}
      </div>}
    </div>
  );
}

export function SavedClip({ clip, revision, invoke, flash, showSource, iconPath, onDetails, onRenamed, onDeleted }: { clip: Session; revision?: number; invoke: Invoke; flash: (text: string) => void; showSource?: boolean; iconPath?: string | null; onDetails?: () => void; onRenamed?: () => void; onDeleted?: () => void }) {
  const name = recordingName(clip);
  const [confirmDialog, confirm] = useConfirm();
  const [preview, setPreview] = useState<TextPreview | null>(null);
  const [busy, setBusy] = useState<Part | "audio" | null>(null);
  const [audio, setAudio] = useState<{ blob: Blob; markers: Marker[]; autoPlay: boolean } | null>(null);
  const [editing, setEditing] = useState(false);
  const [playing, setPlaying] = useState(false);
  const player = useRef<PlayerHandle>(null);
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
      flash(tError(error));
    }
  }

  async function openPlayer(autoPlay: boolean) {
    setBusy("audio");
    try {
      const [bytes, markers] = await Promise.all([
        invoke<ArrayBuffer>("load_recording_audio", { id: clip.id }),
        invoke<Marker[]>("recording_markers", { id: clip.id }).catch(() => []),
      ]);
      setAudio({ blob: new Blob([bytes], { type: "audio/wav" }), markers: markers ?? [], autoPlay });
    } catch (error) {
      setEditing(false);
      flash(tError(error));
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
      flash(tError(error));
    } finally {
      setBusy(null);
    }
  }

  async function exportText(part: Part, format: TextFormat) {
    try {
      const fileName = `${name || "Multicorder"} - ${label(part)}`;
      const path = await invoke<string | null>("export_recording_text", { id: clip.id, part, format, name: fileName, title: t("Save {label}", { label: label(part) }) });
      if (path) flash(t("Saved {path}", { path }));
    } catch (error) {
      flash(tError(error));
    }
  }

  async function saveWav() {
    try {
      const path = await invoke<string | null>("export_audio", { id: clip.id, name, title: t("Save audio") });
      if (path) flash(t("Saved {path}", { path }));
    } catch (error) {
      flash(tError(error));
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
      await invoke("delete_session", { id: clip.id });
      flash(t("Recording deleted."));
      onDeleted?.();
    } catch (error) {
      flash(tError(error));
    }
  }

  const label = (part: Part) => (part === "transcript" ? t("Transcript") : t("AI summary"));
  const parts: Part[] = ["transcript", "summary"];
  const present = preview ? parts.filter((part) => preview[part]) : [];
  const missing = preview ? parts.filter((part) => !preview[part]) : [];
  const missingText = missing.length === 2 ? t("No transcript or summary yet.")
    : missing[0] === "transcript" ? t("No transcript yet.") : t("No AI summary yet.");
  const date = new Date(clip.started_at).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" });

  return (
    <li className={`saved-clip${audio ? " is-open" : ""}`}>
      {confirmDialog}
      <div className="clip-row">
        <span className="clip-icon"><AppIcon path={iconPath} invoke={invoke} fallback={iconFallback(clip.kind)} size={22} /></span>
        <div className="clip-meta">
          <ClipName clip={clip} invoke={invoke} flash={flash} onRenamed={onRenamed} />
          {showSource && clip.name?.trim() && <span className="clip-source">{sourceTitle(clip)}</span>}
          <span className="clip-date">{date}</span>
          <span className="ts">{fmtTs(clip.audio_ms)}</span>
          <span className="clip-format">{fmtFormat(clip.sample_rate, clip.bits_per_sample)}</span>
          {processing && <span className="chip info">{t("Processing")}</span>}
        </div>
        <div className="clip-buttons">
          <button className={`clip-play${playing ? " is-playing" : ""}`} disabled={saving || busy === "audio"}
            aria-label={playing ? t("Pause") : t("Play {name}", { name })} title={playing ? t("Pause") : t("Play")}
            onClick={() => audio ? player.current?.toggle() : void openPlayer(true)}>
            {busy === "audio" ? <span className="spinner" aria-hidden /> : <Icon name={playing ? "pause" : "play"} size={14} />}
          </button>
          {onDetails && <button className="btn btn-sm btn-ghost" onClick={onDetails}>{t("Details")}</button>}
          <button className={`btn btn-sm btn-ghost icon-btn${editing ? " is-pressed" : ""}`} disabled={busy === "audio" || saving} aria-pressed={editing}
            aria-label={t("Edit audio")} title={t("Edit audio")} onClick={() => {
              setEditing(!editing);
              if (!audio && !editing) void openPlayer(false);
            }}><Icon name="scissors" size={14} /></button>
          <button className="btn btn-sm btn-ghost icon-btn" disabled={saving} aria-label={t("Download WAV")} title={t("Download WAV")}
            onClick={() => void saveWav()}><Icon name="download" size={14} /></button>
          {present.length > 0 && <ClipMenu parts={present.map((part) => ({ part, label: label(part) }))}
            onCopy={(part) => void run("copy_recording_text", { part }, t("Copied."))} onExport={(part, format) => void exportText(part, format)} />}
          {onDeleted && <button className="btn btn-sm btn-ghost icon-btn clip-delete" disabled={saving || processing} aria-label={t("Delete {name}", { name })} title={t("Delete")}
            onClick={() => void remove()}><Icon name="trash" size={14} /></button>}
          {audio && <button className="btn btn-sm btn-ghost icon-btn" aria-label={t("Close player")} title={t("Close player")} onClick={() => {
            setAudio(null);
            setEditing(false);
          }}><Icon name="close" size={13} /></button>}
        </div>
      </div>
      {audio && <Suspense fallback={<p className="small muted">{t("Loading waveform…")}</p>}>
        <AudioPlayer ref={player} audio={audio.blob} markers={audio.markers} editing={editing} autoPlay={audio.autoPlay} onPlayingChange={setPlaying} onError={flash}
          onExport={async (startMs, endMs) => {
            const path = await invoke<string | null>("export_recording_selection", { id: clip.id, startMs, endMs, name, title: t("Save selection") });
            if (path) flash(t("Saved {path}", { path }));
          }} />
      </Suspense>}
      {present.length > 0 && <div className="clip-texts">
        {present.map((part) => (
          <section className="recording-text" key={part} aria-label={label(part)}>
            <h4><Icon name={part === "transcript" ? "text" : "sparkle"} size={12} />{label(part)}</h4>
            <p className="clip-excerpt">{preview![part]}</p>
          </section>
        ))}
      </div>}
      {missing.length > 0 && <div className="clip-missing">
        <span className="clip-missing-text"><Icon name={missing.length === 2 ? "text" : missing[0] === "transcript" ? "text" : "sparkle"} size={12} />{missingText}</span>
        {missing.map((part) => (
          <button key={part} className="btn btn-sm" disabled={busy !== null || saving || processing} onClick={() => void generate(part)}>
            {busy === part ? t("Generating…") : part === "transcript" ? t("Generate transcript") : t("Generate summary")}
          </button>
        ))}
      </div>}
    </li>
  );
}

function PausedPlayback({ id, invoke, onError }: { id: string; invoke: Invoke; onError: (message: string) => void }) {
  const [audio, setAudio] = useState<Blob>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let current = true;
    void invoke<ArrayBuffer>("load_paused_audio", { id }).then((bytes) => {
      if (current) setAudio(new Blob([bytes], { type: "audio/wav" }));
    }).catch((failure) => { if (current) setError(tError(failure)); });
    return () => { current = false; };
  }, [id, invoke]);
  return (
    <section className="pause-review" aria-label={t("Review paused recording")}>
      <strong className="small">{t("Review paused recording")}</strong>
      {audio ? <Suspense fallback={<p className="small muted">{t("Loading recording…")}</p>}>
        <AudioPlayer audio={audio} markers={[]} editing={false} onError={onError} onExport={async () => {}} />
      </Suspense> : <p className="small muted" role="status">{error || t("Loading recording…")}</p>}
    </section>
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

const SAMPLE_RATES = [16000, 24000, 32000, 44100, 48000];

function FormatPicker({ format, setFormat, disabled }: { format: RecordingFormat; setFormat: (format: RecordingFormat) => void; disabled: boolean }) {
  const { open, setOpen, root } = usePopover();
  const popoverId = useId();
  return (
    <div className="popover-anchor" ref={root}>
      <button className="btn btn-sm" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popoverId : undefined}
        aria-label={t("Recording format: {format}", { format: `${fmtFormat(format.sample_rate, format.bits_per_sample)} · ${t("Mono")}` })} onClick={() => setOpen(!open)}>
        <Icon name="sliders" size={13} />{fmtFormat(format.sample_rate, format.bits_per_sample)} · {t("Mono")}<span className="chevron" aria-hidden><Icon name="back" size={10} /></span>
      </button>
      {open && <div className="popover format-popover" role="dialog" id={popoverId} aria-label={t("Recording format")}>
        <label><span>{t("Sample rate")}</span><select className="input" value={format.sample_rate} onChange={(e) => setFormat({ ...format, sample_rate: Number(e.target.value) })}>
          {SAMPLE_RATES.map((rate) => <option key={rate} value={rate}>{rate / 1000} kHz</option>)}
        </select></label>
        <label><span>{t("Audio quality")}</span><select className="input" value={format.bits_per_sample} onChange={(e) => setFormat({ ...format, bits_per_sample: Number(e.target.value) })}>
          <option value={16}>16-bit PCM</option><option value={24}>24-bit PCM</option>
        </select></label>
        <p className="small muted">{t("About {size} per minute. Applies to new recordings from this source.", { size: fmtMegabytes(byteRate(format) * 60) })}</p>
      </div>}
    </div>
  );
}

export function RecordingPanel({ title, iconPath, mutePlayback, setMutePlayback, sessionMuted, remote, originalName, kind, session, card, clips, cards, canStart, standaloneRecording, willWait, lastFailure, format, setFormat, invoke, flash, onStart, onStop, refresh }: {
  title: string;
  iconPath?: string | null;
  mutePlayback: boolean;
  /** Whether the running recording is silenced on the speakers (reported by its capture). */
  sessionMuted?: boolean;
  /** The recording is processed in Chrome: markers and catch-up are only available there. */
  remote?: boolean;
  /** Absent for microphones, which have no playback to mute. */
  setMutePlayback?: (value: boolean) => void;
  originalName?: string;
  kind: Session["kind"];
  format: RecordingFormat;
  setFormat: (format: RecordingFormat) => void;
  session?: Session;
  card?: LiveCard;
  clips: Session[];
  cards: Record<string, LiveCard>;
  canStart: boolean;
  standaloneRecording: boolean;
  willWait: boolean;
  lastFailure?: string | null;
  invoke: Invoke;
  flash: (text: string) => void;
  onStart: () => Promise<void>;
  onStop: (id: string) => Promise<void>;
  refresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(5);
  const [missed, setMissed] = useState<string[]>([]);
  const [markers, setMarkers] = useState<number[]>([]);
  // Optimistic until the next report from the capture confirms it.
  const [mutedOverride, setMutedOverride] = useState<{ id: string; muted: boolean } | null>(null);
  const headingId = useId();
  const phase = card?.status ?? session?.status;
  const paused = phase === "paused";
  const waiting = phase === "waiting";
  const finishing = phase === "stopping" || phase === "stopped" || phase === "failed";
  const live = !!session && !paused && !waiting && !finishing;
  const note = describeDetail(card?.detail);
  const elapsed = card?.elapsed ?? session?.audio_ms ?? 0;
  const peaks = card?.peaks ?? [];
  const peakCount = card?.peakCount ?? peaks.length;
  const activeFormat: RecordingFormat = session
    ? { sample_rate: session.sample_rate ?? 16000, bits_per_sample: session.bits_per_sample ?? 16 }
    : kind === "chromium_tab" ? DEFAULT_RECORDING_FORMAT : format;
  const canRecordHere = !session && canStart;

  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    try {
      await work();
      refresh();
    } catch (error) {
      flash(tError(error));
    } finally {
      setBusy(false);
    }
  }
  const changeMode = (mode: SummaryMode) => session && action(() => invoke("set_mode", { id: session.id, mode }));
  const loadMarkers = useCallback(async (id: string) => {
    const list = await invoke<Marker[]>("recording_markers", { id }).catch(() => null);
    setMarkers((list ?? []).map((marker) => marker.at_ms));
  }, [invoke]);
  useEffect(() => {
    setMarkers([]);
    if (session?.id) void loadMarkers(session.id);
  }, [session?.id, loadMarkers]);

  const [confirmDialog, confirm] = useConfirm();
  const cancelRecording = async () => {
    if (!session) return;
    const ok = await confirm({
      title: t("Cancel this recording?"),
      message: t("Recording stops and everything captured so far ({time}) is thrown away. Nothing is saved, and this can't be undone.", { time: fmtClock(elapsed) }),
      confirmLabel: t("Discard recording"),
      cancelLabel: t("Keep recording"),
    });
    if (ok) await action(async () => {
      await invoke("cancel_session", { id: session.id });
      flash(t("Recording discarded."));
    });
  };
  const start = () => action(onStart);
  const togglePause = () => session && action(() => invoke("pause_session", { id: session.id, paused: !paused }));
  const addMarker = () => session && action(async () => {
    await invoke("add_marker", { id: session.id });
    setMarkers((current) => [...current, elapsed]);
    void loadMarkers(session.id);
  });
  const canPause = !!session && !busy && !finishing && phase !== "starting";
  const liveMuted = session ? (mutedOverride?.id === session.id ? mutedOverride.muted : sessionMuted ?? session.muted ?? mutePlayback) : mutePlayback;
  useEffect(() => { setMutedOverride(null); }, [sessionMuted, session?.id]);
  const changeMuted = async (muted: boolean) => {
    if (!session) {
      setMutePlayback?.(muted);
      return;
    }
    setMutedOverride({ id: session.id, muted });
    try {
      await invoke("set_session_muted", { id: session.id, muted });
    } catch (error) {
      setMutedOverride(null);
      flash(tError(error));
    }
  };

  // Space starts a recording, or pauses and resumes one; M adds a marker. Ignored while typing,
  // on a focused control (which Space would press) and inside a player (Space plays there).
  const keys = useRef({ start, togglePause, addMarker, canStart: canRecordHere && !busy, canPause, live, remote });
  keys.current = { start, togglePause, addMarker, canStart: canRecordHere && !busy, canPause, live, remote };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement;
      if (target.closest("input, select, textarea, button, a, [contenteditable], dialog, [role=menu], .audio-player")) return;
      const k = keys.current;
      if (event.key === " ") {
        if (k.canStart) { event.preventDefault(); void k.start(); }
        else if (k.canPause) { event.preventDefault(); void k.togglePause(); }
      } else if ((event.key === "m" || event.key === "M") && k.live && !k.remote) {
        event.preventDefault();
        void k.addMarker();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const sizeText = session
    ? `${fmtMegabytes(byteRate(activeFormat) * (elapsed / 1000))}`
    : t("~{size}/min", { size: fmtMegabytes(byteRate(activeFormat) * 60) });
  const shortcuts = session ? !finishing : canRecordHere;

  return (
    <article className={`source-panel${live ? " is-live" : ""}`} aria-labelledby={headingId}>
      {confirmDialog}
      <header className="source-panel-head">
        <span className="source-panel-icon"><AppIcon path={iconPath} invoke={invoke} fallback={kind === "mic" ? "mic" : kind === "chromium_tab" ? "tab" : "app"} size={26} /></span>
        <div className="source-panel-title">
          <h2 id={headingId}>{title}</h2>
          {originalName && <div className="source-original-name">{originalName}</div>}
        </div>
        <span className={`chip ${phase === "capturing" ? "rec" : session && paused ? "warn" : session ? "info" : canStart ? "ok" : ""}`}>
          {phase === "capturing" && <span className="dot" />}
          {standaloneRecording && !session ? t("Recording in browser") : phaseLabel(phase, !!session, canStart, kind)}
        </span>
      </header>
      {!session && kind === "chromium_tab" && !canStart ? (
        <p className="transport transport-note small muted">{t(standaloneRecording ? "Manage this recording in the browser extension." : "Start this source from the Multicorder extension in Chrome.")}</p>
      ) : <section className="transport" aria-label={t("Recorder")}>
        <div className="transport-main">
          <div className="transport-buttons">
            {!session ? (
              <TransportButton key="record" variant="record" label={kind === "chromium_tab" ? t("Record tab") : t("Record")} disabled={!canStart || busy}
                title={willWait ? t(WAITING_FOR_AUDIO) : t("Start recording")} onClick={() => void start()} />
            ) : (
              <>
                <TransportButton key="pause" variant={paused ? "resume" : "pause"} label={paused ? t("Resume") : t("Pause")} disabled={!canPause} onClick={() => void togglePause()} />
                {!remote && <TransportButton variant="plain" icon="flag" label={t("Marker")} title={t("Add marker")} disabled={busy || !live} onClick={() => void addMarker()} />}
                {!remote && card?.lines.length ? <TransportButton variant="plain" icon="clock" label={t("Catch up")} title={t("What did I miss?")} disabled={busy} onClick={() => void action(async () => {
                  const result = await invoke<{ points: { text: string }[] }>("missed", { id: session.id, minutes: 5 });
                  setMissed(result?.points.map((point) => point.text) ?? []);
                })} /> : null}
                <div className="transport-end">
                  <TransportButton variant="plain" icon="close" label={t("Discard")} title={t("Cancel this recording without saving it")}
                    disabled={busy || finishing} onClick={() => void cancelRecording()} />
                  <TransportButton key="stop" variant="stop" label={t("End & save")} title={t("End the recording and save it")} confirmLabel={t("Click again to end")}
                    disabled={busy || finishing} onClick={() => void action(() => onStop(session.id))} />
                </div>
              </>
            )}
          </div>
          <div className="transport-clock" role="timer" aria-label={t("Recorded time {time}", { time: fmtClock(elapsed) })}>
            <span className={`clock${live ? " is-live" : paused ? " is-paused" : ""}`}>{fmtClock(elapsed)}</span>
            <span className="clock-sub">{fmtFormat(activeFormat.sample_rate, activeFormat.bits_per_sample)} · {t("Mono")} · {sizeText}</span>
            <TextSourceBadge state={card?.textSource} recording={!!session && kind === "chromium_tab"} />
          </div>
          <LevelMeter peaks={peaks} peakCount={peakCount} active={live} />
        </div>
        <LiveWaveform peaks={peaks} peakCount={peakCount} elapsed={elapsed} live={live} paused={paused} markers={markers} />
        <div className="transport-options">
          {session ? (
            <select className="input input-sm" aria-label={t("Summary mode")} disabled={finishing} value={session.summary_mode} onChange={(e) => void changeMode(e.target.value as SummaryMode)}>
              <option value="live">{t("Live summary")}</option>
              <option value="after">{t("Summary at end")}</option>
              <option value="off">{t("Audio only")}</option>
            </select>
          ) : kind !== "chromium_tab" && <FormatPicker format={format} setFormat={setFormat} disabled={busy} />}
          {kind !== "mic" && (session ? !finishing : !!setMutePlayback && (canStart || kind !== "chromium_tab")) && (
            <Switch checked={liveMuted} onChange={(value) => void changeMuted(value)} label={t("Record silently")}
              title={session ? t("Stops or resumes playing this source through your speakers. The recording continues either way.")
                : t("Records the audio without playing it through your speakers or headphones. Applies to every new recording.")} />
          )}
          <span className="grow" />
          {shortcuts && <span className="transport-keys">
            <kbd>Space</kbd>{session ? t("Pause / resume") : t("Record")}
            {live && !remote && <><kbd>M</kbd>{t("Marker")}</>}
          </span>}
        </div>
      </section>}
      {session && paused && <PausedPlayback key={session.id} id={session.id} invoke={invoke} onError={flash} />}
      {waiting && <p className="small muted" role="status">{t(WAITING_FOR_AUDIO)}</p>}
      {!session && lastFailure === "no_audio" && <p className="small muted" role="status">{t("No sound was detected, so no audio was saved.")}</p>}
      {!session && lastFailure?.startsWith("capture_failed: ") && <p className="banner warn" role="status">{lastFailure.slice("capture_failed: ".length)}</p>}
      {note && <p className="small muted" role="status">{note}</p>}
      {session && !!card?.lines.length && <div className="panel-captions" aria-live="polite">{card.lines.slice(-2).map((line) => <p key={line.id}><span className="ts">{fmtTs(line.start_ms)}</span> {line.text}</p>)}</div>}
      {session && !!card?.insights.length && <ul className="panel-points" aria-label={t("Key points")}>{card.insights.slice(-3).map((point) => <li key={point.key}>{point.text}</li>)}</ul>}
      {session && missed.length > 0 && <ul className="panel-points missed" aria-label={t("What you missed")}>{missed.map((point, index) => <li key={index}>{point}</li>)}</ul>}
      <section className="source-clips">
        <h3>{t("Recordings")}{clips.length > 0 && <span className="count">{clips.length}</span>}</h3>
        {clips.length ? (
          <ul>{clips.slice(0, visible).map((clip) => (
            <SavedClip key={clip.id} clip={clip} showSource={kind === "mac_app" && clip.kind === "chromium_tab"} iconPath={iconPath} revision={cards[clip.id]?.textRevision} invoke={invoke} flash={flash} onRenamed={refresh} onDeleted={refresh} />
          ))}</ul>
        ) : <p className="small muted">{t("Recordings from this source are saved locally.")}</p>}
        {visible < clips.length && <button className="btn btn-sm" onClick={() => setVisible((count) => count + 5)}>{t("Show more recordings")}</button>}
      </section>
    </article>
  );
}

export const RECORDING_CSS = `
.source-panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);padding:18px;display:grid;gap:14px}
.source-panel-head{display:flex;align-items:center;gap:12px}
.source-panel-icon{width:38px;height:38px;flex:none;display:grid;place-items:center;border-radius:10px;background:var(--surface-2);color:var(--text-2)}
.app-icon{flex:none;display:inline-grid;place-items:center;object-fit:contain}
.app-icon-generic{color:var(--text-3)}
.source-panel-icon .app-icon-generic{color:inherit}
.is-live .source-panel-icon{background:var(--accent-weak);color:var(--accent-text)}
.source-panel-title{min-width:0;flex:1}.source-panel-title h2{margin:0;font-size:17px;overflow-wrap:anywhere}
.source-panel .grow{flex:1}
.source-panel p{margin:0}


.format-popover{display:grid;gap:10px;padding:12px;width:250px}
.format-popover label{display:grid;grid-template-columns:90px 1fr;align-items:center;gap:8px;font-size:12px;color:var(--text-2)}

.pause-review{display:grid;gap:8px;padding:10px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--surface-2)}
.panel-captions{margin:0;color:var(--text-2);font-size:12.5px;background:var(--surface-2);border-radius:var(--radius-sm);padding:8px 10px;display:grid;gap:2px}
.panel-points{margin:0;padding:0 0 0 18px;color:var(--text);font-size:12.5px;display:grid;gap:3px}
.panel-points.missed li::marker{color:var(--info)}

.source-clips{border-top:1px solid var(--border);padding-top:12px}
.source-clips h3{margin:0 0 8px;display:flex;align-items:center;gap:6px}
.source-clips>ul{list-style:none;margin:0 0 10px;padding:0;border:1px solid var(--border);border-radius:var(--radius-md);overflow:visible}
@media (hover:none){.clip-rename{opacity:1}}

@media (max-width:560px){.clip-texts,.clip-missing{padding-left:0}.saved-clip .audio-player{margin-left:0}}
`;
