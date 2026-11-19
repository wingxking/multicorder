// A-2: two "tab" streams over the WebSocket protocol at once, one in live mode and one in
// after mode, with real ASR and model keys. Checks isolation, evidence, report, search, export.
import { writeFileSync } from "node:fs";
import { api, OUT, pairing, readWav, stream, verify, waitFinished } from "./common.mjs";

const p = pairing();
const a = await api(p, "/v1/sessions", { method: "POST", body: JSON.stringify({ source: { kind: "chromium_tab", url: "https://www.youtube.com/watch?v=e2etest", title: "E2E A · Falcon (live)" }, summary_mode: "live" }) });
const b = await api(p, "/v1/sessions", { method: "POST", body: JSON.stringify({ source: { kind: "chromium_tab", url: "https://example.com/zebra", title: "E2E B · 斑马 (after)" }, summary_mode: "after" }) });
const ida = a.session.id;
const idb = b.session.id;
console.log("sessions", ida, idb);
const started = Date.now();
const [ra, rb] = await Promise.all([stream(p, ida, readWav(OUT + "a.wav"), true), stream(p, idb, readWav(OUT + "b.wav"), false)]);
console.log("streamed", ra, rb);
const missedLive = await api(p, `/v1/sessions/${ida}/missed?minutes=5`).catch((e) => ({ error: String(e) }));
await api(p, `/v1/sessions/${ida}/stop`, { method: "POST" });
await api(p, `/v1/sessions/${idb}/stop`, { method: "POST" });
const fa = await waitFinished(p, ida);
const fb = await waitFinished(p, idb);
const results = [
  await verify(p, ida, { expect: "falcon", forbid: "斑马", label: "A tab live (English)" }),
  await verify(p, idb, { expect: "斑马", forbid: "falcon", label: "B tab after (Chinese)" }),
];
const search = await api(p, `/v1/search?q=${encodeURIComponent("斑马")}`);
const searchOk = search.length > 0 && search.every((h) => h.session_id === idb);
const srt = await fetch(`${p.base}/v1/sessions/${ida}/export?format=srt`, { headers: { Authorization: `Bearer ${p.token}` } }).then((r) => r.text());
const media = (await api(p, `/v1/sessions/${ida}/transcript`)).some((e) => e.media_start_ms !== null);
const summary = {
  test: "A-2 ws-two-tabs",
  seconds: Math.round((Date.now() - started) / 1000),
  results,
  search_isolated: searchOk,
  srt_ok: srt.includes("-->"),
  media_time_mapped: media,
  video_key: fa.session.video_key,
  gaps: { a: fa.gaps, b: fb.gaps },
  missed_live: missedLive,
  ok: results.every((r) => r.ok) && searchOk && srt.includes("-->"),
};
writeFileSync(OUT + "e2e-ws.json", JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);
