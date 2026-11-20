// How the UI names a recording's text source: a platform's subtitles or speech recognition.
// Styles live in THEME_CSS (.text-source, .source-tag).

import React from "react";
import type { CaptionSource } from "./api";
import { Icon } from "./icons";
import { t } from "./i18n";

const PLATFORM: Record<string, string> = { youtube: "YouTube", bilibili: "Bilibili", tiktok: "TikTok", douyin: "Douyin", web: "Page" };

/** "YouTube subtitles · en", "Bilibili AI subtitles · zh", "YouTube live captions". */
export function captionLabel(source: CaptionSource): string {
  const platform = t(PLATFORM[source.platform] ?? source.platform);
  const what = source.kind === "auto" ? t("{platform} auto subtitles", { platform })
    : source.kind === "live" ? t("{platform} live captions", { platform })
    : t("{platform} subtitles", { platform });
  return source.lang ? `${what} · ${source.lang}` : what;
}

/** Parses a transcript event's engine id (`caption:youtube:creator:en`) back into a source. */
export function captionFromEngine(engine: string | undefined | null): CaptionSource | null {
  const m = engine?.match(/^caption:([^:]+):([^:]+):(.+)$/);
  return m ? { platform: m[1], kind: m[2], lang: m[3] === "und" ? null : m[3] } : null;
}

/** Small line in the recorder: where the text comes from right now. */
export function TextSourceBadge({ state, recording }: { state?: { source: CaptionSource | null; active: boolean }; recording: boolean }) {
  if (!recording || !state) return null;
  const { source, active } = state;
  const text = source && active ? captionLabel(source)
    : source ? t("{label} paused · speech recognition", { label: captionLabel(source) })
    : t("Speech recognition");
  const title = source && active ? t("Using the platform's subtitles, so this stretch needs no speech recognition.")
    : t("No platform subtitles here; the audio is transcribed by speech recognition.");
  return <span className={`text-source${source && active ? " is-captions" : ""}`} title={title}><Icon name={source && active ? "captions" : "mic"} size={11} />{text}</span>;
}

