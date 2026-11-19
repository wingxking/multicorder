// Bundles each extension context separately (no shared chunks: the media clock is injected as a
// classic script, the service worker and offscreen document are modules).
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
cpSync("static", "dist", { recursive: true });
const common = { bundle: true, target: "chrome116", sourcemap: false, minify: false, logLevel: "warning", define: { "process.env.NODE_ENV": '"production"' } };
await build({ ...common, entryPoints: ["src/background.ts"], outfile: "dist/background.js", format: "esm" });
await build({ ...common, entryPoints: ["src/offscreen.ts"], outfile: "dist/offscreen.js", format: "esm" });
await build({ ...common, entryPoints: ["src/media-clock.ts"], outfile: "dist/media-clock.js", format: "iife" });
for (const page of ["sidepanel", "options", "library", "onboarding"]) {
  await build({ ...common, entryPoints: [`src/${page}.tsx`], outfile: `dist/${page}.js`, format: "esm", jsx: "automatic" });
}
console.log("extension built in dist/");
