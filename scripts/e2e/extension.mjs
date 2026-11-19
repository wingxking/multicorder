// A-4: the real extension in Chrome for Testing. Two recordings run at once through the
// offscreen document → AudioWorklet (48 k → 16 k) → WebSocket → engine path, paired through the
// native messaging host. Audio comes from local test pages served over HTTP.
//
// Starting a capture with chrome.tabCapture needs a user click on the toolbar icon (activeTab),
// which automation cannot give; the test therefore uses the extension's test hook that feeds an
// <audio> element through the same worklet and WebSocket, and separately checks that
// getMediaStreamId is correctly refused without that click.
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { api, OUT, pairing, sleep, verify, waitFinished } from "./common.mjs";

const ROOT = new URL("../../", import.meta.url).pathname;
const EXT = join(ROOT, "apps/extension/dist");
const EXT_ID = "ileogemoijmhcnkcbanfaiolhdhoffbj";
const CHROME = process.env.E2E_CHROME || join(process.env.HOME, "Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
const p = pairing();

// Local audio server with CORS for the offscreen <audio> element.
const server = createServer((req, res) => {
  const f = join(OUT, (req.url || "/").split("?")[0]);
  if (!existsSync(f) || !f.endsWith(".wav")) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": "audio/wav", "Access-Control-Allow-Origin": "*" }).end(readFileSync(f));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const audioBase = `http://127.0.0.1:${server.address().port}`;

// Native messaging host manifest in this profile's folder.
const profile = join(OUT, "chrome-profile");
mkdirSync(join(profile, "NativeMessagingHosts"), { recursive: true });
writeFileSync(
  join(profile, "NativeMessagingHosts/com.multicorder.host.json"),
  JSON.stringify({ name: "com.multicorder.host", description: "Multicorder test host", path: join(ROOT, "target/debug/multicorder-host"), type: "stdio", allowed_origins: [`chrome-extension://${EXT_ID}/`] }),
);

const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME,
  headless: process.env.E2E_HEADED ? false : true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  env: { ...process.env, MC_DATA_DIR: process.env.MC_DATA_DIR },
});
const result = { test: "A-4 extension", steps: {} };
try {
  let sw = ctx.serviceWorkers().find((w) => w.url().includes(EXT_ID));
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15_000 });
  result.steps.service_worker = sw.url();
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${EXT_ID}/sidepanel.html`);
  // Pairing through the native host.
  const pair = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "pairing" }));
  result.steps.paired = !!pair?.pairing && pair.pairing.port === p.port;
  // Without a toolbar click, tab capture must be refused (activeTab rule).
  const page = await ctx.newPage();
  await page.setContent("<title>plain page</title><p>hello</p>");
  result.steps.capture_without_click = await panel
    .evaluate(
      () =>
        new Promise((resolve) =>
          chrome.tabs.query({ title: "plain page" }, ([tab]) =>
            chrome.tabCapture.getMediaStreamId({ targetTabId: tab?.id }, (id) => resolve(id ? "granted (unexpected)" : `refused: ${chrome.runtime.lastError?.message}`)),
          ),
        ),
    )
    .catch((e) => `refused (threw): ${e.message.split("\n")[0]}`);
  // Two concurrent recordings through offscreen → worklet → WebSocket.
  const startA = await panel.evaluate((u) => chrome.runtime.sendMessage({ type: "test-start-element", audioUrl: u + "/a.wav", url: "https://www.youtube.com/watch?v=ext-e2e", title: "EXT A · Falcon", tabId: 101 }), audioBase);
  const startB = await panel.evaluate((u) => chrome.runtime.sendMessage({ type: "test-start-element", audioUrl: u + "/b.wav", url: "https://example.com/zebra", title: "EXT B · 斑马", tabId: 102 }), audioBase);
  if (!startA?.sessionId || !startB?.sessionId) throw new Error(`start failed: ${JSON.stringify({ startA, startB })}`);
  result.steps.sessions = [startA.sessionId, startB.sessionId];
  await sleep(4000);
  result.steps.offscreen_live = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "list" }));
  await panel.screenshot({ path: join(OUT, "sidepanel-recording.png") });
  const fa = await waitFinished(p, startA.sessionId, 400_000);
  const fb = await waitFinished(p, startB.sessionId, 400_000);
  result.steps.audio_ms = { a: fa.session.audio_ms, b: fb.session.audio_ms };
  result.steps.gaps = { a: fa.gaps, b: fb.gaps };
  await panel.reload();
  await sleep(2500);
  await panel.screenshot({ path: join(OUT, "sidepanel-finished.png"), fullPage: true });
  result.results = [
    await verify(p, startA.sessionId, { expect: "falcon", forbid: "斑马", label: "extension A (English)" }),
    await verify(p, startB.sessionId, { expect: "斑马", forbid: "falcon", label: "extension B (Chinese)" }),
  ];
  result.ok = result.steps.paired && result.results.every((r) => r.ok) && String(result.steps.capture_without_click).startsWith("refused");
} catch (e) {
  result.error = String(e?.stack || e);
  result.ok = false;
} finally {
  await ctx.close();
  server.close();
}
writeFileSync(OUT + "e2e-extension.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
