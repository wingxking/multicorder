// Tiny i18n for the desktop app and the extension: English source strings are the keys, so a
// missing translation falls back to readable English. "system" (the default) follows the browser /
// OS language; the choice is shared across pages of the same origin through localStorage.
//
// Adding a language: create `i18n-<code>.ts` exporting a `Record<string, string>` keyed by the
// English text (copy i18n-zh.ts), then add one entry to LANGUAGES below. Everything else (the
// pickers, `t`, `tError`, date locale, `<html lang>`) reads from LANGUAGES.

import { useSyncExternalStore } from "react";
import { ZH } from "./i18n-zh";

export interface LanguageInfo {
  /** Short code stored in preferences. */
  code: string;
  /** Name shown in the language picker, in that language. */
  label: string;
  /** Compact label for the header toggle. */
  short: string;
  /** BCP-47 tag for `<html lang>` and date / number formatting. */
  locale: string;
  /** Lower-case browser language prefixes that select this language under "system". */
  match: string[];
  /** Translations keyed by English text; English itself has none. */
  dict: Record<string, string>;
}

export const LANGUAGES = [
  { code: "en", label: "English", short: "EN", locale: "en-US", match: ["en"], dict: {} },
  { code: "zh", label: "中文", short: "中", locale: "zh-CN", match: ["zh"], dict: ZH },
] as const satisfies readonly LanguageInfo[];

export type Lang = (typeof LANGUAGES)[number]["code"];
export type LangPref = "system" | Lang;

const KEY = "mc-lang";
const listeners = new Set<() => void>();
const info = (code: Lang): LanguageInfo => LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];
const isLang = (v: unknown): v is Lang => LANGUAGES.some((l) => l.code === v);

function readPref(): LangPref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "system" || isLang(v)) return v;
  } catch {
    /* storage unavailable */
  }
  return "system";
}

function systemLang(): Lang {
  if (typeof navigator === "undefined") return "en";
  for (const tag of navigator.languages?.length ? navigator.languages : [navigator.language ?? "en"]) {
    const low = tag.toLowerCase();
    const hit = LANGUAGES.find((l) => l.match.some((m) => low === m || low.startsWith(m + "-")));
    if (hit) return hit.code;
  }
  return "en";
}

let pref: LangPref = typeof window === "undefined" ? "system" : readPref();
let lang: Lang = pref === "system" ? systemLang() : pref;

function update(next: LangPref) {
  pref = next;
  lang = next === "system" ? systemLang() : next;
  if (typeof document !== "undefined") document.documentElement.lang = info(lang).locale;
  listeners.forEach((f) => f());
}

export const getLang = () => lang;
export const getLangPref = () => pref;
/** BCP-47 tag for date and number formatting in the current language. */
export const locale = () => info(lang).locale;
export const languageInfo = () => info(lang);

export function setLangPref(next: LangPref) {
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* storage unavailable */
  }
  update(next);
}

function fill(s: string, vars?: Record<string, string | number>) {
  return vars ? s.replace(/\{(\w+)\}/g, (m: string, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** Translate an English UI string; `{name}` placeholders are filled from `vars`. */
export function t(text: string, vars?: Record<string, string | number>): string {
  return fill(info(lang).dict[text] ?? text, vars);
}

// Backend messages (Rust engine, Tauri commands, the local HTTP API, extension engines) arrive as
// finished English sentences. They are translated by exact match, or by matching a dictionary key
// that has `{placeholders}` as a pattern. Values captured by `{error}` and `{label}` are translated in
// turn, so nested causes ("could not start capture: <cause>") come out fully translated; other values
// (titles, ids, names) are user data and stay as they are.
const NESTED = new Set(["error", "label"]);
type Pattern = { re: RegExp; names: string[]; out: string; literal: number };
const patterns = new Map<Lang, Pattern[]>();

function patternsFor(code: Lang): Pattern[] {
  let list = patterns.get(code);
  if (!list) {
    list = Object.entries(info(code).dict)
      .filter(([en]) => /\{\w+\}/.test(en) && en.replace(/\{\w+\}/g, "").trim().length >= 3)
      .map(([en, out]) => {
        const names: string[] = [];
        const src = en.split(/(\{\w+\})/).map((part) => {
          const m = /^\{(\w+)\}$/.exec(part);
          if (m) {
            names.push(m[1]);
            return "([\\s\\S]+?)";
          }
          return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }).join("");
        return { re: new RegExp(`^${src}$`), names, out, literal: en.replace(/\{\w+\}/g, "").length };
      })
      // Most literal text first, so "ASR HTTP {status}: {body}" wins over "{name} HTTP {status}: {body}".
      .sort((a, b) => b.literal - a.literal);
    patterns.set(code, list);
  }
  return list;
}

function translateMessage(msg: string, depth: number): string {
  const dict = info(lang).dict;
  if (lang === "en" || !msg) return msg;
  const exact = dict[msg] ?? dict[msg.charAt(0).toUpperCase() + msg.slice(1)];
  if (exact !== undefined) return exact;
  if (depth > 3) return msg;
  for (const p of patternsFor(lang)) {
    const m = p.re.exec(msg);
    if (!m) continue;
    const vars: Record<string, string> = {};
    p.names.forEach((name, i) => (vars[name] = NESTED.has(name) ? translateMessage(m[i + 1], depth + 1) : m[i + 1]));
    return fill(p.out, vars);
  }
  return msg;
}

/** Human, translated text for an error from the backend, an `Error`, or a rejected promise value. */
export function tError(error: unknown): string {
  let msg = error instanceof Error ? error.message : typeof error === "string" ? error : (error as { error?: string; message?: string } | null)?.error ?? (error as { message?: string } | null)?.message ?? String(error);
  msg = msg.replace(/^(?:Uncaught )?(?:Error|TypeError|ServiceError):\s*/, "").trim();
  return translateMessage(msg, 0);
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
