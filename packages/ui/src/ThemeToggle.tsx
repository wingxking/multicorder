import React, { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { LangPref, LANGUAGES, setLangPref, t, useLang, useLangPref } from "./i18n";
import { saveThemePref, ThemePref, useThemePref } from "./theme";

const NEXT: Record<ThemePref, ThemePref> = { system: "light", light: "dark", dark: "system" };
const LABEL: Record<ThemePref, string> = { system: "Theme: follow system", light: "Theme: light", dark: "Theme: dark" };
const ICON: Record<ThemePref, string> = { system: "monitor", light: "sun", dark: "moon" };

/** Cycles system → light → dark. `persist` lets the extension mirror the choice to chrome.storage. */
export function ThemeToggle({ persist }: { persist?: (p: ThemePref) => void }) {
  const pref = useThemePref();
  useLang();
  const label = t(LABEL[pref]);
  return (
    <button
      className="btn btn-ghost icon-btn"
      title={label}
      aria-label={label}
      onClick={() => {
        const n = NEXT[pref];
        saveThemePref(n);
        persist?.(n);
      }}
    >
      <Icon name={ICON[pref]} />
    </button>
  );
}

/** Switches between English and Chinese (an explicit choice; "follow system" lives in Settings). */
export function LangToggle() {
  const lang = useLang();
  // Two languages: flip between them. More: step through LANGUAGES in order.
  const i = LANGUAGES.findIndex((l) => l.code === lang);
  const next = LANGUAGES[(i + 1) % LANGUAGES.length];
  const label = t("Switch to {language}", { language: next.label });
  return (
    <button className="btn btn-ghost text-btn" title={label} aria-label={label} onClick={() => setLangPref(next.code)}>
      {next.short}
    </button>
  );
}

/** Full appearance + language pickers for settings pages, including "follow system". */
export function PreferenceControls({ persistTheme }: { persistTheme?: (p: ThemePref) => void }) {
  const theme = useThemePref();
  const langPref = useLangPref();
  useLang();
  const themes: [ThemePref, string][] = [["system", "System"], ["light", "Light"], ["dark", "Dark"]];
  const langs: [LangPref, string][] = [["system", t("System")], ...LANGUAGES.map((l): [LangPref, string] => [l.code, l.label])];
  return (
    <div className="prefs">
      <div className="pref-row">
        <span>{t("Appearance")}</span>
        <div className="seg" role="group" aria-label={t("Appearance")}>
          {themes.map(([v, l]) => <button key={v} aria-pressed={theme === v} onClick={() => { saveThemePref(v); persistTheme?.(v); }}>{t(l)}</button>)}
        </div>
      </div>
      <div className="pref-row">
        <span>{t("Language")}</span>
        <div className="seg" role="group" aria-label={t("Language")}>
          {langs.map(([v, l]) => <button key={v} aria-pressed={langPref === v} onClick={() => setLangPref(v)}>{l}</button>)}
        </div>
      </div>
    </div>
  );
}

export const PREFS_CSS = `
.prefs{display:flex;flex-direction:column;gap:2px}
.pref-row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:36px}
.pref-row>span{color:var(--text-2)}
`;

/** A single toast whose timer restarts on every message (no early dismissal of a newer one). */
export function useToast(ms = 4000): [string | null, (text: string) => void] {
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const flash = useCallback((text: string) => {
    clearTimeout(timer.current);
    setToast(text);
    timer.current = setTimeout(() => setToast(null), ms);
  }, [ms]);
  return [toast, flash];
}
