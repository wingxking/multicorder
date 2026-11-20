// Development builds only (`pnpm dev`): follows the watch build's number on 127.0.0.1:35830.
// Pages refresh in place when only page code changed; the service worker reloads the whole
// extension when worker code or the manifest changed, after any tab recording has ended.

declare const __MC_DEV__: boolean;

const DEV_SERVER = "http://127.0.0.1:35830/build";

type Build = { id: number; full: boolean };

async function next(since: number): Promise<Build | null> {
  try {
    const response = await fetch(`${DEV_SERVER}?since=${since}`, { cache: "no-store" });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/** Long-polls the dev server; `onBuild` runs for every build newer than the one at start. */
function follow(onBuild: (build: Build) => void) {
  if (typeof __MC_DEV__ === "undefined" || !__MC_DEV__) return;
  let current = 0;
  const loop = async () => {
    for (;;) {
      const build = await next(current);
      if (!build) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        continue;
      }
      if (current && build.id !== current) onBuild(build);
      current = build.id;
    }
  };
  void loop();
}

/** For extension pages (side panel, options, library). */
export function devReloadPage() {
  follow((build) => {
    if (build.full) void chrome.runtime.sendMessage({ type: "dev-reload" }).catch(() => {});
    else location.reload();
  });
}

/** For the service worker: reloads the extension, waiting while any tab is being recorded. */
export function devReloadWorker(recording: () => Promise<boolean>) {
  if (typeof __MC_DEV__ === "undefined" || !__MC_DEV__) return;
  let waiting = false;
  const reload = async () => {
    if (waiting) return;
    waiting = true;
    while (await recording()) {
      await chrome.action.setBadgeText({ text: "↻" }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    chrome.runtime.reload();
  };
  follow((build) => { if (build.full) void reload(); });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "dev-reload") void reload();
  });
}
