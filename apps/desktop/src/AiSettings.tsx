// Settings for who transcribes and summarizes recordings: the Multicorder service (default) or
// providers called directly with the user's own keys, plus developer options for the service address.
// Keys are write-only here: the backend only says whether one is saved.

import React, { useEffect, useState } from "react";
import { t, tError } from "@multicorder/ui";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export interface AiSettingsState {
  mode: "service" | "custom";
  env: "cloud" | "local";
  local_url: string;
  cloud_url: string;
  service_url: string;
  token_set: boolean;
  asr: { provider: string; protocol: "moss" | "openai"; base_url: string; model: string; language: string; key_set: boolean };
  llm: { provider: string; base_url: string; model: string; key_set: boolean };
}

type Preset = { id: string; label: string; base_url: string; models: string[]; protocol?: "moss" | "openai" };

const ASR_PRESETS: Preset[] = [
  { id: "moss", label: "MOSS", protocol: "moss", base_url: "https://api.mosi.cn/v1", models: ["moss-transcribe-diarize-pro"] },
  { id: "openai", label: "OpenAI", protocol: "openai", base_url: "https://api.openai.com/v1", models: ["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"] },
  { id: "groq", label: "Groq", protocol: "openai", base_url: "https://api.groq.com/openai/v1", models: ["whisper-large-v3-turbo", "whisper-large-v3"] },
  { id: "custom", label: "OpenAI-compatible", protocol: "openai", base_url: "", models: [] },
];

const LLM_PRESETS: Preset[] = [
  { id: "moss", label: "MOSS", base_url: "https://api.mosi.cn/v1", models: ["nex-n2.6"] },
  { id: "deepseek", label: "DeepSeek", base_url: "https://api.deepseek.com", models: ["deepseek-chat", "deepseek-reasoner"] },
  { id: "openai", label: "OpenAI", base_url: "https://api.openai.com/v1", models: ["gpt-4.1-mini", "gpt-4o-mini", "gpt-4.1"] },
  { id: "zhipu", label: "Zhipu GLM", base_url: "https://open.bigmodel.cn/api/paas/v4", models: ["glm-4-flash", "glm-4-plus"] },
  { id: "groq", label: "Groq", base_url: "https://api.groq.com/openai/v1", models: ["llama-3.3-70b-versatile"] },
  { id: "custom", label: "OpenAI-compatible", base_url: "", models: [] },
];

const presetOf = (presets: Preset[], id: string) => presets.find((p) => p.id === id) ?? presets[presets.length - 1];

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return <label className="ai-field"><span>{label}</span>{children}{hint && <small className="muted">{hint}</small>}</label>;
}

function KeyInput({ saved, value, onChange, label }: { saved: boolean; value: string | null; onChange: (value: string | null) => void; label: string }) {
  return (
    <Field label={label} hint={saved && value === null ? t("A key is saved. Type a new one to replace it.") : undefined}>
      <input className="input" type="password" autoComplete="off" spellCheck={false} value={value ?? ""}
        placeholder={saved ? "••••••••" : t("Paste your API key")} onChange={(e) => onChange(e.target.value || null)} />
    </Field>
  );
}

function ProviderFields({ kind, presets, provider, setProvider, base, setBase, model, setModel }: {
  kind: string; presets: Preset[]; provider: string; setProvider: (id: string) => void; base: string; setBase: (v: string) => void; model: string; setModel: (v: string) => void;
}) {
  const preset = presetOf(presets, provider);
  const listId = `${kind}-models`;
  return <>
    <Field label={t("Provider")}>
      <select className="input" value={preset.id} onChange={(e) => setProvider(e.target.value)}>
        {presets.map((p) => <option key={p.id} value={p.id}>{p.id === "custom" ? t(p.label) : p.label}</option>)}
      </select>
    </Field>
    <Field label={t("Model")}>
      <input className="input" list={listId} value={model} spellCheck={false} onChange={(e) => setModel(e.target.value)} />
      <datalist id={listId}>{preset.models.map((m) => <option key={m} value={m} />)}</datalist>
    </Field>
    <Field label={t("API address")}>
      <input className="input mono" value={base} spellCheck={false} placeholder="https://…/v1" onChange={(e) => setBase(e.target.value)} />
    </Field>
  </>;
}

export function AiSettings({ invoke, onSaved, flash }: { invoke: Invoke; onSaved: () => void; flash: (text: string) => void }) {
  const [saved, setSaved] = useState<AiSettingsState | null>(null);
  const [form, setForm] = useState<AiSettingsState | null>(null);
  const [asrKey, setAsrKey] = useState<string | null>(null);
  const [llmKey, setLlmKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void invoke<AiSettingsState>("ai_settings").then((value) => { setSaved(value); setForm(value); }).catch((e) => setError(tError(e)));
  }, [invoke]);

  async function save(next: AiSettingsState, extra: { token?: string | null } = {}) {
    setBusy(true);
    setError(null);
    try {
      const result = await invoke<AiSettingsState>("save_ai_settings", { settings: {
        mode: next.mode, env: next.env, local_url: next.local_url, token: extra.token ?? null,
        asr: { provider: next.asr.provider, protocol: next.asr.protocol, base_url: next.asr.base_url, model: next.asr.model, language: next.asr.language, api_key: asrKey },
        llm: { provider: next.llm.provider, base_url: next.llm.base_url, model: next.llm.model, api_key: llmKey },
      } });
      setSaved(result);
      setForm(result);
      setAsrKey(null);
      setLlmKey(null);
      onSaved();
      flash(t("Settings saved."));
      return true;
    } catch (e) {
      setError(tError(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!form || !saved) return error ? <p className="banner warn" role="alert">{error}</p> : <p className="small muted">{t("Loading…")}</p>;
  const set = (patch: Partial<AiSettingsState>) => setForm({ ...form, ...patch });
  const setAsr = (patch: Partial<AiSettingsState["asr"]>) => setForm({ ...form, asr: { ...form.asr, ...patch } });
  const setLlm = (patch: Partial<AiSettingsState["llm"]>) => setForm({ ...form, llm: { ...form.llm, ...patch } });
  const customDirty = JSON.stringify([form.mode, form.asr, form.llm]) !== JSON.stringify([saved.mode, saved.asr, saved.llm]) || asrKey !== null || llmKey !== null;
  const serviceHost = (() => { try { return new URL(saved.service_url).host; } catch { return saved.service_url; } })();

  return (
    <div className="ai-settings">
      <div className="pref-row">
        <span>{t("Transcription and summaries by")}</span>
        <div className="seg" role="group" aria-label={t("Transcription and summaries by")}>
          <button aria-pressed={form.mode === "service"} disabled={busy} onClick={() => {
            // Nothing else to fill in for the service: switch at once.
            if (saved.mode === "service") set({ mode: "service" });
            else void save({ ...saved, mode: "service" });
          }}>{t("Multicorder service")}</button>
          <button aria-pressed={form.mode === "custom"} disabled={busy} onClick={() => set({ mode: "custom" })}>{t("My own API keys")}</button>
        </div>
      </div>
      {form.mode === "service" ? (
        <p className="small muted ai-note">{t("Recordings are transcribed and summarized by the Multicorder service ({host}). Nothing to set up.", { host: serviceHost })}</p>
      ) : <>
        <p className="small muted ai-note">{t("This Mac calls your providers directly with your keys; the Multicorder service is not used. Keys stay in config.json in the data folder on this Mac.")}</p>
        <fieldset className="ai-group">
          <legend>{t("Transcription")}</legend>
          <ProviderFields kind="asr" presets={ASR_PRESETS} provider={form.asr.provider}
            setProvider={(id) => { const p = presetOf(ASR_PRESETS, id); setAsr({ provider: id, protocol: p.protocol ?? "openai", base_url: p.base_url, model: p.models[0] ?? "" }); }}
            base={form.asr.base_url} setBase={(base_url) => setAsr({ base_url })} model={form.asr.model} setModel={(model) => setAsr({ model })} />
          {form.asr.provider === "custom" && <Field label={t("Protocol")}>
            <select className="input" value={form.asr.protocol} onChange={(e) => setAsr({ protocol: e.target.value as "moss" | "openai" })}>
              <option value="openai">{t("OpenAI-compatible")}</option><option value="moss">MOSS</option>
            </select>
          </Field>}
          <KeyInput label={t("API key")} saved={saved.asr.key_set && saved.asr.provider === form.asr.provider} value={asrKey} onChange={setAsrKey} />
        </fieldset>
        <fieldset className="ai-group">
          <legend>{t("Summaries")}</legend>
          <ProviderFields kind="llm" presets={LLM_PRESETS} provider={form.llm.provider}
            setProvider={(id) => { const p = presetOf(LLM_PRESETS, id); setLlm({ provider: id, base_url: p.base_url, model: p.models[0] ?? "" }); }}
            base={form.llm.base_url} setBase={(base_url) => setLlm({ base_url })} model={form.llm.model} setModel={(model) => setLlm({ model })} />
          <KeyInput label={t("API key")} saved={saved.llm.key_set && saved.llm.provider === form.llm.provider} value={llmKey} onChange={setLlmKey} />
        </fieldset>
        <div className="ai-actions">
          {customDirty && <button className="btn" disabled={busy} onClick={() => { setForm(saved); setAsrKey(null); setLlmKey(null); setError(null); }}>{t("Cancel")}</button>}
          <button className="btn btn-primary" disabled={busy || !customDirty} onClick={() => void save(form)}>{busy ? t("Saving…") : t("Save")}</button>
        </div>
      </>}
      {error && <p className="banner warn" role="alert">{error}</p>}
    </div>
  );
}

/** Developer options: which Multicorder service address the app uses. */
export function ServiceDevOptions({ invoke, onSaved, flash }: { invoke: Invoke; onSaved: () => void; flash: (text: string) => void }) {
  const [saved, setSaved] = useState<AiSettingsState | null>(null);
  const [env, setEnv] = useState<"cloud" | "local">("cloud");
  const [localUrl, setLocalUrl] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = (value: AiSettingsState) => { setSaved(value); setEnv(value.env); setLocalUrl(value.local_url); setToken(null); };
  useEffect(() => { void invoke<AiSettingsState>("ai_settings").then(load).catch((e) => setError(tError(e))); }, [invoke]);
  if (!saved) return null;
  const dirty = env !== saved.env || localUrl.trim() !== saved.local_url || token !== null;
  async function save() {
    if (!saved) return;
    setBusy(true);
    setError(null);
    try {
      load(await invoke<AiSettingsState>("save_ai_settings", { settings: {
        mode: saved.mode, env, local_url: localUrl, token,
        asr: { ...saved.asr, api_key: null }, llm: { ...saved.llm, api_key: null },
      } }));
      onSaved();
      flash(t("Settings saved."));
    } catch (e) {
      setError(tError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ai-settings">
      <div className="pref-row">
        <span>{t("Service API")}</span>
        <div className="seg" role="group" aria-label={t("Service API")}>
          <button aria-pressed={env === "cloud"} onClick={() => setEnv("cloud")}>{t("Online")}</button>
          <button aria-pressed={env === "local"} onClick={() => setEnv("local")}>{t("Local")}</button>
        </div>
      </div>
      {env === "cloud"
        ? <Field label={t("Online address")}><input className="input mono" value={saved.cloud_url} readOnly /></Field>
        : <Field label={t("Local service prefix")} hint={t("Address of a Multicorder service you run for development, for example http://127.0.0.1:8787.")}>
            <input className="input mono" value={localUrl} spellCheck={false} onChange={(e) => setLocalUrl(e.target.value)} />
          </Field>}
      <Field label={t("Service token")} hint={saved.token_set && token === null ? t("A token is saved. Type a new one to replace it.") : t("Only needed if the service asks for one.")}>
        <input className="input" type="password" autoComplete="off" value={token ?? ""} placeholder={saved.token_set ? "••••••••" : ""} onChange={(e) => setToken(e.target.value || null)} />
      </Field>
      {saved.mode === "custom" && <p className="small muted ai-note">{t("You are using your own API keys, so this address is not used right now.")}</p>}
      {error && <p className="banner warn" role="alert">{error}</p>}
      <div className="ai-actions">
        {dirty && <button className="btn" disabled={busy} onClick={() => load(saved)}>{t("Cancel")}</button>}
        <button className="btn btn-primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? t("Saving…") : t("Save")}</button>
      </div>
    </div>
  );
}

export const AI_SETTINGS_CSS = `
.ai-settings{display:grid;gap:10px}
.ai-note{margin:0}
.ai-group{border:1px solid var(--border);border-radius:var(--radius-md);padding:10px 12px 12px;margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:10px}
.ai-group legend{padding:0 4px;font-size:12px;font-weight:600;color:var(--text-2)}
.ai-field{display:grid;gap:4px;font-size:12px;color:var(--text-2);min-width:0}
.ai-field small{font-size:11px}
.ai-field .input{width:100%}
.input.mono{font-family:var(--mono);font-size:12px}
.ai-actions{display:flex;justify-content:flex-end;gap:6px}
.dev-options>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:6px;margin:10px 0 4px}
.dev-options>summary::-webkit-details-marker{display:none}
.dev-options>summary h3{margin:0}
.dev-options>summary::before{content:"›";display:inline-block;color:var(--text-3);transition:transform .12s}
.dev-options[open]>summary::before{transform:rotate(90deg)}
.dev-options>.ai-settings{margin-top:6px}
`;
