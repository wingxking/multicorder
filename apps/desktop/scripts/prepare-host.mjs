// Copies the native messaging host next to the app binary (Tauri externalBin naming).
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
const profile = process.argv[2] === "release" ? "release" : "debug";
execSync(`cargo build -p multicorder-host ${profile === "release" ? "--release" : ""}`, { stdio: "inherit", cwd: "../.." });
const triple = execSync("rustc -vV").toString().match(/host: (\S+)/)[1];
mkdirSync("src-tauri/binaries", { recursive: true });
copyFileSync(`../../target/${profile}/multicorder-host`, `src-tauri/binaries/multicorder-host-${triple}`);
console.log(`host copied for ${triple}`);
