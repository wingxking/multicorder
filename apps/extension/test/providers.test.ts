import { afterEach, describe, expect, it, vi } from "vitest";
import { chatJson, ServiceError, Target, transcribe } from "../src/local/providers";

const local: Target = { kind: "service", env: "local", base: "http://127.0.0.1:47811", token: "t0k" };
const cloud: Target = { kind: "service", env: "cloud", base: "https://multicoder.followkol.live", token: "c1" };
const pcm = new Float32Array(16000).fill(0.1);

afterEach(() => vi.unstubAllGlobals());

describe("service target (local Mac service / cloud)", () => {
  it("posts a WAV to /v1/asr/transcribe with the bearer token", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ engine: "moss", segments: [{ start_ms: 0, end_ms: 900, text: " hello " }, { start_ms: 900, end_ms: 1000, text: " " }] })));
    vi.stubGlobal("fetch", fetch);
    const segs = await transcribe(local, pcm, "en");
    expect(segs).toEqual([{ startMs: 0, endMs: 900, text: "hello" }]);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:47811/v1/asr/transcribe?lang=en");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer t0k");
    const wav = new Uint8Array(await (init.body as Blob).arrayBuffer());
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(wav.length).toBe(44 + 16000 * 2);
  });

  it("posts chat requests to /v1/llm/chat and returns out + usage", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ out: { ops: [] }, usage: { provider: "moss", model: "nex-n2.6", tokens: 42 } })));
    vi.stubGlobal("fetch", fetch);
    const r = await chatJson(cloud, "sys", "user", 300);
    expect(r).toEqual({ out: { ops: [] }, usage: { provider: "moss", model: "nex-n2.6", tokens: 42 } });
    expect(fetch.mock.calls[0][0]).toBe("https://multicoder.followkol.live/v1/llm/chat");
  });

  it("maps a 503 asr_unavailable to a ServiceError with that code after one retry", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ code: "asr_unavailable", error: "no key" }), { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const e = await transcribe(local, pcm).catch((x) => x);
    expect(e).toBeInstanceOf(ServiceError);
    expect(e.code).toBe("asr_unavailable");
    expect(fetch).toHaveBeenCalledTimes(2);
  }, 10000);

  it("reports an unreachable service (cloud not deployed / Mac service down)", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetch);
    const e = await transcribe(cloud, pcm).catch((x) => x);
    expect(e).toBeInstanceOf(ServiceError);
    expect(e.code).toBe("unreachable");
    expect(e.message).toContain("Cloud service unreachable");
  }, 10000);

  it("maps 401 to unauthorized without retrying", async () => {
    const fetch = vi.fn(async () => new Response("bad token", { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    const e = await chatJson(local, "s", "u", 10).catch((x) => x);
    expect(e.code).toBe("unauthorized");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
