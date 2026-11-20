// Library of in-browser recordings: list with search on the left, detail on the right (key points
// with evidence that jump into the audio, transcript, report), exports, retry and audio download.

import { devReloadPage } from "./dev-reload";
import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { applyTheme, captionFromEngine, captionLabel, Icon, LangToggle, locale, t, tError, THEME_CSS, ThemeToggle, useConfirm, useLang } from "@multicorder/ui";
import * as db from "./local/db";
import { fmtTs, Insight, Seg } from "./local/insight";

function download(name: string, body: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const cue = (ms: number, sep: string) => {
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, r = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${sep}${String(r).padStart(3, "0")}`;
};

export function toSrt(segs: Seg[]): string {
  return segs.map((e, i) => `${i + 1}\n${cue(e.startMs, ",")} --> ${cue(e.endMs, ",")}\n${e.text}\n`).join("\n");
}

function statusChip(s: db.LocalSession) {
  if (s.status === "waiting") return <span className="chip info">{t("Waiting for audio")}</span>;
  if (["capturing", "starting"].includes(s.status)) return <span className="chip rec"><span className="dot" />{t("Recording")}</span>;
  if (s.status === "stopping") return <span className="chip info">{t("Finishing")}</span>;
  if (s.asr?.failed_chunks) return <span className="chip warn">{t("Text missing")}</span>;
  return <span className="chip">{s.failure === "no_audio" ? t("No audio") : t("Done")}</span>;
}

function Detail({ s, onChanged, onDelete, onAsr }: { s: db.LocalSession; onChanged: () => void; onDelete: (s: db.LocalSession) => void; onAsr: (s: db.LocalSession) => Promise<void> }) {
  const [segs, setSegs] = useState<Seg[]>([]);
  const [ins, setIns] = useState<Insight[]>([]);
  const [report, setReport] = useState<db.LocalReport | undefined>();
  const [focus, setFocus] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => {
    db.transcript(s.id).then(setSegs).catch(console.error);
    db.insights(s.id).then(setIns).catch(console.error);
    db.getReport(s.id).then(setReport).catch(console.error);
  };
  useEffect(() => {
    let url: string | null = null;
    let current = true;
    load();
    setMsg(null);
    db.recordingFile(s.id).then((f) => {
      if (!current) return;
      url = f && f.size ? URL.createObjectURL(f) : null;
      setAudioUrl(url);
    }).catch(console.error);
    return () => {
      current = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [s.id]);
  const caption = captionFromEngine(segs.find((e) => e.engine?.startsWith("caption:"))?.engine);
  const md = useMemo(() => (report?.body ?? `# ${s.title}\n\n`) + "\n---\n\n## Transcript\n\n" + segs.map((e) => `\`[${fmtTs(e.startMs)}]\` ${e.text}`).join("\n\n"), [report, segs, s.title]);
  const jump = (ms: number, id: string) => {
    setFocus(id);
    document.getElementById(id)?.scrollIntoView({ block: "center", behavior: "smooth" });
    const a = document.querySelector("audio");
    if (a) {
      a.currentTime = ms / 1000;
      void a.play();
    }
  };
  async function retry() {
    setBusy(true);
    const r = await chrome.runtime.sendMessage({ type: "local-retry", sessionId: s.id }).catch((e) => ({ error: tError(e) }));
    setBusy(false);
    setMsg(r?.error ? t("Retry failed: {error}", { error: tError(r.error) }) : r?.remaining ? t("Service still unavailable — {n} part(s) waiting.", { n: r.remaining }) : r?.filled ? t("Filled in {n} part(s).", { n: r.filled }) : t("Nothing to retry."));
    load();
    onChanged();
  }
  const missing = s.asr?.failed_chunks ?? 0;
  return (
    <article className="detail">
      <header className="dhead">
        <div>
          <h2>{s.title}</h2>
          <p className="muted small">{new Date(s.started_at).toLocaleString(locale())} · {fmtTs(s.audio_ms)} · {s.summary_mode === "live" ? t("Live summary") : s.summary_mode === "after" ? t("Summary at end") : t("Record only")}{s.url ? <> · <a href={s.url} target="_blank" rel="noreferrer">{t("source")}</a></> : null}</p>
        </div>
        {statusChip(s)}
      </header>
      {missing > 0 && (
        <div className="banner warn"><Icon name="warn" /><span className="grow">{t("{n} part(s) of this recording are not transcribed yet ({error}). The audio is saved; text fills in automatically when the service is back.", { n: missing, error: s.last_error ? tError(s.last_error) : t("service unavailable") })}</span><button className="btn btn-sm" disabled={busy} onClick={() => void retry()}><Icon name="retry" size={13} />{busy ? t("Retrying…") : t("Retry now")}</button></div>
      )}
      {msg && <p className="small muted" role="status">{msg}</p>}
      {audioUrl ? <audio controls src={audioUrl} /> : <p className="muted small">{s.status === "waiting" ? t("Recording starts when this tab plays sound.") : s.failure === "no_audio" ? t("No sound was detected, so no audio was saved.") : t("Audio is being written…")}</p>}
      <div className="toolbar">
        <button className="btn" onClick={() => download(`multicorder-${s.id}.md`, md, "text/markdown")}><Icon name="download" size={13} />Markdown</button>
        <button className="btn" onClick={() => download(`multicorder-${s.id}.srt`, toSrt(segs), "application/x-subrip")}><Icon name="download" size={13} />SRT</button>
        <button className="btn" onClick={() => download(`multicorder-${s.id}.json`, JSON.stringify({ session: s, transcript: segs, insights: ins, report }, null, 2), "application/json")}><Icon name="download" size={13} />JSON</button>
        {audioUrl && <a className="btn" href={audioUrl} download={`multicorder-${s.id}.webm`}><Icon name="download" size={13} />{t("Audio")}</a>}
        {caption && <span className="source-tag" title={t("This recording's text comes from the platform's subtitles, not speech recognition.")}><Icon name="captions" size={12} />{captionLabel(caption)}</span>}
        {!missing && s.status === "stopped" && s.failure !== "no_audio" && (caption
          ? <button className="btn" disabled={busy} onClick={() => { setBusy(true); void onAsr(s).finally(() => { setBusy(false); load(); }); }}><Icon name="mic" size={13} />{t("Transcribe with speech recognition")}</button>
          : <button className="btn" disabled={busy} onClick={() => void retry()}><Icon name="retry" size={13} />{t("Transcribe again")}</button>)}
        <span className="grow" />
        <button className="btn btn-ghost btn-danger" onClick={() => onDelete(s)}><Icon name="trash" size={13} />{t("Delete")}</button>
      </div>
      <div className="cols">
        <section className="panel-block">
          <h3>{t("Key points")}</h3>
          {ins.length === 0 && <p className="muted small">{t("No key points yet.")}</p>}
          <ul className="points">
            {ins.map((i) => (
              <li key={i.key}>
                <span>{i.text}</span>
                {i.evidence.map((e) => (
                  <button key={e.event_id} className="tsbtn" onClick={() => jump(e.start_ms, e.event_id)}>{fmtTs(e.start_ms)}</button>
                ))}
              </li>
            ))}
          </ul>
          <h3>{t("Report")}</h3>
          <pre className="report">{report?.body ?? (s.report_pending ? t("Waiting for transcription to finish.") : t("No report yet."))}</pre>
        </section>
        <section className="panel-block transcript">
          <h3>{t("Transcript")}</h3>
          {segs.length === 0 && <p className="muted small">{t("No transcript yet.")}</p>}
          {segs.map((e) => (
            <p key={e.id} id={e.id} className={focus === e.id ? "focus" : ""}><button className="tsbtn" onClick={() => jump(e.startMs, e.id)}>{fmtTs(e.startMs)}</button> {e.text}</p>
          ))}
        </section>
      </div>
    </article>
  );
}

function App() {
  useLang();
  const [list, setList] = useState<db.LocalSession[]>([]);
  const [sel, setSel] = useState<string | null>(location.hash.slice(1) || null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ session: db.LocalSession; seg: Seg }[] | null>(null);
  const load = () => db.listSessions().then(setList).catch(console.error);
  useEffect(() => {
    void load();
    chrome.storage.local.get("theme").then((v) => v.theme && applyTheme(v.theme));
    const onMsg = (m: any) => m?.type === "local-event" && ["status", "asr", "report"].includes(m.event.type) && void load();
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);
  const current = list.find((s) => s.id === sel) ?? list[0];
  const [confirmDialog, confirm] = useConfirm();
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2500);
    return () => clearTimeout(timer);
  }, [notice]);
  const remove = async (s: db.LocalSession) => {
    const ok = await confirm({
      title: t("Delete this recording?"),
      message: t("“{name}” and its audio, transcript and summary will be deleted. This can't be undone.", { name: s.name?.trim() || s.title }),
      confirmLabel: t("Delete"),
    });
    if (!ok) return;
    try {
      await db.deleteSession(s.id);
      setNotice(t("Recording deleted."));
      if (sel === s.id) { setSel(null); history.replaceState(null, "", location.pathname); }
      await load();
    } catch (error) {
      setNotice(tError(error));
    }
  };
  const asrInstead = async (s: db.LocalSession) => {
    const ok = await confirm({
      title: t("Transcribe with speech recognition?"),
      message: t("The platform subtitles, key points and summary of this recording are replaced by speech recognition of its audio. This uses your transcription service."),
      confirmLabel: t("Transcribe"),
      danger: false,
    });
    if (!ok) return;
    const r = await chrome.runtime.sendMessage({ type: "local-asr", sessionId: s.id }).catch((e) => ({ error: tError(e) }));
    setNotice(r?.error ? tError(r.error) : t("Transcribing {n} part(s)…", { n: r?.queued ?? 0 }));
    await load();
  };
  return (
    <div className="lib">
      <style>{THEME_CSS + LIB_CSS}</style>
      {confirmDialog}
      {notice && <div className="toast" role="status">{notice}</div>}
      <aside>
        <header className="ahead"><span className="logo" aria-hidden><Icon name="wave" /></span><h1>{t("Library")}</h1><span className="grow" /><a className="btn btn-ghost icon-btn" href="options.html" title={t("Settings")} aria-label={t("Settings")}><Icon name="gear" /></a><LangToggle /><ThemeToggle persist={(p) => chrome.storage.local.set({ theme: p })} /></header>
        <form className="search" onSubmit={(e) => { e.preventDefault(); if (q.trim()) db.search(q).then(setHits); else setHits(null); }}>
          <Icon name="search" />
          <input className="input" aria-label={t("Search transcripts")} placeholder={t("Search transcripts")} value={q} onChange={(e) => { setQ(e.target.value); if (!e.target.value) setHits(null); }} />
        </form>
        {hits ? (
          <ul className="list">
            {hits.map((h) => (
              <li key={h.seg.id}><button onClick={() => { setSel(h.session.id); setHits(null); }}><span className="t">{h.session.title}</span><span className="small muted">{fmtTs(h.seg.startMs)} · {h.seg.text}</span></button></li>
            ))}
            {hits.length === 0 && <li className="muted small pad">{t("No matches.")}</li>}
          </ul>
        ) : (
          <ul className="list">
            {list.map((s) => (
              <li key={s.id}>
                <button aria-current={current?.id === s.id} onClick={() => { setSel(s.id); history.replaceState(null, "", `#${s.id}`); }}>
                  <span className="t">{s.title}</span>
                  <span className="meta small muted">{new Date(s.started_at).toLocaleDateString(locale())} · {fmtTs(s.audio_ms)} {s.asr?.failed_chunks ? <span className="chip warn">{t("Text missing")}</span> : null}</span>
                </button>
                {!["capturing", "starting", "waiting", "stopping", "paused"].includes(s.status) && <button className="list-delete" aria-label={t("Delete {name}", { name: s.name?.trim() || s.title })} title={t("Delete")} onClick={() => void remove(s)}><Icon name="trash" size={13} /></button>}
              </li>
            ))}
          </ul>
        )}
        {list.length === 0 && <div className="empty list-empty"><Icon name="wave" size={24} /><span>{t("No recordings yet.")}</span></div>}
      </aside>
      <main>{current ? <Detail key={current.id} s={current} onChanged={() => void load()} onDelete={(s) => void remove(s)} onAsr={asrInstead} /> : <div className="empty main-empty"><Icon name="library" size={28} /><span>{t("Select a recording.")}</span></div>}</main>
    </div>
  );
}

const LIB_CSS = `
.lib{display:grid;grid-template-columns:300px minmax(0,1fr);height:100vh}
aside{border-right:1px solid var(--border);background:var(--sidebar);display:flex;flex-direction:column;min-height:0}
.ahead{display:flex;align-items:center;gap:2px;padding:14px 10px 10px 14px}.ahead .grow{flex:1}.ahead h1{margin-left:8px;font-size:15px}
.logo{width:24px;height:24px;border-radius:7px;background:linear-gradient(135deg,#ff6b6f,var(--accent) 55%,#c4252b);color:#fff;display:grid;place-items:center;flex:none}
.search{display:flex;align-items:center;margin:0 12px 10px;color:var(--text-3);position:relative}.search svg{position:absolute;left:9px;pointer-events:none}.search .input{flex:1;padding-left:30px}
.list{list-style:none;margin:0;padding:0 8px 8px;overflow:auto;flex:1;display:flex;flex-direction:column;gap:1px}
.list button{all:unset;display:flex;flex-direction:column;gap:2px;width:100%;box-sizing:border-box;padding:8px 10px;border-radius:var(--radius-sm);cursor:pointer;position:relative}
.list button:hover{background:var(--surface-3)}
.list button[aria-current="true"]{background:var(--surface);box-shadow:var(--shadow)}
.list button:focus-visible{outline:2px solid var(--focus)}
.list li{position:relative}
.list li>button:first-child{padding-right:34px}
.list .list-delete{all:unset;position:absolute;right:8px;top:50%;transform:translateY(-50%);width:24px;height:24px;display:grid;place-items:center;border-radius:5px;color:var(--text-3);cursor:pointer;opacity:0;transition:opacity .12s}
.list li:hover .list-delete,.list .list-delete:focus-visible{opacity:1}
.list .list-delete:hover{background:var(--accent-weak);color:var(--accent-text)}
.list .list-delete:focus-visible{outline:2px solid var(--focus)}
.list .t{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.list .meta{display:flex;gap:6px;align-items:center}
.list-empty{margin:12px}
.pad{padding:8px}
main{overflow:auto;min-height:0}
.main-empty{margin:40px auto;max-width:420px}
.detail{max-width:1000px;margin:0 auto;padding:24px 28px 40px;display:flex;flex-direction:column;gap:14px}
.dhead{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.dhead h2{font-size:20px;margin:0 0 4px}.dhead p{margin:0}
audio{width:100%;height:40px}
.toolbar{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.toolbar .grow{flex:1}
.toolbar .btn{height:28px;padding:0 9px;font-size:12px}
.cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px}
.panel-block{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:4px 16px 16px;min-width:0;box-shadow:var(--shadow)}
.points{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.points li{display:flex;gap:6px;align-items:baseline;flex-wrap:wrap}
.tsbtn{all:unset;cursor:pointer;font-family:var(--mono);font-size:11px;color:var(--primary-text);padding:0 5px;border-radius:4px;background:var(--primary-weak)}.tsbtn:hover{filter:brightness(.95)}
.transcript p{margin:0 0 8px;line-height:1.6;padding:2px 4px;border-radius:4px}.focus{background:var(--warn-weak)}
.report{white-space:pre-wrap;font:12px/1.6 var(--mono);background:var(--surface-2);padding:12px;border-radius:var(--radius-sm);margin:0;overflow-wrap:anywhere}
@media (max-width:820px){.lib{grid-template-columns:1fr;height:auto;min-height:100vh}.cols{grid-template-columns:1fr}aside{max-height:40vh}.detail{padding:16px}}
`;

devReloadPage();
createRoot(document.getElementById("root")!).render(<App />);
