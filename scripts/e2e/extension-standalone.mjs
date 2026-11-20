// B-6: the extension on its own — no native host, no Mac app. Two recordings at once through the
// offscreen worklet into the built-in engine (OPFS recording, cloud ASR, key points, report in
// IndexedDB), with real keys set through the extension's own settings.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { OUT } from "./common.mjs";
import { audioServer, check, EXT_ID, launch, msg, readSession, setSettings, settings } from "./ext.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = await audioServer();
const audioBase = server.base;
// A fresh profile with NO native messaging host: the extension cannot reach any Mac app.
const ctx = await launch("chrome-profile-standalone");

const result = { test: "B-6 extension standalone", steps: {} };
try {
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${EXT_ID}/sidepanel.html`);
  // Own keys ("custom" service) through the extension's settings storage (keys from the test env).
  await setSettings(
    panel,
    settings({
      service: "custom",
      asr: { provider: "moss", protocol: "moss", baseUrl: "https://api.mosi.cn/v1", model: "moss-transcribe-diarize-pro", apiKey: process.env.MOSS_API_KEY, segmented: true, language: "", usdPerMinute: 0.005 },
      llm: [
        { name: "moss", baseUrl: "https://api.mosi.cn/v1", model: "nex-n2.6", apiKey: process.env.MOSS_API_KEY },
      ],
    }),
  );
  const pairing = await msg(panel, { type: "pairing" });
  result.steps.no_app = pairing?.pairing === null;
  const a = await panel.evaluate((u) => chrome.runtime.sendMessage({ type: "test-start-element", audioUrl: u + "/a.wav", url: "https://www.youtube.com/watch?v=standalone-a", title: "SOLO A · Falcon (live)", tabId: 201, mode: "live" }), audioBase);
  const b = await panel.evaluate((u) => chrome.runtime.sendMessage({ type: "test-start-element", audioUrl: u + "/b.wav", url: "https://example.com/zebra", title: "SOLO B · 斑马 (after)", tabId: 202, mode: "after" }), audioBase);
  result.steps.started = { a, b };
  if (a?.backend !== "local" || b?.backend !== "local" || !a.sessionId || !b.sessionId) throw new Error(`expected local backend: ${JSON.stringify({ a, b })}`);
  await sleep(5000);
  result.steps.offscreen_live = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "list" }));
  await panel.screenshot({ path: join(OUT, "standalone-recording.png") });
  const t0 = Date.now();
  let ra, rb;
  for (;;) {
    ra = await readSession(panel, a.sessionId);
    rb = await readSession(panel, b.sessionId);
    if (ra.session?.status === "stopped" && rb.session?.status === "stopped") break;
    if (Date.now() - t0 > 300_000) throw new Error(`timeout: ${ra.session?.status} / ${rb.session?.status}`);
    await sleep(2000);
  }
  result.results = [check(ra, "falcon", "斑马", "standalone A (live, English)"), check(rb, "斑马", "falcon", "standalone B (after, Chinese)")];
  const lib = await ctx.newPage();
  await lib.goto(`chrome-extension://${EXT_ID}/library.html`);
  await sleep(1000);
  await lib.screenshot({ path: join(OUT, "standalone-library.png"), fullPage: true });
  await panel.reload();
  await sleep(1500);
  await panel.screenshot({ path: join(OUT, "standalone-sidepanel.png"), fullPage: true });
  result.ok = result.steps.no_app && result.results.every((r) => r.ok);
} catch (e) {
  result.error = String(e?.stack || e);
  result.ok = false;
} finally {
  await ctx.close();
  server.close();
}
writeFileSync(OUT + "e2e-extension-standalone.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
