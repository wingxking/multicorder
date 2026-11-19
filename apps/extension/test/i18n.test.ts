import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ZH } from "../../../packages/ui/src/i18n-zh";
import { getLang, setLangPref, t } from "../../../packages/ui/src/i18n";

const ROOT = join(__dirname, "../../..");
const DIRS = ["packages/ui/src", "apps/desktop/src", "apps/extension/src"];

function sources(): string[] {
  return DIRS.flatMap((dir) => readdirSync(join(ROOT, dir))
    .filter((f) => /\.tsx?$/.test(f) && !f.startsWith("i18n"))
    .map((f) => readFileSync(join(ROOT, dir, f), "utf8")));
}

describe("i18n", () => {
  it("has a Chinese translation for every t() string", () => {
    const missing = new Set<string>();
    for (const src of sources()) {
      for (const m of src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) if (!(m[1] in ZH)) missing.add(m[1]);
    }
    expect([...missing]).toEqual([]);
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
});
