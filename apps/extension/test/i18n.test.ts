import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ZH } from "../../../packages/ui/src/i18n-zh";
import { getLang, setLangPref, t, tError } from "../../../packages/ui/src/i18n";

const ROOT = join(__dirname, "../../..");
const DIRS = ["packages/ui/src", "apps/desktop/src", "apps/extension/src"];

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name), ext) : ext.test(e.name) ? [join(dir, e.name)] : []);
}

function sources(): string[] {
  return DIRS.flatMap((dir) => files(dir, /\.tsx?$/))
    .filter((f) => !/\/i18n[^/]*$/.test(f))
    .map((f) => readFileSync(join(ROOT, f), "utf8"));
}

/** Error messages the backends can show the user, with `{…}` / `${…}` holes normalised to `{}`. */
function backendMessages(): string[] {
  const rust = ["crates", "apps/desktop/src-tauri/src"].flatMap((d) => files(d, /\.rs$/))
    .filter((f) => !/\/target\/|tests?\.rs$/.test(f))
    .map((f) => readFileSync(join(ROOT, f), "utf8"));
  const ts = files("apps/extension/src", /\.ts$/).map((f) => readFileSync(join(ROOT, f), "utf8"));
  const out = new Set<string>();
  const hole = (s: string) => s.replace(/\$\{[^}]*\}|\{[^}]*\}/g, "{}");
  for (const src of rust) {
    for (const m of src.matchAll(/(?:bail!|anyhow!)\(\s*"((?:[^"\\]|\\.)*)"|Err\("((?:[^"\\]|\\.)*)"\.into\(\)\)|\.ok_or\("((?:[^"\\]|\\.)*)"\)|"error": "((?:[^"\\]|\\.)*)"/g)) {
      out.add(hole(m[1] ?? m[2] ?? m[3] ?? m[4]));
    }
  }
  for (const src of ts) {
    for (const m of src.matchAll(/(?:new (?:Service)?Error)\(\s*(?:"((?:[^"\\]|\\.)*)"|`([^`]*)`)|\{ error: "((?:[^"\\]|\\.)*)" \}|\?\? "((?:[^"\\]|\\.)*)"\)|\|\| "((?:[^"\\]|\\.)*)"\)/g)) {
      out.add(hole(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]));
    }
  }
  return [...out].filter((s) => s.replace(/\{\}/g, "").trim().length >= 3 && !/^HTTP \{\}$/.test(s) && !/^[a-z]+(_[a-z]+)+$/.test(s)); // skip reason codes such as closed_by_app
}

describe("i18n", () => {
  it("has a Chinese translation for every t() string", () => {
    const missing = new Set<string>();
    for (const src of sources()) {
      for (const m of src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) if (!(m[1] in ZH)) missing.add(m[1]);
    }
    expect([...missing]).toEqual([]);
  });

  it("has a Chinese translation for every backend error message", () => {
    const known = new Set(Object.keys(ZH).map((k) => k.replace(/\{\w+\}/g, "{}")));
    const msgs = backendMessages();
    expect(msgs.length).toBeGreaterThan(40);
    expect(msgs.filter((m) => !known.has(m))).toEqual([]);
  });

  it("keeps placeholders intact in translations", () => {
    for (const [en, zh] of Object.entries(ZH)) {
      const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
      expect(vars(zh), en).toBe(vars(en));
    }
  });

  it("translates and interpolates", () => {
    expect(getLang()).toBe("en");
    expect(t("Saved {path}", { path: "/a" })).toBe("Saved /a");
    setLangPref("zh");
    expect(t("Saved {path}", { path: "/a" })).toBe("已保存到 /a");
    expect(t("Not in the dictionary")).toBe("Not in the dictionary");
    setLangPref("en");
  });

  it("translates backend errors, including nested causes", () => {
    expect(tError("no session abc")).toBe("no session abc");
    setLangPref("zh");
    try {
      expect(tError("no session abc")).toBe("找不到录音 abc");
      expect(tError(new Error("stop the session before deleting it"))).toBe("请先停止录音再删除");
      expect(tError("Error: The local Mac service is not running")).toBe("本机 Mac 服务未运行");
      expect(tError("could not start capture: app com.apple.Music is not running")).toBe("无法开始采集：应用 com.apple.Music 未在运行");
      expect(tError("ASR HTTP 401: {\"error\":\"bad key\"}")).toBe("转写服务返回 HTTP 401：{\"error\":\"bad key\"}");
      expect(tError("Local service unreachable (Failed to fetch)")).toBe("无法连接本地服务（网络请求失败）");
      expect(tError("Zoom is already being recorded")).toBe("Zoom 已在录制中");
      expect(tError({ error: "unknown message" })).toBe("未知消息");
      expect(tError("something we never wrote")).toBe("something we never wrote");
    } finally {
      setLangPref("en");
    }
  });
});
