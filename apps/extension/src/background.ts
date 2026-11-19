// Service worker: entry points, backend choice (standalone or the Mac app), pairing,
// getMediaStreamId, routing. It keeps no state of its own (design 5.2–5.3, 5.11).

import * as db from "./local/db";
import type { Target } from "./local/providers";
import { loadSettings, Settings } from "./local/settings";
import { isWhitelisted, OffscreenMsg, OffscreenSession } from "./protocol";

const HOST = "com.multicorder.host";

interface Pairing {
  port: number;
  token: string;
  browser?: string | null;
}

async function nativeAsk(msg: object): Promise<any> {
  return chrome.runtime.sendNativeMessage(HOST, msg);
}

async function healthy(p: Pairing): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${p.port}/v1/status`, { headers: { Authorization: `Bearer ${p.token}` } });
    return r.ok;
  } catch {
    return false;
  }
}

/** Port, token and browser identity from the running Mac app. `launch` opens the app if needed. */
async function ensurePaired(launch: boolean): Promise<Pairing | null> {
  const cached = (await chrome.storage.session.get("pairing")).pairing as Pairing | undefined;
  if (cached && (await healthy(cached))) return cached;
  try {
    let reply = await nativeAsk({ type: "pair" });
    if (reply?.status === "app_not_running" && launch) {
      await nativeAsk({ type: "launch_app" });
      reply = await nativeAsk({ type: "pair" });
    }
    if (reply?.type === "paired" && reply.port && reply.token) {
      const p = { port: reply.port, token: reply.token, browser: reply.browser_bundle_id ?? null };
      await chrome.storage.session.set({ pairing: p });
      return p;
    }
  } catch {
    // Host not installed: standalone.
  }
  await chrome.storage.session.remove("pairing");
  return null;
}

/** Which backend a new recording uses: the in-browser engine (default) or the Mac app. */
async function chooseBackend(): Promise<{ backend: "local" | "app"; pairing: Pairing | null } | null> {
  const s = await loadSettings();
  if (s.appConnection === "standalone") return { backend: "local", pairing: null };
  const pairing = await ensurePaired(true);
  return pairing ? { backend: "app", pairing } : null;
}

/** Transcription + summary service for the in-browser engine (setting "service"). */
async function resolveService(s: Settings): Promise<Target> {
  if (s.service === "custom") return { kind: "custom", asr: s.asr, llm: s.llm };
  if (s.service === "cloud") return { kind: "service", env: "cloud", base: s.cloudUrl.replace(/\/+$/, ""), token: s.cloudToken };
  const p = await ensurePaired(false);
  if (!p) throw new Error("The local Mac service is not running");
  return { kind: "service", env: "local", base: `http://127.0.0.1:${p.port}`, token: p.token };
}

async function serviceHealth(): Promise<{ env: string; ok: boolean; detail: string }> {
  const s = await loadSettings();
  if (s.service === "custom") return { env: "custom", ok: !!s.asr.apiKey, detail: s.asr.apiKey ? `${s.asr.provider} · ${s.asr.model}` : "No API key set" };
  try {
    const t = await resolveService(s);
    if (t.kind !== "service") return { env: s.service, ok: true, detail: "" };
    const r = await fetch(`${t.base}/v1/health`, { signal: AbortSignal.timeout(4000) });
    return { env: s.service, ok: r.ok, detail: r.ok ? new URL(t.base).host : `HTTP ${r.status}` };
  } catch (e) {
    return { env: s.service, ok: false, detail: s.service === "cloud" ? `${new URL(s.cloudUrl).host} is not reachable` : String((e as Error).message) };
  }
}

/** Restarts background retries after a browser restart if any transcription is still missing. */
async function resumeRetries() {
  try {
    const pend = await db.pending();
    const sessions = await db.listSessions();
    await Promise.all(sessions.filter((s) => s.status === "waiting").map((s) => db.patchSession(s.id, { status: "stopped", failure: "no_audio", ended_at: new Date().toISOString() })));
    if (pend.length || sessions.some((x) => x.report_pending)) {
      await ensureOffscreen();
      await toOffscreen({ target: "offscreen", type: "local-retry-all" }).catch(() => {});
    }
  } catch {
    /* nothing to resume */
  }
}

let startingOffscreen: Promise<void> | null = null;

function ensureOffscreen(): Promise<void> {
  startingOffscreen ??= (async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
    if (contexts.length) return;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: "Capture and record the audio of tabs the user chose to record",
    });
  })().finally(() => { startingOffscreen = null; });
  return startingOffscreen;
}

async function toOffscreen<T = any>(msg: OffscreenMsg): Promise<T> {
  return chrome.runtime.sendMessage(msg);
}

interface TabEntry {
  sessionId: string;
  backend: "local" | "app";
}

async function tabsMap(): Promise<Record<string, TabEntry>> {
  return ((await chrome.storage.session.get("tabs")).tabs as Record<string, TabEntry>) || {};
}

let tabUpdates = Promise.resolve();
function setTab(tabId: number, entry: TabEntry | null) {
  const update = tabUpdates.then(async () => {
    const tabs = await tabsMap();
    if (entry) tabs[tabId] = entry;
    else delete tabs[tabId];
    await chrome.storage.session.set({ tabs });
    const n = Object.keys(tabs).length;
    await chrome.action.setBadgeText({ text: n ? String(n) : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#d9482e" });
  });
  tabUpdates = update.catch(console.error);
  return update;
}

/** App backend: create the session; keep any duplicate-recording warning for the side panel. */
async function createAppSession(p: Pairing, tab: { id?: number; url?: string; title?: string }, mode: string, waitForAudio: boolean): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${p.port}/v1/sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${p.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ source: { kind: "chromium_tab", tab_id: tab.id, url: tab.url, title: tab.title, browser: p.browser ?? null }, summary_mode: mode, wait_for_audio: waitForAudio }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  const warnings = (body.warnings || []) as { code: string; session_id: string }[];
  if (warnings.length) {
    const stored = ((await chrome.storage.session.get("warnings")).warnings as any[]) || [];
    for (const w of warnings) stored.push({ ...w, tabSessionId: body.session.id, at: Date.now() });
    await chrome.storage.session.set({ warnings: stored });
  }
  return body.session.id;
}

async function injectClock(tab: chrome.tabs.Tab) {
  if (tab.id === undefined || !isWhitelisted(tab.url)) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["media-clock.js"] });
  } catch {
    /* page not scriptable */
  }
}

/** Entry for the toolbar icon, keyboard shortcut and context menu (each grants activeTab). */
async function startOrOpen(tab: chrome.tabs.Tab | undefined) {
  if (!tab?.id) return;
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  if ((await tabsMap())[tab.id]) return;
  const choice = await chooseBackend();
  if (!choice) {
    await chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
    return;
  }
  const settings = await loadSettings();
  const already = await new Promise<chrome.tabCapture.CaptureInfo[]>((r) => chrome.tabCapture.getCapturedTabs(r));
  if (already.some((t) => t.tabId === tab.id && t.status !== "stopped" && t.status !== "error")) return;
  await ensureOffscreen();
  // The stream id is single-use and expires within seconds: get it last, then use it at once.
  const streamId = await new Promise<string>((resolve, reject) =>
    chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => (id ? resolve(id) : reject(new Error(chrome.runtime.lastError?.message || "no stream id")))),
  );
  const waitForAudio = !tab.audible || Boolean(tab.mutedInfo?.muted);
  const common = { tabId: tab.id, title: tab.title, url: tab.url, mode: settings.defaultMode, muted: settings.silentCapture, waitForAudio, settings };
  const p = choice.pairing;
  const id = p ? await createAppSession(p, tab, settings.defaultMode, waitForAudio) : undefined;
  try {
    const result = await toOffscreen<{ sessionId?: string; error?: string }>({
      target: "offscreen", type: "start", streamId, backend: choice.backend, sessionId: id, port: p?.port, token: p?.token, ...common,
    });
    if (!result?.sessionId) throw new Error(result?.error ?? "Could not start tab capture");
    await setTab(tab.id, { sessionId: result.sessionId, backend: choice.backend });
  } catch (error) {
    if (p && id) {
      await fetch(`http://127.0.0.1:${p.port}/v1/sessions/${id}/stop`, { method: "POST", headers: { Authorization: `Bearer ${p.token}` } }).catch(() => {});
    }
    throw error;
  }
  await injectClock(tab);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "mc-record", title: chrome.i18n.getMessage("menuRecord") || "Record this tab with Multicorder", contexts: ["page", "video", "audio"] });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  void resumeRetries();
});
chrome.runtime.onStartup.addListener(() => void resumeRetries());

chrome.action.onClicked.addListener((tab) => void startOrOpen(tab).catch((e) => console.error(e)));
chrome.commands.onCommand.addListener((cmd, tab) => {
  if (cmd === "toggle-capture") void startOrOpen(tab).catch((e) => console.error(e));
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "mc-record") void startOrOpen(tab).catch((e) => console.error(e));
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if ((await tabsMap())[tabId]) {
    await toOffscreen({ target: "offscreen", type: "stop", tabId, reason: "tab_closed" }).catch(() => {});
    await setTab(tabId, null);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!(await tabsMap())[tabId]) return;
  if (info.url || info.title) await toOffscreen({ target: "offscreen", type: "navigation", tabId, url: tab.url, title: tab.title }).catch(() => {});
  if (info.status === "complete") await injectClock(tab);
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.target === "offscreen" || msg?.type === "local-event") return false;
  (async () => {
    switch (msg?.type) {
      case "media_mark":
        if (sender.tab?.id !== undefined) await toOffscreen({ target: "offscreen", type: "mark", tabId: sender.tab.id, mark: msg.mark });
        return { ok: true };
      case "pairing": {
        const s = await loadSettings();
        return { pairing: await ensurePaired(false), appConnection: s.appConnection, service: s.service };
      }
      case "resolve-service": {
        const s = await loadSettings();
        try {
          return { target: await resolveService(s), settings: s };
        } catch (e) {
          return { error: String((e as Error).message) };
        }
      }
      case "service-health":
        return serviceHealth();
      case "local-retry":
      case "local-flush": {
        await ensureOffscreen();
        return toOffscreen({ target: "offscreen", type: msg.type, sessionId: msg.sessionId });
      }
      case "start-current": {
        const tab = msg.tabId === undefined
          ? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
          : await chrome.tabs.get(msg.tabId);
        if (!tab?.active) return { error: "Activate this tab before recording" };
        await startOrOpen(tab);
        return { ok: true };
      }
      case "stop": {
        await toOffscreen({ target: "offscreen", type: "stop", sessionId: msg.sessionId, reason: "user" }).catch(() => {});
        const entry = Object.entries(await tabsMap()).find(([, e]) => e.sessionId === msg.sessionId);
        if (entry) await setTab(Number(entry[0]), null);
        return { ok: true };
      }
      case "local-mode":
        return toOffscreen({ target: "offscreen", type: "local-mode", sessionId: msg.sessionId, mode: msg.mode });
      case "local-missed":
        await ensureOffscreen();
        return toOffscreen({ target: "offscreen", type: "local-missed", sessionId: msg.sessionId, minutes: msg.minutes });
      case "mute":
        return toOffscreen({ target: "offscreen", type: "mute", sessionId: msg.sessionId, muted: msg.muted });
      case "list":
        try {
          return { sessions: await toOffscreen<OffscreenSession[]>({ target: "offscreen", type: "list" }) };
        } catch {
          return { sessions: [] };
        }
      case "offscreen-ended": {
        if (msg.tabId !== undefined && (await tabsMap())[msg.tabId]?.sessionId === msg.sessionId) await setTab(msg.tabId, null);
        return { ok: true };
      }
      // Test hook: plays a local audio file inside the offscreen document through the same
      // worklet path and the backend chosen by the settings. Only extension pages can call it.
      case "test-start-element": {
        const choice = await chooseBackend();
        if (!choice) return { error: "app required but not available" };
        await ensureOffscreen();
        const settings = await loadSettings();
        const common = { tabId: msg.tabId ?? -1, title: msg.title, url: msg.url, mode: msg.mode ?? settings.defaultMode, waitForAudio: msg.waitForAudio === true, settings };
        if (choice.backend === "app") {
          const id = await createAppSession(choice.pairing!, { id: msg.tabId, url: msg.url, title: msg.title }, common.mode, common.waitForAudio);
          return { ...(await toOffscreen({ target: "offscreen", type: "start-element", audioUrl: msg.audioUrl, backend: "app", sessionId: id, port: choice.pairing!.port, token: choice.pairing!.token, ...common })), backend: "app" };
        }
        return { ...(await toOffscreen({ target: "offscreen", type: "start-element", audioUrl: msg.audioUrl, backend: "local", ...common })), backend: "local" };
      }
      default:
        return { error: "unknown message" };
    }
  })().then(reply, (e) => reply({ error: String(e) }));
  return true;
});
