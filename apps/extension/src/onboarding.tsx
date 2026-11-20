// First-run page: what the extension does, how to connect the Mac app, and a consent reminder.

import { devReloadPage } from "./dev-reload";
import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { applyTheme, Icon, LangToggle, t, THEME_CSS, ThemeToggle, useLang } from "@multicorder/ui";

function App() {
  useLang();
  useEffect(() => {
    chrome.storage?.local.get("theme").then((v) => v.theme && applyTheme(v.theme)).catch(() => {});
  }, []);
  useEffect(() => {
    document.title = t("Set up Multicorder");
  });
  const steps: [string, React.ReactNode][] = [
    [t("Install the Mac app"), t("Install and open Multicorder for Mac. It registers itself with Chrome, Edge and Brave on first launch.")],
    [t("Running from source?"), <>{t("Start {serve} and run {install}.").split(/(\{serve\}|\{install\})/).map((part, i) =>
      part === "{serve}" ? <code key={i}>mcd serve</code> : part === "{install}" ? <code key={i}>mcd install-host --extension-id {chrome.runtime?.id ?? "<id>"}</code> : part)}</>],
    [t("Start recording"), <>{t("Go back to a tab that is playing audio and click the Multicorder icon, or press {keys}.").split("{keys}").flatMap((part, i) => (i ? [<kbd key={i}>Alt+Shift+R</kbd>, part] : [part]))}</>],
  ];
  return (
    <main className="ob">
      <header>
        <div className="brand"><span className="logo"><Icon name="wave" size={16} /></span><h1>{t("Set up Multicorder")}</h1></div>
        <div className="tools"><LangToggle /><ThemeToggle persist={(p) => void chrome.storage?.local.set({ theme: p })} /></div>
      </header>
      <p className="lead">{t("The extension captures tab audio. It works on its own, and when the Multicorder app is running on your Mac it records, transcribes and summarises there instead. Audio sent to the app stays on this Mac (127.0.0.1).")}</p>
      <ol className="steps">
        {steps.map(([title, body], i) => (
          <li key={i}><span className="num">{i + 1}</span><div><div className="st">{title}</div><div className="sd">{body}</div></div></li>
        ))}
      </ol>
      <div className="banner info"><Icon name="mic" /><span className="grow">{t("Recording other people? Tell them first. Some places require everyone's consent.")}</span></div>
      <div className="actions">
        <button className="btn" onClick={() => chrome.runtime.openOptionsPage()}><Icon name="gear" size={14} />{t("Open settings")}</button>
      </div>
    </main>
  );
}

const CSS = `
.ob{max-width:640px;margin:0 auto;padding:40px 20px 56px;display:flex;flex-direction:column;gap:18px}
header{display:flex;align-items:center;justify-content:space-between;gap:12px}
.brand{display:flex;align-items:center;gap:10px}
.logo{display:grid;place-items:center;width:30px;height:30px;border-radius:8px;background:var(--accent);color:#fff}
h1{font-size:20px}
.tools{display:flex;gap:4px}
.lead{margin:0;color:var(--text-2);font-size:14px;line-height:1.6}
.steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.steps li{display:flex;gap:12px;padding:14px 16px;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);box-shadow:var(--shadow)}
.num{flex:none;display:grid;place-items:center;width:22px;height:22px;border-radius:50%;background:var(--primary-weak);color:var(--primary-text);font-size:12px;font-weight:600}
.st{font-weight:600;margin-bottom:2px}
.sd{color:var(--text-2);line-height:1.6;overflow-wrap:anywhere}
.actions{display:flex;gap:8px}
`;

const style = document.createElement("style");
style.textContent = THEME_CSS + CSS;
document.head.appendChild(style);
devReloadPage();
createRoot(document.getElementById("root")!).render(<App />);
