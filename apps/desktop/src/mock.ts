// Stand-in for the Tauri backend when the UI is opened in a plain browser (`pnpm dev`), so the
// screens can be reviewed and screenshotted without the app. Never used inside the app.

const now = Date.now();
const iso = (minAgo: number) => new Date(now - minAgo * 60000).toISOString();

const sessions = [
  { id: "s1", kind: "mac_app", capture_source_id: "us.zoom.xos", title: "Zoom", status: "capturing", summary_mode: "live", started_at: iso(12), audio_ms: 720000, url: null, asr: { state: "ok", failed_chunks: 0, failed_ms: 0 } },
  { id: "s2", kind: "chromium_tab", title: "Q3 roadmap review — YouTube", status: "capturing", summary_mode: "live", started_at: iso(8), audio_ms: 480000, url: "https://youtube.com", asr: { state: "degraded", failed_chunks: 3, failed_ms: 41000 } },
  { id: "s3", kind: "mac_app", capture_source_id: "com.apple.podcasts", title: "Podcasts", status: "stopped", summary_mode: "after", started_at: iso(95), audio_ms: 2710000, url: null, asr: { state: "ok", failed_chunks: 0, failed_ms: 0 } },
  { id: "s4", kind: "chromium_tab", title: "Founder interview — Bilibili", status: "stopped", summary_mode: "off", started_at: iso(400), audio_ms: 1530000, url: "https://bilibili.com", asr: { state: "degraded", failed_chunks: 12, failed_ms: 160000 } },
];

const lines = [
  { id: "e1", session_id: "s1", start_ms: 652000, end_ms: 660000, state: "final", text: "So the plan is to ship the beta to the first 50 teams by the end of the month.", engine: "moss" },
  { id: "e2", session_id: "s1", start_ms: 661000, end_ms: 671000, state: "final", text: "Pricing stays at twelve dollars per seat until we have the usage numbers.", engine: "moss" },
];

const insights = [
  { key: "k1", session_id: "s1", text: "Beta goes to the first 50 teams by month end.", state: "confirmed", evidence: [{ event_id: "e1", start_ms: 652000, end_ms: 660000 }] },
  { key: "k2", session_id: "s1", text: "Pricing held at $12/seat pending usage data.", state: "tentative", evidence: [{ event_id: "e2", start_ms: 661000, end_ms: 671000 }] },
];

const apps = [
  { app_id: "us.zoom.xos", name: "zoom.us", pids: [1], is_emitting: true, capturing: true },
  { app_id: "com.google.Chrome", name: "Google Chrome", pids: [2], is_emitting: true, capturing: false, tab_recording: true },
  { app_id: "com.apple.podcasts", name: "Podcasts", pids: [3], is_emitting: false, capturing: false },
  { app_id: "com.spotify.client", name: "Spotify", pids: [4], is_emitting: true, capturing: false },
];

export async function mockInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const id = args?.id as string | undefined;
  const r: Record<string, unknown> = {
    status: { version: "0.1.0", asr: "moss", asr_ready: true, llm_ready: true, active_sessions: 2, spent_today_usd: 0.042, daily_cap_usd: 2, api_port: 47811, data_dir: "~/Library/Application Support/Multicorder" },
    list_apps: apps,
    list_microphones: [{ id: "mock-mic", name: "Built-in microphone", is_default: true, channel: null, capturing: false, waiting_for_audio: false }],
    list_sessions: sessions,
    transcript: id === "s1" || id === "s3" ? lines : [],
    insights: id === "s1" || id === "s3" ? insights : [],
    recording_preview: {
      transcript: id === "s3" ? lines[0].text : null,
      summary: id === "s3" ? "The team will ship the beta to the first 50 customers at month end." : null,
    },
    report: id === "s3" ? { body: "# Podcasts\n\n## Key points\n- Beta goes to the first 50 teams by month end. [10:52]\n" } : null,
    retry_asr: { queued: 3 },
    export_audio: `~/Downloads/multicorder-${id}.wav`,
    export: `~/Downloads/multicorder-${id}.md`,
    missed: { points: [{ text: "Beta goes to the first 50 teams by month end." }] },
  };
  return (r[cmd] ?? null) as T;
}

export const mockSessions = sessions;
