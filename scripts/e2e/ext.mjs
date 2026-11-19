// Helpers for tests that drive the real extension in Chrome for Testing.
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { OUT } from "./common.mjs";

export const ROOT = new URL("../../", import.meta.url).pathname;
export const EXT = join(ROOT, "apps/extension/dist");
export const EXT_ID = "ileogemoijmhcnkcbanfaiolhdhoffbj";
const CHROME = process.env.E2E_CHROME || join(process.env.HOME, "Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");

/** Serves test-output/*.wav with CORS for the offscreen <audio> element. */
export async function audioServer() {
  const server = createServer((req, res) => {
    const f = join(OUT, (req.url || "/").split("?")[0]);
    if (!existsSync(f) || !f.endsWith(".wav")) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": "audio/wav", "Access-Control-Allow-Origin": "*" }).end(readFileSync(f));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/** Fresh Chrome profile with the extension; `dataDir` installs the native host pointing at that mcd. */
export async function launch(name, { dataDir, colorScheme } = {}) {
  const profile = join(OUT, name);
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  if (dataDir) {
    mkdirSync(join(profile, "NativeMessagingHosts"), { recursive: true });
    writeFileSync(
      join(profile, "NativeMessagingHosts/com.multicorder.host.json"),
      JSON.stringify({ name: "com.multicorder.host", description: "Multicorder test host", path: join(ROOT, "target/debug/multicorder-host"), type: "stdio", allowed_origins: [`chrome-extension://${EXT_ID}/`] }),
    );
  }
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: CHROME,
    headless: !process.env.E2E_HEADED,
    colorScheme,
    viewport: { width: 420, height: 900 },
    locale: "en-US",
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
    env: { ...process.env, ...(dataDir ? { MC_DATA_DIR: dataDir } : {}) },
  });
  if (!ctx.serviceWorkers().some((w) => w.url().includes(EXT_ID))) await ctx.waitForEvent("serviceworker", { timeout: 15_000 });
  return ctx;
}

export const msg = (page, m) => page.evaluate((m) => chrome.runtime.sendMessage(m), m);

export const setSettings = (page, s) => page.evaluate((s) => chrome.storage.local.set({ settings: s }), s);

/** One session's data straight from the extension's IndexedDB and OPFS. */
export const readSession = (page, id) =>
  page.evaluate(async (id) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("multicorder");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const get = (store, fn) =>
      new Promise((res) => {
        if (!db.objectStoreNames.contains(store)) return res(null);
        const req = fn(db.transaction(store).objectStore(store));
        req.onsuccess = () => res(req.result);
      });
    const session = await get("sessions", (s) => s.get(id));
    const transcript = (await get("transcripts", (s) => s.index("sessionId").getAll(id))) || [];
    const insights = (await get("insights", (s) => s.index("session_id").getAll(id))) || [];
    const report = await get("reports", (s) => s.get(id));
    const pending = (await get("pending", (s) => s.index("sessionId").getAll(id))) || [];
    let recordingBytes = 0;
    try {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("rec");
      recordingBytes = (await (await dir.getFileHandle(`${id}.webm`)).getFile()).size;
    } catch {}
    db.close();
    return { session, transcript, insights, report, pending, recordingBytes };
  }, id);

/** Polls until `pred(value)` holds, returning the last value. */
export async function until(fn, pred, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** Settings object as the extension stores it. */
export function settings(patch) {
  return {
    appConnection: "standalone",
    service: "local",
    cloudUrl: "https://multicoder.followkol.live",
    cloudToken: "",
    defaultMode: "live",
    silentCapture: true,
    outputLang: "zh",
    asr: { provider: "moss", protocol: "moss", baseUrl: "https://api.mosi.cn/v1", model: "moss-transcribe-diarize-pro", apiKey: "", segmented: true, language: "", usdPerMinute: 0.005 },
    llm: [{ name: "moss", baseUrl: "https://api.mosi.cn/v1", model: "nex-n2.6", apiKey: "" }],
    ...patch,
  };
}

/** Same checks for every in-browser recording: own words only, evidence valid, report, audio. */
export function check(r, expect, forbid, label) {
  const text = r.transcript.map((s) => s.text).join(" ");
  const ids = new Set(r.transcript.map((s) => s.id));
  const problems = [];
  if (!r.transcript.length) problems.push("empty transcript");
  if (!new RegExp(expect, "i").test(text)) problems.push(`missing /${expect}/`);
  if (new RegExp(forbid, "i").test(text)) problems.push(`CROSS-TALK /${forbid}/`);
  if (!r.insights.length) problems.push("no insights");
  for (const i of r.insights) for (const e of i.evidence) if (!ids.has(e.event_id)) problems.push("foreign evidence");
  if (!r.report?.body) problems.push("no report");
  if (r.recordingBytes < 10_000) problems.push(`recording too small (${r.recordingBytes} B)`);
  if (r.pending.length) problems.push(`${r.pending.length} chunk(s) still pending`);
  return { label, ok: !problems.length, problems, audio_ms: r.session?.audio_ms, recording_bytes: r.recordingBytes, transcript_sample: text.slice(0, 160), insights: r.insights.map((i) => `${i.state}: ${i.text}`).slice(0, 4), report_head: r.report?.body?.slice(0, 200) };
}
