// Share a short-lived inventory with the paired desktop app. Only a Chrome gesture starts capture.
import { programTitle } from "@multicorder/ui/src/title";
import type { SummaryMode } from "./local/settings";

export interface DesktopPairing {
  port: number;
  token: string;
  browser?: string | null;
}

interface Intent {
  tab_id: number;
  mode: SummaryMode;
  mute_playback: boolean;
  expires: number;
}

const HEARTBEAT_MS = 15000;
const ALARM = "multicorder-browser-sources";
const labelCache = new Map<number, { url?: string; title?: string; label: string }>();
let publish = () => {};

let identity: Promise<string> | undefined;
export function browserClientId() {
  identity ??= (async () => {
    const stored = (await chrome.storage.session.get("sourceClient")).sourceClient as string | undefined;
    if (stored) return stored;
    const id = crypto.randomUUID();
    await chrome.storage.session.set({ sourceClient: id });
    return id;
  })();
  return identity;
}

export async function desktopIntent(tabId: number): Promise<Intent | undefined> {
  const key = `desktopIntent:${tabId}`;
  const request = (await chrome.storage.session.get(key))[key] as Intent | undefined;
  if (request && request.expires > Date.now()) return request;
  if (request) await chrome.storage.session.remove(key);
}

export function clearDesktopIntent(tabId: number) {
  return chrome.storage.session.remove(`desktopIntent:${tabId}`);
}

export async function recordingLabel(tab: chrome.tabs.Tab): Promise<string | undefined> {
  if (tab.id === undefined) return tab.title;
  let channel: string | undefined;
  try {
    // Scripting is available on a page after the user invokes the extension on it.
    if (/^https?:/.test(tab.url ?? "")) {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const explicitAuthor = document.querySelector<HTMLMetaElement>('meta[name="author"], meta[property="music:musician"]')?.content;
          const channel = document.querySelector('#owner ytd-channel-name a, yt-video-owner-renderer ytd-channel-name a, .up-info-container .up-name, .up-info-container .username')?.textContent;
          const artist = navigator.mediaSession?.metadata?.artist;
          return (channel || artist || explicitAuthor || "").trim().slice(0, 100);
        },
      });
      channel = result?.result;
    }
  } catch {
    // Use tab metadata if Chrome has no scripting grant or the page is restricted.
  }
  let site: string | undefined;
  try { site = new URL(tab.url ?? "").hostname; } catch { /* no site */ }
  const title = tab.title ? programTitle(tab.title, site) : undefined;
  const label = channel && title && !title.includes(channel) ? `${channel} · ${title}` : title || channel;
  if (label) {
    labelCache.set(tab.id, { url: tab.url, title: tab.title, label });
    publish();
  }
  return label;
}

function eligible(tab: chrome.tabs.Tab): boolean {
  return tab.id !== undefined && !tab.incognito && /^(https?|file):/.test(tab.url ?? "");
}

export function startDesktopSourceSync(pair: () => Promise<DesktopPairing | null>) {
  let socket: WebSocket | undefined;
  let connecting = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let update: ReturnType<typeof setTimeout> | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;
  let backoff = 1500;

  async function send(connection: WebSocket, pairing: DesktopPairing) {
    const request = ++sequence;
    try {
      const [client_id, tabs, storage] = await Promise.all([browserClientId(), chrome.tabs.query({}), chrome.storage.session.get("tabs")]);
      if (request !== sequence || connection.readyState !== WebSocket.OPEN) return;
      const snapshot = tabs.filter(eligible).sort((a, b) => a.windowId - b.windowId || a.index - b.index).slice(0, 500).map((tab) => {
        const id = tab.id!;
        const cached = labelCache.get(id);
        const label = cached && cached.title === tab.title && cached.url === tab.url ? cached.label : tab.title;
        return {
          id,
          title: label?.slice(0, 240) ?? "",
          site: new URL(tab.url!).hostname.slice(0, 100),
          audible: !!tab.audible && !tab.mutedInfo?.muted,
          standalone_recording: storage.tabs?.[id]?.backend === "local",
        };
      });
      connection.send(JSON.stringify({ client_id, browser: pairing.browser ?? null, tabs: snapshot }));
    } catch {
      // The heartbeat retries when Chrome is ready to enumerate tabs.
    }
  }

  async function focus(data: string) {
    const request = JSON.parse(data) as Omit<Intent, "expires">;
    if (!Number.isSafeInteger(request.tab_id) || !["off", "live", "after"].includes(request.mode) || typeof request.mute_playback !== "boolean") return;
    const tab = await chrome.tabs.get(request.tab_id);
    if (!eligible(tab)) return;
    const key = `desktopIntent:${request.tab_id}`;
    await chrome.storage.session.set({ [key]: { ...request, expires: Date.now() + 120000 } });
    try {
      await chrome.tabs.update(request.tab_id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch {
      await clearDesktopIntent(request.tab_id);
    }
  }

  async function connect() {
    if (connecting || (socket && socket.readyState < WebSocket.CLOSING)) return;
    connecting = true;
    try {
      const pairing = await pair();
      if (!pairing) return;
      const connection = new WebSocket(`ws://127.0.0.1:${pairing.port}/v1/browser-sources`, ["mc.v1", pairing.token]);
      socket = connection;
      connection.onopen = () => {
        backoff = 1500;
        void send(connection, pairing);
        heartbeat = setInterval(() => void send(connection, pairing), HEARTBEAT_MS);
      };
      connection.onmessage = ({ data }) => {
        if (typeof data === "string") void focus(data).catch(() => {});
      };
      connection.onerror = () => connection.close();
      connection.onclose = () => {
        if (socket !== connection) return;
        clearInterval(heartbeat);
        socket = undefined;
        clearTimeout(reconnect);
        reconnect = setTimeout(() => void connect(), backoff);
        backoff = Math.min(backoff * 2, 30000);
      };
      publish = () => {
        if (connection.readyState !== WebSocket.OPEN) {
          void connect();
          return;
        }
        clearTimeout(update);
        update = setTimeout(() => void send(connection, pairing), 150);
      };
    } finally {
      connecting = false;
    }
  }

  publish = () => void connect();
  const changed = () => publish();
  chrome.tabs.onCreated.addListener(changed);
  chrome.tabs.onRemoved.addListener((id) => {
    labelCache.delete(id);
    void clearDesktopIntent(id);
    changed();
  });
  chrome.tabs.onAttached.addListener(changed);
  chrome.tabs.onMoved.addListener(changed);
  chrome.tabs.onUpdated.addListener((_tab, change) => {
    if (change.audible !== undefined || change.mutedInfo || change.title !== undefined || change.url !== undefined) changed();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.tabs) changed();
  });
  chrome.windows.onFocusChanged.addListener(changed);
  chrome.runtime.onStartup.addListener(changed);
  chrome.runtime.onInstalled.addListener(changed);
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) changed();
  });
  // A sleeping service worker must discover a desktop app started while Chrome is idle.
  void chrome.alarms.get(ALARM).then((alarm) => {
    if (!alarm) return chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  }).catch(() => {});
  changed();
}
