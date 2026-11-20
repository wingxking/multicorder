// C-1..C-4: the extension on its own, using the Mac's local service (mcd) as its transcription and
// summary API; a transcription outage and its recovery for both the extension engine and the
// Mac engine; the cloud service unreachable. Also captures the UI in light and dark mode.
// This test starts and restarts its own mcd (data in test-output/data-svc).
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, OUT, pairing, readWav, stream, verify, waitFinished } from "./common.mjs";
import { audioServer, check, EXT_ID, launch, msg, readSession, ROOT, setSettings, settings, until } from "./ext.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DATA = join(OUT, "data-svc");
const GOOD_KEY = process.env.MOSS_API_KEY;
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
copyFileSync(join(process.env.MC_DATA_DIR, "config.json"), join(DATA, "config.json"));

let mcd = null;
async function startMcd(asrKey, label) {
  rmSync(join(DATA, "run/api.json"), { force: true });
  const log = openSync(join(OUT, "mcd-svc.log"), "a");
  mcd = spawn(join(ROOT, "target/debug/mcd"), ["serve"], { env: { ...process.env, MC_DATA_DIR: DATA, MOSS_API_KEY: asrKey }, stdio: ["ignore", "ignore", log] });
  await until(async () => existsSync(join(DATA, "run/api.json")), Boolean, 15_000, `mcd (${label})`);
  await sleep(500);
  return pairing(DATA);
}
async function stopMcd() {
  if (!mcd) return;
  const p = new Promise((r) => mcd.once("exit", r));
  mcd.kill("SIGTERM");
  await p;
  mcd = null;
}

const server = await audioServer();
const result = { test: "C service switch + outage", steps: {}, results: [] };
const shots = [];
let ctx;
const start = (panel, file, key, title, tabId, mode) => msg(panel, { type: "test-start-element", audioUrl: `${server.base}/${file}`, url: `https://example.com/${key}`, title, tabId, mode });
const stopped = (panel, id) => until(() => readSession(panel, id), (r) => r.session?.status === "stopped", 300_000, `${id} stopped`);
const shot = async (page, name) => {
  const path = join(OUT, `ui-${name}.png`);
  await page.screenshot({ path, fullPage: true });
  shots.push(path);
};

try {
  // ---- C-1: local Mac service, healthy. The extension holds no keys at all.
  let p = await startMcd(GOOD_KEY, "good keys");
  ctx = await launch("chrome-profile-service", { dataDir: DATA });
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${EXT_ID}/sidepanel.html`);
  await setSettings(panel, settings({ service: "local" }));
  result.steps.local_health = await msg(panel, { type: "service-health" });
  const a = await start(panel, "a.wav", "local-a", "LOCAL A · Falcon (live)", 301, "live");
  const b = await start(panel, "b.wav", "local-b", "LOCAL B · 斑马 (after)", 302, "after");
  if (a?.backend !== "local" || b?.backend !== "local") throw new Error(`expected in-browser recordings: ${JSON.stringify({ a, b })}`);
  await sleep(6000);
  await panel.reload();
  await sleep(1500);
  await shot(panel, "sidepanel-recording-light");
  const [ra, rb] = [await stopped(panel, a.sessionId), await stopped(panel, b.sessionId)];
  result.results.push(check(ra, "falcon", "斑马", "C-1 local service A (live, English)"), check(rb, "斑马", "falcon", "C-1 local service B (after, Chinese)"));
  result.steps.mac_sessions_after_c1 = (await api(p, "/v1/sessions")).length; // recordings stay in the browser

  // ---- C-2: transcription outage (the Mac service's ASR key is rejected).
  await stopMcd();
  p = await startMcd("invalid-key-outage-test", "bad ASR key");
  const c = await start(panel, "a.wav", "out-c", "OUTAGE C · Falcon (live, retry button)", 303, "live");
  const d = await start(panel, "b.wav", "out-d", "OUTAGE D · 斑马 (after, automatic)", 304, "after");
  const mac = await api(p, "/v1/sessions", { method: "POST", body: JSON.stringify({ source: { kind: "chromium_tab", url: "https://example.com/mac", title: "OUTAGE MAC · Falcon (Mac engine)" }, summary_mode: "live" }) });
  const macId = mac.session.id;
  await stream(p, macId, readWav(OUT + "a.wav"));
  await api(p, `/v1/sessions/${macId}/stop`, { method: "POST" });
  const [rc, rd] = [await stopped(panel, c.sessionId), await stopped(panel, d.sessionId)];
  await waitFinished(p, macId);
  const macRow = await api(p, `/v1/sessions/${macId}`);
  const wav = await fetch(`${p.base}/v1/sessions/${macId}/audio`, { headers: { Authorization: `Bearer ${p.token}` } });
  const wavBytes = (await wav.arrayBuffer()).byteLength;
  const retryWhileDown = await msg(panel, { type: "local-retry", sessionId: c.sessionId });
  await panel.reload();
  await sleep(1500);
  const panelText = await panel.innerText("body");
  await shot(panel, "sidepanel-outage-light");
  result.steps.outage = {
    ext: [rc, rd].map((r) => ({ title: r.session.title, pending: r.pending.length, asr: r.session.asr, transcript: r.transcript.length, report_pending: !!r.session.report_pending, recording_bytes: r.recordingBytes })),
    mac: { asr: macRow.asr, audio_wav_bytes: wavBytes, audio_status: wav.status, audio_ms: macRow.session.audio_ms },
    retry_while_down: retryWhileDown,
    banner_shown: panelText.includes("Transcription unavailable"),
  };
  const o = result.steps.outage;
  result.results.push({
    label: "C-2 outage: recording kept, text marked missing, audio exportable",
    ok: o.ext.every((x) => x.pending > 0 && x.recording_bytes > 10_000 && x.transcript === 0 && x.asr?.failed_chunks > 0) && o.mac.asr?.failed_chunks > 0 && wav.status === 200 && wavBytes > 44 + 16000 * 2 * 10 && retryWhileDown?.remaining > 0 && o.banner_shown,
  });

  // ---- C-3: recovery. C via the card's Retry button, D and the Mac session automatically.
  await stopMcd();
  p = await startMcd(GOOD_KEY, "keys restored");
  await panel.reload();
  await sleep(1000);
  const card = panel.locator("section.mc-card", { hasText: "OUTAGE C" });
  await card.getByRole("button", { name: /^Retry/ }).click();
  const t0 = Date.now();
  const doneExt = (r) => r.pending.length === 0 && !!r.report?.body;
  const rc2 = await until(() => readSession(panel, c.sessionId), doneExt, 180_000, "C filled");
  result.steps.c_filled_after_s = Math.round((Date.now() - t0) / 1000);
  const rd2 = await until(() => readSession(panel, d.sessionId), doneExt, 180_000, "D filled automatically");
  result.steps.d_filled_after_s = Math.round((Date.now() - t0) / 1000);
  await until(() => api(p, `/v1/sessions/${macId}`), (s) => s.asr?.failed_chunks === 0, 180_000, "Mac session filled");
  // The report written during the outage says no speech was transcribed; wait for the regenerated one.
  await until(() => api(p, `/v1/sessions/${macId}/report`).catch(() => null), (r) => !!r?.body && !r.body.includes("No speech was transcribed"), 180_000, "Mac report regenerated");
  await until(() => api(p, `/v1/sessions/${macId}/insights`).catch(() => []), (i) => i.length > 0, 60_000, "Mac key points");
  result.steps.mac_filled_after_s = Math.round((Date.now() - t0) / 1000);
  result.results.push(check(rc2, "falcon", "斑马", "C-3 recovered by Retry button (C)"), check(rd2, "斑马", "falcon", "C-3 recovered automatically (D)"));
  result.results.push(await verify(p, macId, { expect: "falcon", forbid: "斑马", label: "C-3 Mac engine recovered automatically" }));
  await panel.reload();
  await sleep(1500);
  await shot(panel, "sidepanel-recovered-light");

  // ---- C-4: cloud selected but not deployed: shown as unavailable, recording still works.
  await setSettings(panel, settings({ service: "cloud", cloudToken: "test-token" }));
  result.steps.cloud_health = await msg(panel, { type: "service-health" });
  const e = await start(panel, "a.wav", "cloud-e", "CLOUD E · Falcon (cloud down)", 305, "live");
  const re = await stopped(panel, e.sessionId);
  result.steps.cloud = { pending: re.pending.length, recording_bytes: re.recordingBytes, last_error: re.session.last_error };
  result.results.push({ label: "C-4 cloud unreachable: error shown, recording kept", ok: result.steps.cloud_health?.ok === false && re.recordingBytes > 10_000 && re.pending.length > 0 });
  await panel.reload();
  await sleep(1500);
  await shot(panel, "sidepanel-cloud-down-light");

  // ---- UI review: every page in light and dark.
  await panel.emulateMedia({ colorScheme: "dark" });
  await shot(panel, "sidepanel-dark");
  for (const [page, w] of [["library.html", 1200], ["options.html", 900]]) {
    const pg = await ctx.newPage();
    await pg.setViewportSize({ width: w, height: 820 });
    await pg.goto(`chrome-extension://${EXT_ID}/${page}#${c.sessionId}`);
    await sleep(1200);
    for (const scheme of ["light", "dark"]) {
      await pg.emulateMedia({ colorScheme: scheme });
      await sleep(200);
      await shot(pg, `${page.split(".")[0]}-${scheme}`);
    }
    await pg.close();
  }
  await setSettings(panel, settings({ service: "local" }));
  result.ok = result.results.every((r) => r.ok);
} catch (err) {
  result.error = String(err?.stack || err);
  result.ok = false;
} finally {
  await ctx?.close().catch(() => {});
  await stopMcd();
  server.close();
}
result.screenshots = shots;
writeFileSync(OUT + "e2e-service-outage.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
