// Service worker: entry points, pairing, getMediaStreamId, session routing (design 5.2–5.3).
// It keeps no state of its own: live state is in the offscreen document and chrome.storage.session.

import { isWhitelisted, OffscreenMsg, OffscreenSession } from "./protocol";

const HOST = "com.multicorder.host";

interface Pairing {
  port: number;
  token: string;
}

async function nativeAsk(msg: object): Promise<any> {
  return chrome.runtime.sendNativeMessage(HOST, msg);
}

/** Port and token from the running app, cached for this browser session. */
async function ensurePaired(): Promise<Pairing | null> {
  const cached = (await chrome.storage.session.get("pairing")).pairing as Pairing | undefined;
  if (cached && (await healthy(cached))) return cached;
  try {
    let reply = await nativeAsk({ type: "pair" });
    if (reply?.status === "app_not_running") {
      await nativeAsk({ type: "launch_app" });
      reply = await nativeAsk({ type: "pair" });
    }
    if (reply?.type === "paired" && reply.port && reply.token) {
      const p = { port: reply.port, token: reply.token };
      await chrome.storage.session.set({ pairing: p });
      return p;
    }
  } catch (e) {
    console.warn("native host unavailable", e);
  }
  return null;
}

async function healthy(p: Pairing): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${p.port}/v1/status`, { headers: { Authorization: `Bearer ${p.token}` } });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: "Capture the audio of tabs the user chose to record",
  });
}

async function toOffscreen<T = unknown>(msg: OffscreenMsg): Promise<T> {
  return chrome.runtime.sendMessage(msg);
}

async function sessionsByTab(): Promise<Record<string, string>> {
  return ((await chrome.storage.session.get("tabs")).tabs as Record<string, string>) || {};
}

async function setTab(tabId: number, sessionId: string | null) {
  const tabs = await sessionsByTab();
  if (sessionId) tabs[tabId] = sessionId;
  else delete tabs[tabId];
  await chrome.storage.session.set({ tabs });
  const n = Object.keys(tabs).length;
  await chrome.action.setBadgeText({ text: n ? String(n) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#d9482e" });
}

async function defaultMode(): Promise<string> {
  return ((await chrome.storage.local.get("defaultMode")).defaultMode as string) || "live";
}

async function createSession(p: Pairing, tab: chrome.tabs.Tab): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${p.port}/v1/sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${p.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ source: { kind: "chromium_tab", tab_id: tab.id, url: tab.url, title: tab.title }, summary_mode: await defaultMode() }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body.session.id;
}

async function injectClock(tab: chrome.tabs.Tab) {
  if (tab.id === undefined || !isWhitelisted(tab.url)) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["media-clock.js"] });
  } catch (e) {
    console.debug("media clock not injected", e);
  }
}

/** Entry for the toolbar icon, keyboard shortcut and context menu (each grants activeTab). */
async function startOrOpen(tab: chrome.tabs.Tab | undefined) {
  if (!tab?.id) return;
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  const existing = (await sessionsByTab())[tab.id];
  if (existing) return;
  const pairing = await ensurePaired();
  if (!pairing) {
    await chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
    return;
  }
  const already = await new Promise<chrome.tabCapture.CaptureInfo[]>((r) => chrome.tabCapture.getCapturedTabs(r));
  if (already.some((t) => t.tabId === tab.id && t.status !== "stopped" && t.status !== "error")) return;
  // The stream id is single-use and expires within seconds: get it last, then use it at once.
  const streamId = await new Promise<string>((resolve, reject) =>
    chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => (id ? resolve(id) : reject(new Error(chrome.runtime.lastError?.message || "no stream id")))),
  );
  await ensureOffscreen();
  const sessionId = await createSession(pairing, tab);
  await toOffscreen({ target: "offscreen", type: "start", sessionId, streamId, tabId: tab.id, port: pairing.port, token: pairing.token });
  await setTab(tab.id, sessionId);
  await injectClock(tab);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "mc-record", title: "Record this tab with Multicorder", contexts: ["page", "video", "audio"] });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
});

chrome.action.onClicked.addListener((tab) => void startOrOpen(tab).catch((e) => console.error(e)));
chrome.commands.onCommand.addListener((cmd, tab) => {
  if (cmd === "toggle-capture") void startOrOpen(tab).catch((e) => console.error(e));
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "mc-record") void startOrOpen(tab).catch((e) => console.error(e));
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if ((await sessionsByTab())[tabId]) {
    await toOffscreen({ target: "offscreen", type: "stop", tabId, reason: "tab_closed" }).catch(() => {});
    await setTab(tabId, null);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!(await sessionsByTab())[tabId]) return;
  if (info.url || info.title) {
    await toOffscreen({ target: "offscreen", type: "navigation", tabId, url: tab.url, title: tab.title }).catch(() => {});
  }
  if (info.status === "complete") await injectClock(tab);
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.target === "offscreen") return false;
  (async () => {
    switch (msg?.type) {
      case "media_mark":
        if (sender.tab?.id !== undefined) await toOffscreen({ target: "offscreen", type: "mark", tabId: sender.tab.id, mark: msg.mark });
        return { ok: true };
      case "pairing":
        return { pairing: await ensurePaired() };
      case "start-current": {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        await startOrOpen(tab);
        return { ok: true };
      }
      case "stop": {
        await toOffscreen({ target: "offscreen", type: "stop", sessionId: msg.sessionId, reason: "user" });
        const tabs = await sessionsByTab();
        const entry = Object.entries(tabs).find(([, s]) => s === msg.sessionId);
        if (entry) await setTab(Number(entry[0]), null);
        return { ok: true };
      }
      case "mute":
        return toOffscreen({ target: "offscreen", type: "mute", sessionId: msg.sessionId, muted: msg.muted });
      case "list":
        try {
          return { sessions: await toOffscreen<OffscreenSession[]>({ target: "offscreen", type: "list" }) };
        } catch {
          return { sessions: [] };
        }
      case "offscreen-ended": {
        if (msg.tabId !== undefined) await setTab(msg.tabId, null);
        return { ok: true };
      }
      // Test hook: plays a local audio file inside the offscreen document through the same
      // worklet → WebSocket path. Only extension pages can send runtime messages here.
      case "test-start-element": {
        const pairing = await ensurePaired();
        if (!pairing) return { error: "not paired" };
        await ensureOffscreen();
        const tab = { id: msg.tabId ?? -1, url: msg.url, title: msg.title } as chrome.tabs.Tab;
        const sessionId = await createSession(pairing, tab);
        await toOffscreen({ target: "offscreen", type: "start-element", sessionId, audioUrl: msg.audioUrl, tabId: tab.id!, port: pairing.port, token: pairing.token });
        return { sessionId };
      }
      default:
        return { error: "unknown message" };
    }
  })().then(reply, (e) => reply({ error: String(e) }));
  return true;
});
