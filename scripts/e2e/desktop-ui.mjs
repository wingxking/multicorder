// Screenshots of the desktop UI on sample data (the UI falls back to mock data outside the app),
// every screen in light and dark, for visual review. Serves apps/desktop/dist (run its build first).
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";
import { OUT } from "./common.mjs";
import { ROOT } from "./ext.mjs";

const DIST = join(ROOT, "apps/desktop/dist");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
const server = createServer((req, res) => {
  let f = join(DIST, (req.url || "/").split("?")[0]);
  if (!existsSync(f) || f.endsWith("/")) f = join(DIST, "index.html");
  res.writeHead(200, { "Content-Type": TYPES[extname(f)] || "application/octet-stream" }).end(readFileSync(f));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const CHROME = process.env.E2E_CHROME || join(process.env.HOME, "Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const shots = [];
const errors = [];
try {
  // Every screen in light and dark, in English and Chinese (the UI follows the browser language by
  // default), plus a narrow window to check the collapsed sidebar.
  const TABS = {
    en: ["All sources", "Recording", "History", "Settings"],
    zh: ["全部音源", "录制中", "历史记录", "设置"],
  };
  const runs = [
    ...["light", "dark"].flatMap((scheme) => ["en", "zh"].map((lang) => ({ scheme, lang, width: 1180 }))),
    { scheme: "light", lang: "en", width: 760 },
  ];
  for (const { scheme, lang, width } of runs) {
    const page = await browser.newPage({ viewport: { width, height: 760 }, colorScheme: scheme, locale: lang === "zh" ? "zh-CN" : "en-US", deviceScaleFactor: 2 });
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.getByRole("navigation", { name: "Recording views" }).waitFor();
    for (const [index, tab] of TABS[lang].entries()) {
      await page.getByRole("button", { name: tab, exact: false }).first().click();
      if (index === 0) {
        await page.getByRole("button", { name: "Podcasts", exact: true }).click();
        await page.getByRole("heading", { name: "Podcasts", exact: true }).waitFor();
      } else if (index === 2) {
        await page.getByRole("heading", { name: "Podcasts", exact: true }).waitFor();
      }
      await page.waitForTimeout(300);
      const name = TABS.en[index].toLowerCase().replace(/ /g, "-");
      const path = join(OUT, `ui-desktop-${name}-${scheme}-${lang}${width < 1000 ? "-narrow" : ""}.png`);
      await page.screenshot({ path });
      shots.push(path);
    }
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(JSON.stringify({ shots, errors, ok: errors.length === 0 }, null, 2));
process.exit(errors.length ? 1 : 0);
