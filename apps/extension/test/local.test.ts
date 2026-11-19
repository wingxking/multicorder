import { describe, expect, it } from "vitest";
import { chunkAll, MAX_CHUNK_MS, msToSamples } from "../src/local/chunker";
import { applyOps, checkNumbers, extractNumbers, renderReport, Seg } from "../src/local/insight";
import { FairQueue } from "../src/local/queue";
import { videoKey } from "../src/local/engine";

const tone = (ms: number) => Float32Array.from({ length: msToSamples(ms) }, (_, i) => Math.sin(i * 0.07) * 0.2);
const silence = (ms: number) => new Float32Array(msToSamples(ms)).fill(0.0005);
const cat = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

describe("chunker (same policy as mc-vad)", () => {
  it("splits on silence with pre-roll", () => {
    const c = chunkAll(cat(silence(1000), tone(2000), silence(1000), tone(1500), silence(800)));
    expect(c.length).toBe(2);
    expect(Math.abs(c[0].startMs - 800)).toBeLessThanOrEqual(40);
    expect(c[1].startMs).toBeGreaterThanOrEqual(3750);
  });
  it("caps continuous audio at 15 s", () => {
    const c = chunkAll(tone(40000));
    expect(c.length).toBeGreaterThanOrEqual(3);
    expect(c.every((x) => x.endMs - x.startMs <= MAX_CHUNK_MS + 50)).toBe(true);
  });
  it("ignores clicks", () => {
    expect(chunkAll(cat(silence(1000), tone(90), silence(1000)))).toEqual([]);
  });
});

const seg = (id: string, text: string, start = 0): Seg => ({ id, sessionId: "s", startMs: start, endMs: start + 4000, text, state: "final", engine: "t" });

describe("insight validation (same rules as mc-insight)", () => {
  const segs = new Map([["e0", seg("e0", "The Falcon budget is 42 million dollars.")], ["e1", seg("e1", "Launch is planned for March.", 5000)]]);
  it("extracts numbers ignoring separators", () => {
    expect(extractNumbers("about 1,200.5 users and 42%")).toEqual(["1200.5", "42"]);
    expect(checkNumbers("预算 42 million", "budget is 42 million")).toBeNull();
    expect(checkNumbers("budget 43 million", "budget is 42 million")).toBe("43");
  });
  it("rejects unknown evidence and wrong numbers, applies confirm", () => {
    const out = { ops: [
      { op: "upsert", key: "a", type: "number", text: "Falcon 预算为 42 million 美元", evidence: ["e0"] },
      { op: "upsert", key: "b", type: "number", text: "Falcon 预算 43 million", evidence: ["e0"] },
      { op: "upsert", key: "c", text: "made up", evidence: ["nope"] },
      { op: "confirm", key: "zzz" },
    ] };
    const r = applyOps("s", out, segs, []);
    expect(r.applied.length).toBe(1);
    expect(r.rejected.length).toBe(3);
    const r2 = applyOps("s", { ops: [{ op: "confirm", key: "a" }] }, segs, r.applied);
    expect(r2.applied[0].state).toBe("confirmed");
    expect(r2.applied[0].revision).toBe(2);
  });
  it("report keeps only evidenced bullets", () => {
    const r = renderReport("T", { summary: "ok", sections: [{ heading: "Points", bullets: [{ text: "Launch in March", evidence: ["e1"] }, { text: "x", evidence: ["bad"] }] }] }, segs);
    expect(r.sections[0].bullets.length).toBe(1);
    expect(r.body).toContain("[00:05]");
  });
});

describe("queue (same order as mc-asr)", () => {
  it("serves live before backfill and rotates sessions", () => {
    const q = new FairQueue<void>(0); // concurrency 0: nothing runs, so we can inspect pop order
    const order: string[] = [];
    for (const [s, p] of [["b", "backfill"], ["a", "live"], ["a", "live"], ["c", "live"]] as const) q.submit(s, p, async () => {}).catch(() => {});
    for (let j = q.pop(); j; j = q.pop()) order.push(`${j.sessionId}:${j.pass}`);
    expect(order).toEqual(["a:live", "c:live", "a:live", "b:backfill"]);
  });
});

describe("video keys", () => {
  it("parses YouTube and Bilibili", () => {
    expect(videoKey("https://www.youtube.com/watch?v=xyz&t=3")).toBe("youtube:xyz");
    expect(videoKey("https://www.bilibili.com/video/BV1x/")).toBe("bilibili:BV1x");
    expect(videoKey("https://example.com")).toBeNull();
  });
});
