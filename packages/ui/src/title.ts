// The name of the video, episode or track playing in a tab, without the site's decorations:
// "(2) Forget Harness Agent - YouTube" → "Forget Harness Agent".

const SITE_SUFFIXES = [
  /\s*[-–—|·]\s*YouTube( Music)?$/i,
  /_哔哩哔哩_bilibili$/i,
  /\s*[-–—|_]\s*(哔哩哔哩|bilibili)(\s*[-–—|_].*)?$/i,
  /\s*[-–—|]\s*(Spotify|SoundCloud|Apple Podcasts|Podcasts|Vimeo|Twitch|Netflix|Overcast|Pocket Casts|小宇宙|喜马拉雅|网易云音乐|QQ音乐|优酷|爱奇艺|腾讯视频|抖音)$/i,
];

export function programTitle(title: string | undefined | null, site?: string | null): string {
  let name = (title ?? "").trim();
  // Unread-notification counters YouTube and others put in front of the title.
  name = name.replace(/^\(\d+\+?\)\s*/, "");
  for (const suffix of SITE_SUFFIXES) name = name.replace(suffix, "");
  if (site) {
    const host = site.replace(/^www\./, "");
    const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    name = name.replace(new RegExp(`\\s*[-–—|·]\\s*(www\\.)?${escaped}$`, "i"), "");
  }
  return name.trim() || (title ?? "").trim();
}
