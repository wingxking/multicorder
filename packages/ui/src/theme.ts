// Design tokens shared by the extension and the desktop app. Neutral surfaces in the spirit of
// Linear / Raycast / Radix: one red accent reserved for recording, indigo for selection and links,
// semantic green / amber for health. "system" (the default) follows the OS light/dark setting.

import { useSyncExternalStore } from "react";

export type ThemePref = "system" | "light" | "dark";

const LIGHT = `
  --bg:#f7f7f8;--surface:#ffffff;--surface-2:#f2f2f4;--surface-3:#e9e9ec;--sidebar:#f2f2f4;
  --border:#e5e5e9;--border-strong:#d2d2d8;
  --text:#1b1b1f;--text-2:#5c5c66;--text-3:#8d8d98;
  --accent:#e5484d;--accent-hover:#dc3e42;--accent-weak:#feebec;--accent-text:#ce2c31;
  --primary:#3e63dd;--primary-weak:#edf2fe;--primary-text:#3a5bc7;
  --ok:#30a46c;--ok-text:#18794e;--ok-weak:#e6f6eb;
  --warn:#c27c00;--warn-text:#9a5b00;--warn-weak:#fff6dc;
  --info:#3e63dd;--info-text:#3a5bc7;--info-weak:#edf2fe;
  --focus:rgba(62,99,221,.38);
  --shadow-sm:0 1px 1px rgba(16,16,24,.04);
  --shadow:0 1px 2px rgba(16,16,24,.05),0 0 0 .5px rgba(16,16,24,.02);
  --shadow-lg:0 12px 32px -8px rgba(16,16,24,.18),0 2px 6px rgba(16,16,24,.06);
  color-scheme:light;`;

const DARK = `
  --bg:#0f0f11;--surface:#17171a;--surface-2:#1f1f23;--surface-3:#29292e;--sidebar:#131315;
  --border:#2a2a30;--border-strong:#3a3a42;
  --text:#ededf0;--text-2:#a5a5b0;--text-3:#74747f;
  --accent:#e5484d;--accent-hover:#ec5d5e;--accent-weak:#3a1418;--accent-text:#ff9592;
  --primary:#7b93f0;--primary-weak:#1a2346;--primary-text:#9eb1ff;
  --ok:#3dd68c;--ok-text:#4cc38a;--ok-weak:#122a1e;
  --warn:#f1a10d;--warn-text:#ffca16;--warn-weak:#2c2108;
  --info:#7b93f0;--info-text:#9eb1ff;--info-weak:#1a2346;
  --focus:rgba(123,147,240,.45);
  --shadow-sm:none;--shadow:0 0 0 .5px rgba(0,0,0,.4);
  --shadow-lg:0 16px 40px -8px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.06);
  color-scheme:dark;`;

export const THEME_CSS = `
:root{${LIGHT}
  --radius:12px;--radius-md:9px;--radius-sm:7px;
  --font:-apple-system,BlinkMacSystemFont,"SF Pro Text","Inter","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI",system-ui,sans-serif;
  --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,monospace;
}
:root[data-theme="dark"]{${DARK}}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${DARK}}}
*{box-sizing:border-box}
html,body{background:var(--bg);color:var(--text);font:13px/1.5 var(--font);margin:0;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
::selection{background:var(--primary-weak)}
*::-webkit-scrollbar{width:10px;height:10px}
*::-webkit-scrollbar-thumb{background:var(--border-strong);border-radius:10px;border:3px solid transparent;background-clip:content-box}
*::-webkit-scrollbar-thumb:hover{background-color:var(--text-3)}
*::-webkit-scrollbar-track{background:transparent}
a{color:var(--primary-text);text-decoration:none}a:hover{text-decoration:underline}
h1{font-size:15px;font-weight:600;margin:0;letter-spacing:-.01em}
h2{font-size:15px;font-weight:600;margin:0 0 8px;letter-spacing:-.01em}
h3{font-size:11px;font-weight:600;margin:16px 0 8px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em}
:lang(zh) h3{text-transform:none;letter-spacing:.02em;font-size:12px}
button,select,input,textarea{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--focus);outline-offset:1px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 11px;border:1px solid var(--border);background:var(--surface);border-radius:var(--radius-sm);cursor:pointer;white-space:nowrap;font-weight:500;box-shadow:var(--shadow-sm);transition:background .12s,border-color .12s,color .12s,transform .06s}
.btn:hover{border-color:var(--border-strong);background:var(--surface-2)}
.btn:active:not(:disabled){transform:translateY(.5px)}
.btn:disabled{opacity:.5;cursor:default}
.btn svg{flex:none}
.btn-primary{background:var(--primary);border-color:var(--primary);color:#fff;box-shadow:0 1px 2px color-mix(in srgb,var(--primary) 30%,transparent)}
.btn-primary:hover{background:color-mix(in srgb,var(--primary) 88%,#000);border-color:color-mix(in srgb,var(--primary) 88%,#000)}
.btn-sm{height:26px;padding:0 8px;font-size:12px}
/* Recording status colours, shared by the Mac app and the extension:
   green = ready to record (audio detected) · neutral = can record, no audio yet · red = recording (REC light)
   amber = paused or reconnecting · blue = waiting, saving, processing · grey = done or idle. */
.btn-record{color:var(--text-2)}
.btn-record svg{color:var(--text-3)}
.btn-record svg circle{fill:none;stroke:currentColor;stroke-width:1.6}
.btn-record.is-ready{background:var(--ok-weak);border-color:color-mix(in srgb,var(--ok) 35%,transparent);color:var(--ok-text)}
.btn-record.is-ready svg{color:var(--ok)}
.btn-record.is-ready svg circle{fill:currentColor;stroke:none}
.btn-record.is-ready:hover{background:color-mix(in srgb,var(--ok) 16%,var(--surface));border-color:var(--ok)}
.audio-dot{width:7px;height:7px;flex:none;border-radius:50%;background:var(--border-strong)}
.audio-dot.on{background:var(--ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--ok) 20%,transparent)}
.audio-idle{color:var(--text-2)}
.btn-ghost{border-color:transparent;background:transparent;box-shadow:none}
.btn-ghost:hover{background:var(--surface-3);border-color:transparent}
.btn-danger{color:var(--accent-text)}
.btn-danger:hover{background:var(--accent-weak)}
.icon-btn{width:30px;padding:0}
.btn-sm.icon-btn{width:26px}
.text-btn{min-width:30px;padding:0 6px;font-size:12px;font-weight:600}
.input,select.input{height:30px;padding:0 9px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface);min-width:0;transition:border-color .12s,box-shadow .12s}
select.input{-webkit-appearance:none;appearance:none;padding-right:30px;background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 16 16' fill='none' stroke='%238d8d98' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E\");background-repeat:no-repeat;background-position:right 10px center;background-size:12px;cursor:pointer}
select.input:disabled{cursor:default}
.input:hover{border-color:var(--border-strong)}
.input:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px var(--focus)}
.seg{display:inline-flex;gap:2px;padding:2px;border-radius:var(--radius-sm);background:var(--surface-3)}
.seg button{border:0;background:transparent;height:24px;padding:0 10px;white-space:nowrap;cursor:pointer;color:var(--text-2);font-size:12px;font-weight:500;border-radius:5px;transition:background .12s,color .12s}
.seg button:hover:not(:disabled){color:var(--text)}
.seg button[aria-pressed="true"]{background:var(--surface);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.08),0 0 0 .5px rgba(0,0,0,.06)}
.seg button:disabled{cursor:default;opacity:.6}
.chip{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:999px;font-size:11px;font-weight:500;background:var(--surface-2);color:var(--text-2);white-space:nowrap;border:1px solid transparent}
.chip.rec{background:var(--accent-weak);color:var(--accent-text)}
.chip.err{background:var(--accent-weak);color:var(--accent-text)}
.text-source{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.text-source.is-captions{color:var(--ok-text)}
.text-source svg{flex:none}
.source-tag{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--ok-text);background:var(--ok-weak);border-radius:999px;padding:1px 8px;white-space:nowrap}
.mc-confirm{width:min(380px,calc(100% - 32px));padding:0;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);color:var(--text);box-shadow:var(--shadow-lg)}
.mc-confirm::backdrop{background:rgb(0 0 0 / 35%);backdrop-filter:blur(2px)}
.mc-confirm-body{display:grid;gap:8px;padding:20px}
.mc-confirm h2{margin:0;font-size:15px;font-weight:600}
.mc-confirm p{margin:0;font-size:13px;color:var(--text-2);line-height:1.5}
.mc-confirm-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}
.btn-destructive{background:var(--accent);border-color:var(--accent);color:#fff}
.btn-destructive:hover{background:var(--accent-hover);border-color:var(--accent-hover)}
.chip.ok{background:var(--ok-weak);color:var(--ok-text)}
.chip.warn{background:var(--warn-weak);color:var(--warn-text)}
.chip.info{background:var(--info-weak);color:var(--info-text)}
.dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.rec .dot{animation:mcpulse 1.4s ease-in-out infinite}
@keyframes mcpulse{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes mcin{from{opacity:0;transform:translate(-50%,6px)}to{opacity:1;transform:translate(-50%,0)}}
@media (prefers-reduced-motion: reduce){.rec .dot{animation:none}.toast{animation:none!important}}
.muted{color:var(--text-3)}.small{font-size:12px}
.ts{font-family:var(--mono);font-size:11px;color:var(--text-3);font-variant-numeric:tabular-nums}
.banner{display:flex;gap:8px;align-items:flex-start;padding:9px 11px;border-radius:var(--radius-sm);font-size:12px;border:1px solid;line-height:1.45}
.banner svg{flex:none;margin-top:1px}
.banner.warn{background:var(--warn-weak);border-color:color-mix(in srgb,var(--warn) 30%,transparent);color:var(--warn-text)}
.banner.info{background:var(--info-weak);border-color:color-mix(in srgb,var(--info) 30%,transparent);color:var(--info-text)}
.banner .grow{flex:1}
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;border:1px dashed var(--border-strong);border-radius:var(--radius);padding:36px 24px;text-align:center;color:var(--text-3)}
.empty svg{color:var(--text-3);opacity:.8}
.toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:var(--text);color:var(--bg);padding:8px 16px;border-radius:999px;font-size:12px;max-width:min(80vw,560px);box-shadow:var(--shadow-lg);z-index:50;animation:mcin .18s ease-out;overflow-wrap:anywhere}
kbd{font-family:var(--mono);font-size:11px;border:1px solid var(--border);border-bottom-width:2px;border-radius:4px;padding:0 4px;background:var(--surface-2)}
code{font-family:var(--mono);font-size:12px;background:var(--surface-2);padding:1px 5px;border-radius:4px}
`;

const KEY = "mc-theme";
const listeners = new Set<() => void>();

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* storage unavailable */
  }
  return "system";
}

let current: ThemePref = typeof window === "undefined" ? "system" : readPref();

export function applyTheme(pref: ThemePref) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (pref === "system") delete root.dataset.theme;
  else root.dataset.theme = pref;
  if (pref !== current) {
    current = pref;
    listeners.forEach((f) => f());
  }
}

export function loadThemePref(): ThemePref {
  return current;
}

export function saveThemePref(pref: ThemePref) {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* storage unavailable */
  }
  applyTheme(pref);
}

/** Current theme preference; re-renders when it changes here or in another page of the same origin. */
export function useThemePref(): ThemePref {
  return useSyncExternalStore(
    (f) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    () => current,
    () => current,
  );
}

if (typeof window !== "undefined") {
  applyTheme(current);
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) applyTheme(readPref());
  });
}
