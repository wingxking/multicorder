// Bundles each extension context separately (no shared chunks: the media clock and the caption
// page script are injected as classic scripts, the service worker and offscreen document are modules).
//
// `node build.mjs`          one production build into dist/
// `node build.mjs --watch`  development: rebuilds on change and serves the build number on
//                           http://127.0.0.1:35830 so the loaded extension reloads itself
//                           (pages refresh in place; a worker or manifest change reloads the extension).
import { context, build } from "esbuild";
import { cpSync, mkdirSync, rmSync, watch as watchDir } from "node:fs";
import { createServer } from "node:http";

const WATCH = process.argv.includes("--watch");
const DEV_PORT = 35830;
const PAGES = ["sidepanel", "options", "library", "onboarding"];
/** Contexts whose change needs chrome.runtime.reload(); pages only need a page refresh. */
const WORKERS = new Set(["background", "offscreen", "media-clock", "captions-page", "static"]);

// A one-off build would replace a running watch build's output with files that cannot reload
// themselves; refuse while `pnpm dev:ext` is serving.
if (!WATCH) {
  const watching = await fetch(`http://127.0.0.1:${DEV_PORT}/build`, { signal: AbortSignal.timeout(500) }).then(() => true, () => false);
  if (watching) {
    console.error("The extension watch build (pnpm dev / dev:ext) is running and keeps dist/ up to date. Stop it before a one-off build.");
    process.exit(1);
  }
}

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
cpSync("static", "dist", { recursive: true });

const common = {
  bundle: true, target: "chrome116", sourcemap: WATCH ? "inline" : false, minify: false, logLevel: "warning",
  define: { "process.env.NODE_ENV": WATCH ? '"development"' : '"production"', __MC_DEV__: WATCH ? "true" : "false" },
};
const entries = [
  { name: "background", entryPoints: ["src/background.ts"], outfile: "dist/background.js", format: "esm" },
  { name: "offscreen", entryPoints: ["src/offscreen.ts"], outfile: "dist/offscreen.js", format: "esm" },
  { name: "media-clock", entryPoints: ["src/media-clock.ts"], outfile: "dist/media-clock.js", format: "iife" },
  { name: "captions-page", entryPoints: ["src/captions-page.ts"], outfile: "dist/captions-page.js", format: "iife" },
  ...PAGES.map((page) => ({ name: page, entryPoints: [`src/${page}.tsx`], outfile: `dist/${page}.js`, format: "esm", jsx: "automatic" })),
];

if (!WATCH) {
  for (const { name: _name, ...options } of entries) await build({ ...common, ...options });
  console.log("extension built in dist/");
} else {
  let buildId = Date.now();
  let full = false;
  const waiters = new Set();
  let pending = new Set();
  let timer;
  // Coalesce the per-context rebuilds of one save into a single reload signal.
  const changed = (name) => {
    pending.add(name);
    clearTimeout(timer);
    timer = setTimeout(() => {
      full = [...pending].some((n) => WORKERS.has(n));
      console.log(`[extension] rebuilt ${[...pending].join(", ")} → ${full ? "reloading extension" : "refreshing pages"}`);
      pending = new Set();
      buildId = Date.now();
      for (const done of waiters) done();
      waiters.clear();
    }, 120);
  };
  const notify = (name) => ({
    name: "mc-dev-notify",
    setup(b) {
      let first = true;
      b.onEnd((result) => {
        if (first) { first = false; return; }
        if (!result.errors.length) changed(name);
      });
    },
  });
  for (const { name, ...options } of entries) {
    const ctx = await context({ ...common, ...options, plugins: [notify(name)] });
    await ctx.watch();
  }
  watchDir("static", { recursive: true }, () => {
    cpSync("static", "dist", { recursive: true });
    changed("static");
  });

  // GET /build?since=<id> answers at once unless <id> is the current build; then it waits up to 25 s.
  createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    const reply = () => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id: buildId, full }));
    };
    if (url.pathname !== "/build") { res.statusCode = 404; res.end(); return; }
    const since = Number(url.searchParams.get("since") ?? 0);
    if (since !== buildId) return reply();
    const done = () => { clearTimeout(timeout); reply(); };
    const timeout = setTimeout(() => { waiters.delete(done); reply(); }, 25000);
    waiters.add(done);
    req.on("close", () => { clearTimeout(timeout); waiters.delete(done); });
  }).listen(DEV_PORT, "127.0.0.1", () => {
    console.log(`[extension] watching. Load ${new URL("dist", import.meta.url).pathname} as an unpacked extension once; it reloads itself from now on.`);
  });
}
