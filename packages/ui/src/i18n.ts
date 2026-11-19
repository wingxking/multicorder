// Tiny i18n for the desktop app and the extension: English source strings are the keys, so a
// missing translation falls back to readable English. "system" (the default) follows the browser /
// OS language; the choice is shared across pages of the same origin through localStorage.

import { useSyncExternalStore } from "react";
import { ZH } from "./i18n-zh";

export type Lang = "en" | "zh";
export type LangPref = "system" | Lang;

const KEY = "mc-lang";
const listeners = new Set<() => void>();

function readPref(): LangPref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "en" || v === "zh" || v === "system") return v;
  } catch {
    /* storage unavailable */
  }
  return "system";
}

function systemLang(): Lang {
  if (typeof navigator === "undefined") return "en";
  const first = (navigator.languages?.[0] ?? navigator.language ?? "en").toLowerCase();
  return first.startsWith("zh") ? "zh" : "en";
}

let pref: LangPref = typeof window === "undefined" ? "system" : readPref();
let lang: Lang = pref === "system" ? systemLang() : pref;

function update(next: LangPref) {
  pref = next;
  const resolved = next === "system" ? systemLang() : next;
  const changed = resolved !== lang;
  lang = resolved;
  if (typeof document !== "undefined") document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  listeners.forEach((f) => f());
  return changed;
}

export const getLang = () => lang;
export const getLangPref = () => pref;
/** BCP-47 tag for date and number formatting in the current language. */
export const locale = () => (lang === "zh" ? "zh-CN" : "en-US");

export function setLangPref(next: LangPref) {
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* storage unavailable */
  }
  update(next);
}

/** Translate an English UI string; `{name}` placeholders are filled from `vars`. */
export function t(text: string, vars?: Record<string, string | number>): string {
  const s = lang === "zh" ? ZH[text] ?? text : text;
  return vars ? s.replace(/\{(\w+)\}/g, (m: string, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

function subscribe(f: () => void) {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** Re-render on language change. Call it once in each page's root component. */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, getLang);
}

export function useLangPref(): LangPref {
  return useSyncExternalStore(subscribe, getLangPref, getLangPref);
}

if (typeof window !== "undefined") {
  update(pref);
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) update(readPref());
  });
  window.addEventListener("languagechange", () => {
    if (pref === "system") update("system");
  });
}
