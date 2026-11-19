// D-1: four sources at the same time on one Mac — two apps recorded by Multicorder.app through
// Core Audio process taps, and two browser tabs recorded by the extension on its own, using the
// same Multicorder.app as its local transcription and summary service. Each recording must
// contain only its own planted words.
// Needs Multicorder.app running with MC_DATA_DIR=$MC_APP_DATA (default test-output/data-app) and
// the System Audio Recording permission (see docs/implementation-plan.md §4).
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, OUT, pairing, sleep, verify, waitFinished } from "./common.mjs";
import { audioServer, check, EXT_ID, launch, msg, readSession, setSettings, settings, until } from "./ext.mjs";

const DATA = process.env.MC_APP_DATA || join(OUT, "data-app");
const p = pairing(DATA);
const labels = { a: "com.multicorder.e2e.a", b: "com.multicorder.e2e.b" };
const sh = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8" });
  } catch {
    return "";
  }
};
const cleanup = () => Object.values(labels).forEach((l) => sh("launchctl", ["remove", l]));
const ALL = { a: "falcon", b: "斑马", c: "orchid", d: "长颈鹿" };
const others = (k) => Object.entries(ALL).filter(([x]) => x !== k).map(([, w]) => w).join("|");

cleanup();
const server = await audioServer();
const result = { test: "D-1 two apps + two tabs at once", steps: {} };
let ctx;
try {
  ctx = await launch("chrome-profile-multi", { dataDir: DATA });
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${EXT_ID}/sidepanel.html`);
  await setSettings(panel, settings({ service: "local" }));
  result.steps.service = await msg(panel, { type: "service-health" });

  // Two apps start playing, each gets its own tap.
  for (const [k, label] of Object.entries(labels)) sh("launchctl", ["submit", "-l", label, "--", "/usr/bin/afplay", "-v", "0.35", `${OUT}${k}.wav`]);
  await sleep(600);
  const pidOf = (label) => Number((sh("launchctl", ["list", label]).match(/"PID" = (\d+)/) || [])[1]);
  const apps = await api(p, "/v1/apps");
  const appA = apps.find((x) => x.pids.includes(pidOf(labels.a)));
  const appB = apps.find((x) => x.pids.includes(pidOf(labels.b)));
  if (!appA || !appB || appA.app_id === appB.app_id) throw new Error("players were not listed as separate apps");
  const [sa, sb] = await Promise.all([
    api(p, "/v1/sessions", { method: "POST", body: JSON.stringify({ source: { kind: "mac_app", app_id: appA.app_id }, summary_mode: "live", title: "APP A · Falcon" }) }),
    api(p, "/v1/sessions", { method: "POST", body: JSON.stringify({ source: { kind: "mac_app", app_id: appB.app_id }, summary_mode: "after", title: "APP B · 斑马" }) }),
  ]);
  // Two tabs at the same moment, recorded and kept in the browser.
  const [tc, td] = await Promise.all([
    msg(panel, { type: "test-start-element", audioUrl: `${server.base}/c.wav`, url: "https://example.com/orchid", title: "TAB C · Orchid", tabId: 401, mode: "live" }),
    msg(panel, { type: "test-start-element", audioUrl: `${server.base}/d.wav`, url: "https://example.com/giraffe", title: "TAB D · 长颈鹿", tabId: 402, mode: "after" }),
  ]);
  if (tc?.backend !== "local" || td?.backend !== "local") throw new Error(`tabs not recorded in the browser: ${JSON.stringify({ tc, td })}`);
  await sleep(5000);
  result.steps.concurrent = {
    app_sessions_active: (await api(p, "/v1/sessions?status=active")).length,
    tab_sessions_active: (await msg(panel, { type: "list" }))?.sessions?.length ?? null,
  };
  await panel.reload();
  await sleep(1500);
  await panel.screenshot({ path: join(OUT, "ui-multi-source.png"), fullPage: true });

  await sleep(18_000);
  cleanup();
  await sleep(1500);
  for (const s of [sa, sb]) await api(p, `/v1/sessions/${s.session.id}/stop`, { method: "POST" }).catch(() => {});
  await Promise.all([waitFinished(p, sa.session.id), waitFinished(p, sb.session.id)]);
  const done = (r) => r.session?.status === "stopped" && !!r.report?.body;
  const rc = await until(() => readSession(panel, tc.sessionId), done, 240_000, "tab C");
  const rd = await until(() => readSession(panel, td.sessionId), done, 240_000, "tab D");
  result.results = [
    await verify(p, sa.session.id, { expect: ALL.a, forbid: others("a"), label: "app A (English, live)" }),
    await verify(p, sb.session.id, { expect: ALL.b, forbid: others("b"), label: "app B (Chinese, after)" }),
    check(rc, ALL.c, others("c"), "tab C (English, live, in browser)"),
    check(rd, ALL.d, others("d"), "tab D (Chinese, after, in browser)"),
  ];
  if (result.results.slice(0, 2).every((r) => r.problems.includes("empty transcript"))) result.hint = "App taps delivered no speech: grant System Audio Recording to Multicorder.app.";
  result.ok = result.results.every((r) => r.ok);
} catch (e) {
  result.error = String(e?.stack || e);
  result.ok = false;
} finally {
  cleanup();
  await ctx?.close().catch(() => {});
  server.close();
}
writeFileSync(OUT + "e2e-multi-source.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
