import React, { useEffect, useState } from "react";
import { Icon, t, WAITING_FOR_AUDIO } from "@multicorder/ui";
import { AUDIO_START_DB } from "./protocol";

type SourceStatus = { status: string; levelDb?: number };
type RecordingTabs = Record<string, { sessionId: string }>;

export function TabSources({ recordings, onNotice }: { recordings: Record<string, SourceStatus>; onNotice: (message: string) => void }) {
  const [tabs, setTabs] = useState<chrome.tabs.Tab[]>([]);
  const [recordingTabs, setRecordingTabs] = useState<RecordingTabs>({});
  const [windowId, setWindowId] = useState<number>();

  useEffect(() => {
    let mounted = true;
    let query = 0;
    const refresh = () => {
      const latest = ++query;
      void chrome.tabs.query({}).then((found) => {
        if (mounted && latest === query) setTabs(found.filter((tab) => tab.id !== undefined && /^https?:|^file:/.test(tab.url ?? "")));
      }).catch(console.error);
    };
    const tabChanged: Parameters<typeof chrome.tabs.onUpdated.addListener>[0] = (_id, change) => {
      if (change.audible !== undefined || change.mutedInfo || change.title || change.url) refresh();
    };
    const storageChanged: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (changes, area) => {
      if (area === "session" && changes.tabs) setRecordingTabs(changes.tabs.newValue ?? {});
    };
    chrome.storage.onChanged.addListener(storageChanged);
    void chrome.storage.session.get("tabs").then(({ tabs }) => { if (mounted) setRecordingTabs(tabs ?? {}); });
    void chrome.windows.getCurrent().then((win) => { if (mounted) setWindowId(win.id); });
    chrome.tabs.onUpdated.addListener(tabChanged);
    const changes = [chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onActivated, chrome.tabs.onAttached];
    changes.forEach((event) => event.addListener(refresh));
    refresh();
    return () => {
      mounted = false;
      chrome.tabs.onUpdated.removeListener(tabChanged);
      chrome.storage.onChanged.removeListener(storageChanged);
      changes.forEach((event) => event.removeListener(refresh));
    };
  }, []);

  async function select(tab: chrome.tabs.Tab) {
    if (tab.id === undefined) return;
    try {
      if (!tab.active || tab.windowId !== windowId) {
        await chrome.tabs.update(tab.id, { active: true });
        if (tab.windowId !== windowId) await chrome.windows.update(tab.windowId, { focused: true });
        onNotice(t("Click the pinned Multicorder toolbar icon to record this tab."));
        return;
      }
      const result = await chrome.runtime.sendMessage({ type: "start-current", tabId: tab.id });
      if (result?.error) onNotice(/grant|permission|has not been invoked|activeTab/i.test(result.error)
        ? t("Click the pinned Multicorder toolbar icon to give Chrome permission to record this tab.")
        : result.error);
    } catch (error) {
      onNotice(String(error));
    }
  }

  const sources = tabs.map((tab) => {
    const capture = recordingTabs[String(tab.id)];
    const recording = capture && recordings[capture.sessionId];
    const playing = recording?.levelDb === undefined
      ? Boolean(tab.audible && !tab.mutedInfo?.muted)
      : recording.levelDb >= AUDIO_START_DB;
    return { tab, capture, recording, playing };
  });
  const playing = sources.filter((source) => source.playing);
  const idle = sources.filter((source) => !source.playing);
  const row = ({ tab, capture, recording, playing }: typeof sources[number]) => {
    const current = tab.active && tab.windowId === windowId;
    const action = current ? (playing ? t("Record") : t("Arm")) : t("Open tab");
    const title = tab.title || t("Browser tab");
    return (
      <li key={tab.id} className={playing ? undefined : "audio-idle"}>
        <span className={`audio-dot ${playing ? "on" : ""}`} aria-hidden />
        {tab.favIconUrl && /^https?:|^data:/.test(tab.favIconUrl) ? <img className="tab-fav" src={tab.favIconUrl} alt="" /> : null}
        <span className="tab-name" title={title}>{title}</span>
        {capture ? <span className={`chip ${recording?.status === "waiting" ? "info" : "rec"}`}>{recording?.status !== "waiting" && <span className="dot" />}{recording?.status === "waiting" ? t("Waiting") : t("Rec")}</span> : (
          <button className={`btn btn-sm ${playing ? "btn-audible" : ""}`} aria-label={`${action} ${title}`} title={current && !playing ? t(WAITING_FOR_AUDIO) : undefined} onClick={() => void select(tab)}>
            <Icon name={current ? "record" : "tab"} size={13} />{action}
          </button>
        )}
      </li>
    );
  };
  return (
    <section className="tab-sources" aria-label={t("Browser tabs")}>
      <h3>{t("Playing now")}</h3>
      {playing.length ? <ul>{playing.map(row)}</ul> : <p className="small muted">{t("No tab is playing audio.")}</p>}
      {idle.length > 0 && <><h3>{t("No sound detected")}</h3><ul>{idle.map(row)}</ul></>}
    </section>
  );
}
