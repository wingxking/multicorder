// Screenshots of the extension pages (side panel, library, settings, onboarding) in light/dark and
// English/Chinese, failing on page errors. Needs a built extension (pnpm --filter @multicorder/extension build).
import { join } from "node:path";
import { OUT } from "./common.mjs";
import { EXT_ID, launch } from "./ext.mjs";

const shots = [];
const errors = [];
for (const colorScheme of ["light", "dark"]) {
  const ctx = await launch(`ui-ext-${colorScheme}`, { colorScheme });
  try {
    for (const lang of ["en", "zh"]) {
      for (const [page, width] of [["sidepanel", 420], ["library", 1180], ["options", 1000], ["onboarding", 900]]) {
        const tab = await ctx.newPage();
        tab.on("pageerror", (e) => errors.push(`${page}: ${e}`));
        await tab.setViewportSize({ width, height: 800 });
        await tab.goto(`chrome-extension://${EXT_ID}/${page}.html`);
        await tab.evaluate((l) => localStorage.setItem("mc-lang", l), lang);
        await tab.reload();
        await tab.locator("#root > *").first().waitFor();
        await tab.waitForTimeout(400);
        const path = join(OUT, `ui-ext-${page}-${colorScheme}-${lang}.png`);
        await tab.screenshot({ path, fullPage: page === "options" || page === "onboarding" });
        shots.push(path);
        await tab.close();
      }
    }
  } finally {
    await ctx.close();
  }
}
console.log(JSON.stringify({ shots, errors, ok: errors.length === 0 }, null, 2));
process.exit(errors.length ? 1 : 0);
