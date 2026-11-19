import React from "react";

// 16 px outline icons (stroke = currentColor), drawn for this UI.
const paths: Record<string, React.ReactNode> = {
  record: <circle cx="8" cy="8" r="4.5" fill="currentColor" stroke="none" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" />,
  tab: <><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M2 6h12" /></>,
  app: <><rect x="2.5" y="2.5" width="11" height="11" rx="2.5" /><path d="M6 6h4v4H6z" /></>,
  mic: <><rect x="6" y="2" width="4" height="7" rx="2" /><path d="M4 7.5a4 4 0 008 0M8 11.5V14" /></>,
  flag: <><path d="M4 14V2.5" /><path d="M4 3h7l-1.5 2.5L11 8H4" /></>,
  clock: <><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></>,
  retry: <><path d="M13 8a5 5 0 11-1.5-3.5" /><path d="M13 2.5V5h-2.5" /></>,
  download: <><path d="M8 2.5v8M4.5 7.5 8 11l3.5-3.5" /><path d="M3 13.5h10" /></>,
  sun: <><circle cx="8" cy="8" r="3" /><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" /></>,
  moon: <path d="M13 9.5A5.5 5.5 0 016.5 3a5.5 5.5 0 106.5 6.5z" />,
  monitor: <><rect x="2" y="3" width="12" height="8" rx="1.5" /><path d="M6 14h4M8 11v3" /></>,
  gear: <><circle cx="8" cy="8" r="2" /><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" /></>,
  library: <><path d="M3 2.5v11M6 2.5v11" /><path d="M9 3l3.5 10" /></>,
  search: <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></>,
  edit: <path d="M9.5 4.5l2 2M3 13l.6-3.6 7-7a1.4 1.4 0 012 0l1 1a1.4 1.4 0 010 2l-7 7L3 13z" />,
  trash: <><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9" /></>,
  warn: <><path d="M8 2 14.5 13.5h-13z" /><path d="M8 6.5v3M8 11.5v.1" /></>,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  live: <><circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" /><path d="M4.5 4.5a5 5 0 000 7M11.5 4.5a5 5 0 010 7" /></>,
  back: <path d="M10 3 5 8l5 5" />,
  speaker: <><path d="M2.5 6h2.5L8.5 3v10L5 10H2.5z" /><path d="M11 5.5a3.5 3.5 0 010 5M12.8 3.8a6 6 0 010 8.4" /></>,
  history: <><path d="M2.5 8a5.5 5.5 0 105.5-5.5A5.6 5.6 0 004 4.3" /><path d="M2.5 2.5v2.5H5M8 5v3l2 1.3" /></>,
  wave: <path d="M2 8h1.5M4.5 5.5v5M7 3v10M9.5 5v6M12 6.5v3M14 8h.01" />,
  pause: <><path d="M5.5 3.5v9M10.5 3.5v9" /></>,
  play: <path d="M5 3.2v9.6L12.5 8z" fill="currentColor" />,
  copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5V3.5a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h2" /></>,
  scissors: <><circle cx="4.5" cy="4.5" r="2" /><circle cx="4.5" cy="11.5" r="2" /><path d="M6.2 5.6 13.5 12M6.2 10.4 13.5 4" /></>,
  sparkle: <path d="M8 2.5 9.2 6.8 13.5 8l-4.3 1.2L8 13.5 6.8 9.2 2.5 8l4.3-1.2z" />,
  text: <path d="M3 4h10M3 7h10M3 10h7M3 13h5" />,
};

export function Icon({ name, size = 16, title }: { name: keyof typeof paths | string; size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
      {title && <title>{title}</title>}
      {paths[name]}
    </svg>
  );
}
