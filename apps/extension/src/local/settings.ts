// Extension settings (chrome.storage.local). Keys stay in this browser profile, are only read by
// extension pages and the service worker, and are never logged.

/** "auto": the Mac app when it is running, otherwise this browser. */
export type AppConnection = "auto" | "standalone" | "app";
export type ServiceEnv = "local" | "cloud" | "custom";
export type SummaryMode = "off" | "live" | "after";
/**
 * Where a tab recording's text comes from. "auto": the platform's own subtitles when the video
 * has them (YouTube, Bilibili, TikTok, Douyin, a page's text tracks), speech recognition for the
 * rest; "asr": always speech recognition; "captions": subtitles only, never speech recognition.
 */
export type TextSource = "auto" | "asr" | "captions";

export const CLOUD_URL = "https://multicoder.followkol.live";

export interface AsrSettings {
  provider: string;
  protocol: "moss" | "openai";
  baseUrl: string;
  model: string;
  apiKey: string;
  segmented: boolean;
  language: string;
  usdPerMinute: number;
}

export interface LlmProvider {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  jsonMode?: boolean;
  extra?: Record<string, unknown>;
}

export interface Settings {
  /** Where recordings are processed and stored: in this browser, or in the Mac app. */
  appConnection: AppConnection;
  /** Set once the user picks a processing place; until then "standalone" from older versions means the old default. */
  connectionChosen?: boolean;
  /** Which transcription + summary service the in-browser engine calls. */
  service: ServiceEnv;
  cloudUrl: string;
  cloudToken: string;
  defaultMode: SummaryMode;
  textSource: TextSource;
  silentCapture: boolean;
  outputLang: string;
  /** Only used when service = "custom". */
  asr: AsrSettings;
  llm: LlmProvider[];
}

export const DEFAULTS: Settings = {
  appConnection: "auto",
  service: "local",
  cloudUrl: CLOUD_URL,
  cloudToken: "",
  defaultMode: "live",
  textSource: "auto",
  silentCapture: true,
  outputLang: "zh",
  asr: { provider: "moss", protocol: "moss", baseUrl: "https://api.mosi.cn/v1", model: "moss-transcribe-diarize-pro", apiKey: "", segmented: true, language: "", usdPerMinute: 0.005 },
  llm: [
    { name: "moss", baseUrl: "https://api.mosi.cn/v1", model: "nex-n2.6", apiKey: "" },
    { name: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-flash", apiKey: "", extra: { thinking: { type: "disabled" } } },
  ],
};

export function normalize(s: Partial<Settings> & Record<string, unknown>): Settings {
  const legacyConn = s.appConnection as string | undefined;
  return {
    ...DEFAULTS,
    ...s,
    // "app" was always a deliberate choice; "standalone" was the old default, so it becomes Auto
    // unless the user picked it on the Settings page.
    appConnection: legacyConn === "app" ? "app" : legacyConn === "standalone" && s.connectionChosen ? "standalone" : "auto",
    service: (["local", "cloud", "custom"] as const).includes(s.service as ServiceEnv) ? (s.service as ServiceEnv) : DEFAULTS.service,
    textSource: (["auto", "asr", "captions"] as const).includes(s.textSource as TextSource) ? (s.textSource as TextSource) : DEFAULTS.textSource,
    asr: { ...DEFAULTS.asr, ...(s.asr || {}) },
    llm: s.llm?.length ? s.llm : DEFAULTS.llm,
  };
}

export async function loadSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get("settings");
  return normalize((settings || {}) as Partial<Settings> & Record<string, unknown>);
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ settings: s });
}

export const SERVICE_LABEL: Record<ServiceEnv, string> = {
  local: "Local Mac service",
  cloud: "Multicorder Cloud",
  custom: "Your own API keys",
};
