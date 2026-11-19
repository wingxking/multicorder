// Extension settings (chrome.storage.local). Keys stay in this browser profile, are only read by
// extension pages and the service worker, and are never logged.

export type AppConnection = "standalone" | "app";
export type ServiceEnv = "local" | "cloud" | "custom";
export type SummaryMode = "off" | "live" | "after";

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
  /** Which transcription + summary service the in-browser engine calls. */
  service: ServiceEnv;
  cloudUrl: string;
  cloudToken: string;
  defaultMode: SummaryMode;
  silentCapture: boolean;
  outputLang: string;
  /** Only used when service = "custom". */
  asr: AsrSettings;
  llm: LlmProvider[];
}

export const DEFAULTS: Settings = {
  appConnection: "standalone",
  service: "local",
  cloudUrl: CLOUD_URL,
  cloudToken: "",
  defaultMode: "live",
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
    appConnection: legacyConn === "app" ? "app" : "standalone",
    service: (["local", "cloud", "custom"] as const).includes(s.service as ServiceEnv) ? (s.service as ServiceEnv) : DEFAULTS.service,
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
