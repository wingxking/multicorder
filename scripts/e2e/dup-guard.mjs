// B-2: while the extension records tabs of a browser, recording that whole browser in the app is
// refused (409 duplicate_browser_tabs) and the app list marks the browser as tab_recording.
import { writeFileSync } from "node:fs";
import { OUT, pairing } from "./common.mjs";

const p = pairing();
const call = (path, init = {}) => fetch(p.base + path, { ...init, headers: { Authorization: `Bearer ${p.token}`, "Content-Type": "application/json" } });
const result = { test: "B-2 duplicate guard" };
const BROWSER = "com.google.Chrome";
const tab = await (await call("/v1/sessions", { method: "POST", body: JSON.stringify({ source: { kind: "chromium_tab", url: "https://example.com/dup", title: "DUP tab", browser: BROWSER }, summary_mode: "off" }) })).json();
result.tab_session = tab.session?.id;
const refused = await call("/v1/sessions", { method: "POST", body: JSON.stringify({ source: { kind: "mac_app", app_id: BROWSER }, summary_mode: "off" }) });
result.refused_status = refused.status;
result.refused_body = await refused.json();
const apps = await (await call("/v1/apps")).json();
const chrome = apps.find((a) => a.app_id === BROWSER);
result.chrome_listed = !!chrome;
result.chrome_tab_recording = chrome?.tab_recording ?? null;
await call(`/v1/sessions/${tab.session.id}/stop`, { method: "POST" });
result.ok = result.refused_status === 409 && result.refused_body.code === "duplicate_browser_tabs" && (!chrome || chrome.tab_recording === true);
writeFileSync(OUT + "e2e-dup-guard.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
