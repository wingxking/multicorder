// A-3: two separate processes play different speeches at the same time; each is recorded through
// its own Core Audio process tap and must transcribe only its own words.
// The players are started by launchd so macOS attributes each to itself, not to the terminal.
// Needs the "System Audio Recording" permission for the app that runs mcd; without it the taps
// deliver silence and the test reports it.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { api, OUT, pairing, sleep, verify, waitFinished } from "./common.mjs";

const p = pairing();
const labels = { a: "com.multicorder.e2e.a", b: "com.multicorder.e2e.b" };
const sh = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8" });
  } catch {
    return "";
  }
};
const cleanup = () => Object.values(labels).forEach((l) => sh("launchctl", ["remove", l]));
cleanup();
const result = { test: "A-3 app taps", steps: {} };
try {
  for (const [k, label] of Object.entries(labels)) {
    sh("launchctl", ["submit", "-l", label, "--", "/usr/bin/afplay", "-v", "0.35", `${OUT}${k}.wav`]);
  }
  await sleep(700);
  const pidOf = (label) => Number((sh("launchctl", ["list", label]).match(/"PID" = (\d+)/) || [])[1]);
  const pids = { a: pidOf(labels.a), b: pidOf(labels.b) };
  result.steps.pids = pids;
  const apps = await api(p, "/v1/apps");
  const find = (pid) => apps.find((x) => x.pids.includes(pid));
  const appA = find(pids.a);
  const appB = find(pids.b);
  result.steps.apps = [appA, appB].map((x) => x && { app_id: x.app_id, name: x.name, pids: x.pids, emitting: x.is_emitting });
  if (!appA || !appB || appA.app_id === appB.app_id) throw new Error("players were not listed as separate apps");
  const sa = await api(p, "/v1/sessions", { method: "POST", body: JSON.stringify({ source: { kind: "mac_app", app_id: appA.app_id }, summary_mode: "live", title: "APP A · Falcon (afplay)" }) });
  const sb = await api(p, "/v1/sessions", { method: "POST", body: JSON.stringify({ source: { kind: "mac_app", app_id: appB.app_id }, summary_mode: "after", title: "APP B · 斑马 (afplay)" }) });
  result.steps.sessions = [sa.session.id, sb.session.id];
  // Let both finish playing (~23 s), then stop before launchd restarts them.
  await sleep(23_000);
  cleanup();
  await sleep(2000);
  for (const s of [sa, sb]) await api(p, `/v1/sessions/${s.session.id}/stop`, { method: "POST" }).catch(() => {});
  const fa = await waitFinished(p, sa.session.id);
  const fb = await waitFinished(p, sb.session.id);
  result.steps.audio_ms = { a: fa.session.audio_ms, b: fb.session.audio_ms };
  result.steps.gaps = { a: fa.gaps, b: fb.gaps };
  result.results = [
    await verify(p, sa.session.id, { expect: "falcon", forbid: "斑马", label: "app A (English)" }),
    await verify(p, sb.session.id, { expect: "斑马", forbid: "falcon", label: "app B (Chinese)" }),
  ];
  if (result.results.every((r) => r.problems.includes("empty transcript"))) {
    result.hint = "Both taps delivered no speech: grant System Audio Recording to the app that runs mcd (System Settings → Privacy & Security → Screen & System Audio Recording).";
  }
  result.ok = result.results.every((r) => r.ok);
} catch (e) {
  result.error = String(e?.stack || e);
  result.ok = false;
} finally {
  cleanup();
}
writeFileSync(OUT + "e2e-app-tap.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
