// `pnpm dev`: the Mac app (tauri dev: Vite hot reload for the UI, automatic rebuild and restart on
// Rust changes) and the Chrome extension (watch build; the loaded extension reloads itself)
// side by side, with prefixed output. Ctrl+C stops both.
import { spawn } from "node:child_process";

const tasks = [
  { name: "app", color: 35, args: ["--filter", "@multicorder/desktop", "tauri", "dev"] },
  { name: "ext", color: 36, args: ["--filter", "@multicorder/extension", "dev"] },
];

const children = tasks.map(({ name, color, args }) => {
  const child = spawn("pnpm", args, { stdio: ["inherit", "pipe", "pipe"], env: { ...process.env, FORCE_COLOR: "1" } });
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  for (const stream of [child.stdout, child.stderr]) {
    let rest = "";
    stream.on("data", (chunk) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) process.stdout.write(prefix + line + "\n");
    });
  }
  child.on("exit", (code) => {
    process.stdout.write(`${prefix}exited (${code ?? "signal"})\n`);
    shutdown(code ?? 0);
  });
  return child;
});

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill("SIGINT");
  setTimeout(() => process.exit(code), 1500);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
