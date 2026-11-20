import { describe, expect, it } from "vitest";
import {
  CuePlayer, LineAssembler, parseAny, parseBilibili, parseVtt, parseYouTubeJson3,
  pickBilibiliTrack, pickByteDanceTrack, pickYouTubeTrack,
} from "../src/captions/core";

describe("parsers", () => {
  it("reads YouTube json3, skipping append-only events and trimming overlaps", () => {
    const cues = parseYouTubeJson3({ events: [
      { tStartMs: 0, dDurationMs: 7000, segs: [{ utf8: "翻译人员: Jade Liu\n校对人员: Gu Yu" }] },
      { tStartMs: 12559, dDurationMs: 7081, segs: [{ utf8: "so in" }, { utf8: "\ncollege I was" }] },
      { tStartMs: 15000, dDurationMs: 10, segs: [{ utf8: "\n" }] },
      { tStartMs: 16000, dDurationMs: 3000, segs: [{ utf8: "a government major" }] },
      { tStartMs: 20000 },
    ] });
    expect(cues).toEqual([
      { start: 12559, end: 16000, text: "so in college I was" },
      { start: 16000, end: 19000, text: "a government major" },
    ]);
  });

  it("reads Bilibili subtitle JSON in seconds", () => {
    expect(parseBilibili({ body: [{ from: 1.5, to: 3.25, content: "大家好" }] })).toEqual([{ start: 1500, end: 3250, text: "大家好" }]);
  });

  it("reads WebVTT with tags and hours", () => {
    const cues = parseVtt("WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\n<c>Hello</c> there\n\n01:00:00.000 --> 01:00:01.000\nlater");
    expect(cues).toEqual([{ start: 1000, end: 2500, text: "Hello there" }, { start: 3600000, end: 3601000, text: "later" }]);
  });

  it("detects the format", () => {
    expect(parseAny('{"utterances":[{"start_time":10,"end_time":900,"text":"hi"}]}')).toEqual([{ start: 10, end: 900, text: "hi" }]);
    expect(parseAny("not json")).toEqual([]);
  });
});

describe("track choice", () => {
  it("prefers the creator track in the spoken language over YouTube ASR", () => {
    const tracks = [{ languageCode: "ar" }, { languageCode: "en-US" }, { languageCode: "en", kind: "asr" }, { languageCode: "zh-CN" }];
    expect(pickYouTubeTrack(tracks, 0)).toEqual({ track: tracks[1], kind: "creator" });
    expect(pickYouTubeTrack([{ languageCode: "ja", kind: "asr" }, { languageCode: "en" }])).toEqual({ track: { languageCode: "ja", kind: "asr" }, kind: "auto" });
    expect(pickYouTubeTrack([])).toBeNull();
  });

  it("prefers Bilibili uploaded subtitles, then AI subtitles, and needs a URL", () => {
    expect(pickBilibiliTrack([{ lan: "ai-zh", subtitle_url: "//a" }, { lan: "zh-CN", subtitle_url: "//b" }])?.track.lan).toBe("zh-CN");
    expect(pickBilibiliTrack([{ lan: "ai-en", subtitle_url: "//x" }, { lan: "ai-zh", subtitle_url: "//a" }])).toEqual({ track: { lan: "ai-en", subtitle_url: "//x" }, kind: "auto" });
    expect(pickBilibiliTrack([{ lan: "zh-CN", subtitle_url: "" }])).toBeNull();
  });

  it("never uses ByteDance machine translation", () => {
    expect(pickByteDanceTrack([{ lang: "eng-US", url: "u1", source: "MT" }, { lang: "cmn-Hans-CN", url: "u2", source: "ASR" }])?.track.url).toBe("u2");
    expect(pickByteDanceTrack([{ lang: "eng-US", url: "u1", source: "MT" }])).toBeNull();
  });
});

describe("CuePlayer", () => {
  const cues = [{ start: 0, end: 1000, text: "a" }, { start: 1000, end: 2000, text: "b" }, { start: 2000, end: 3000, text: "c" }, { start: 9000, end: 9500, text: "z" }];

  it("emits each cue once as the playhead crosses it", () => {
    const p = new CuePlayer(cues);
    expect(p.due(500).map((c) => c.text)).toEqual(["a"]);
    expect(p.due(900)).toEqual([]);
    expect(p.due(2100).map((c) => c.text)).toEqual(["b", "c"]);
    expect(p.due(2100)).toEqual([]);
  });

  it("skips what a seek jumped over, but includes the cue on screen", () => {
    const p = new CuePlayer(cues);
    p.due(100);
    expect(p.due(9200).map((c) => c.text)).toEqual(["z"]);
    expect(p.due(1500).map((c) => c.text)).toEqual(["b"]);
  });
});

describe("LineAssembler (roll-up live captions)", () => {
  it("emits lines once they scroll up, and the last line after an idle pause", () => {
    const a = new LineAssembler(3000);
    expect(a.push(["FACILITY OUTSIDE"], 0)).toEqual([]);
    expect(a.push(["FACILITY OUTSIDE BIRMINGHAM,"], 500)).toEqual([]);
    expect(a.push(["FACILITY OUTSIDE BIRMINGHAM,", "ALABAMA. SMOKE"], 1000)).toEqual([{ text: "FACILITY OUTSIDE BIRMINGHAM,", start: 0, end: 1000 }]);
    expect(a.push(["ALABAMA. SMOKE AND FLAMES"], 1500)).toEqual([]);
    expect(a.push(["ALABAMA. SMOKE AND FLAMES"], 4600)).toEqual([{ text: "ALABAMA. SMOKE AND FLAMES", start: 1000, end: 4600 }]);
    // The same line growing after it was emitted only adds the new words.
    expect(a.push(["ALABAMA. SMOKE AND FLAMES ROSE"], 5000)).toEqual([]);
    expect(a.push([], 5200)).toEqual([{ text: "ROSE", start: 1000, end: 5200 }]);
  });
});
