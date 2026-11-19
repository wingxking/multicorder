// Settings: where recordings are processed, which transcription + summary service is used
// (local Mac service, Multicorder Cloud, or your own keys), language and appearance.

import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { applyTheme, Icon, LangToggle, PreferenceControls, PREFS_CSS, t, tError, THEME_CSS, ThemeToggle, useLang } from "@multicorder/ui";
import { CLOUD_URL, DEFAULTS, loadSettings, saveSettings, SERVICE_LABEL, ServiceEnv, Settings } from "./local/settings";

function Choice<T extends string>({ value, options, onChange }: { value: T; options: { v: T; title: string; desc: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="choices" role="radiogroup">
      {options.map((o) => (
        <label key={o.v} className={`choice ${value === o.v ? "on" : ""}`}>
          <input type="radio" checked={value === o.v} onChange={() => onChange(o.v)} />
          <span className="ct">{o.title}</span>
          <span className="cd">{o.desc}</span>
        </label>
      ))}
    </div>
  );
}

function App() {
  useLang();
  const [s, setS] = useState<Settings | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [health, setHealth] = useState<{ ok: boolean; detail: string } | null>(null);
  useEffect(() => {
    loadSettings().then(setS).catch(() => setS(DEFAULTS));
    chrome.storage.local.get("theme").then((v) => v.theme && applyTheme(v.theme));
  }, []);
  if (!s) return null;
  const set = (patch: Partial<Settings>) => {
    setS({ ...s, ...patch });
    setMsg(null);
  };

  async function save() {
    let note = t("Saved.");
    if (s!.service === "custom" || s!.service === "cloud") {
      const urls = s!.service === "cloud" ? [s!.cloudUrl] : [s!.asr.baseUrl, ...s!.llm.map((p) => p.baseUrl)];
      const origins = urls.map((u) => { try { return new URL(u).origin + "/*"; } catch { return null; } }).filter((x): x is string => !!x);
      const granted = await chrome.permissions.request({ origins }).catch(() => false);
      if (!granted) note = t("Saved, but network access to some addresses was not granted; requests to them will fail.");
    }
    await saveSettings(s!);
    setMsg(note);
    setHealth(await chrome.runtime.sendMessage({ type: "service-health" }).catch(() => null));
  }

  return (
    <div className="page">
      <style>{THEME_CSS + PREFS_CSS + CSS}</style>
      <header className="top"><span className="logo" aria-hidden><Icon name="wave" /></span><h1>{t("Settings")}</h1><span className="grow" /><a className="btn btn-ghost" href="library.html"><Icon name="library" />{t("Library")}</a><LangToggle /><ThemeToggle persist={(p) => chrome.storage.local.set({ theme: p })} /></header>

      <section className="card">
        <h2>{t("General")}</h2>
        <PreferenceControls persistTheme={(p) => chrome.storage.local.set({ theme: p })} />
      </section>

      <section className="card">
        <h2>{t("Where recordings are processed")}</h2>
        <Choice
          value={s.appConnection}
          onChange={(v) => set({ appConnection: v })}
          options={[
            { v: "standalone", title: t("In this browser"), desc: t("Recordings, transcripts and summaries are kept in the extension. Works without the Mac app.") },
            { v: "app", title: t("In the Mac app"), desc: t("Audio is sent to Multicorder for Mac, which records, transcribes and keeps everything.") },
          ]}
        />
      </section>

      {s.appConnection === "standalone" && (
        <section className="card">
          <h2>{t("Transcription and summary service")}</h2>
          <Choice<ServiceEnv>
            value={s.service}
            onChange={(v) => set({ service: v })}
            options={[
              { v: "local", title: t(SERVICE_LABEL.local), desc: t("Uses the Multicorder app or `mcd` running on this Mac (127.0.0.1). Keys stay in the Mac app.") },
              { v: "cloud", title: t(SERVICE_LABEL.cloud), desc: t("Hosted service at {host}. Not available yet.", { host: new URL(CLOUD_URL).host }) },
              { v: "custom", title: t(SERVICE_LABEL.custom), desc: t("Call MOSS or an OpenAI-compatible provider directly with keys stored in this browser.") },
            ]}
          />
          {s.service === "cloud" && (
            <div className="grid">
              <label>{t("Service address")}<input className="input" value={s.cloudUrl} onChange={(e) => set({ cloudUrl: e.target.value })} /></label>
              <label>{t("Access token")}<input className="input" type="password" autoComplete="off" value={s.cloudToken} onChange={(e) => set({ cloudToken: e.target.value })} /></label>
            </div>
          )}
          {s.service === "custom" && (
            <>
              <h3>{t("Transcription")}</h3>
              <div className="grid">
                <label>{t("Protocol")}<select className="input" value={s.asr.protocol} onChange={(e) => set({ asr: { ...s.asr, protocol: e.target.value as "moss" | "openai" } })}><option value="moss">MOSS</option><option value="openai">{t("OpenAI-compatible")}</option></select></label>
                <label>{t("Address")}<input className="input" value={s.asr.baseUrl} onChange={(e) => set({ asr: { ...s.asr, baseUrl: e.target.value } })} /></label>
                <label>{t("Model")}<input className="input" value={s.asr.model} onChange={(e) => set({ asr: { ...s.asr, model: e.target.value } })} /></label>
                <label>{t("API key")}<input className="input" type="password" autoComplete="off" value={s.asr.apiKey} onChange={(e) => set({ asr: { ...s.asr, apiKey: e.target.value } })} /></label>
              </div>
              <h3>{t("Summaries (tried in order)")}</h3>
              {s.llm.map((p, i) => (
                <div className="grid" key={i}>
                  <label>{t("Name")}<input className="input" value={p.name} onChange={(e) => set({ llm: s.llm.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} /></label>
                  <label>{t("Address")}<input className="input" value={p.baseUrl} onChange={(e) => set({ llm: s.llm.map((x, j) => (j === i ? { ...x, baseUrl: e.target.value } : x)) })} /></label>
                  <label>{t("Model")}<input className="input" value={p.model} onChange={(e) => set({ llm: s.llm.map((x, j) => (j === i ? { ...x, model: e.target.value } : x)) })} /></label>
                  <label>{t("API key")}<input className="input" type="password" autoComplete="off" value={p.apiKey} onChange={(e) => set({ llm: s.llm.map((x, j) => (j === i ? { ...x, apiKey: e.target.value } : x)) })} /></label>
                </div>
              ))}
              <div className="row-actions">
                <button className="btn" onClick={() => set({ llm: [...s.llm, { ...DEFAULTS.llm[0], name: "custom", apiKey: "" }] })}>{t("Add provider")}</button>
              </div>
              <p className="muted small">{t("Keys are stored in this browser profile and sent only to the addresses above. The Mac app keeps its keys in the macOS Keychain, which is safer.")}</p>
            </>
          )}
        </section>
      )}

      <section className="card">
        <h2>{t("Output")}</h2>
        <div className="grid">
          <label>{t("Summaries in")}<select className="input" value={s.outputLang} onChange={(e) => set({ outputLang: e.target.value })}><option value="zh">{t("Chinese")}</option><option value="en">{t("English")}</option><option value="ja">{t("Japanese")}</option></select></label>
          <label>{t("New recordings")}<select className="input" value={s.defaultMode} onChange={(e) => set({ defaultMode: e.target.value as Settings["defaultMode"] })}><option value="live">{t("Live summary")}</option><option value="after">{t("Summary at end")}</option><option value="off">{t("Record only")}</option></select></label>
        </div>
        <label className="check"><input type="checkbox" checked={s.silentCapture} onChange={(e) => set({ silentCapture: e.target.checked })} /> {t("Mute playback for new tab recordings")}</label>
      </section>

      <footer className="actions">
        <button className="btn btn-primary" onClick={() => void save()}>{t("Save")}</button>
        {msg && <span className="small" role="status">{msg}</span>}
        {health && <span className={`chip ${health.ok ? "ok" : "warn"}`}><span className="dot" />{health.ok ? `${t("Service reachable")} · ${tError(health.detail)}` : `${t("Service unavailable")} · ${tError(health.detail)}`}</span>}
      </footer>
    </div>
  );
}

const CSS = `
.page{max-width:760px;margin:0 auto;padding:28px 20px 60px;display:flex;flex-direction:column;gap:14px}
.top{display:flex;align-items:center;gap:2px;margin-bottom:4px}.top .grow{flex:1}.top h1{font-size:20px;margin-left:10px}
.logo{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#ff6b6f,var(--accent) 55%,#c4252b);color:#fff;display:grid;place-items:center;flex:none}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);padding:16px 18px;display:flex;flex-direction:column;gap:10px}
.card h2{margin:0 0 2px}
.card h3{margin:8px 0 0}
.choices{display:grid;gap:8px}
.choice{display:grid;grid-template-columns:auto 1fr;column-gap:10px;row-gap:2px;padding:11px 13px;border:1px solid var(--border);border-radius:var(--radius-md);cursor:pointer;transition:border-color .12s,background .12s}
.choice:hover{border-color:var(--border-strong)}
.choice.on{border-color:var(--primary);background:var(--primary-weak)}
.choice input{grid-row:span 2;margin-top:3px;accent-color:var(--primary)}
.ct{font-weight:600}.cd{color:var(--text-2);font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}
.grid+.grid{border-top:1px dashed var(--border);padding-top:10px}
.grid label{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--text-2);font-weight:500}
.check{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--text-2)}
.check input{accent-color:var(--accent);margin:0}
.row-actions{display:flex;gap:6px}
.actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding-top:4px}
`;

createRoot(document.getElementById("root")!).render(<App />);
