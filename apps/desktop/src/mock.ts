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

const aiSettings = {
  mode: "service", env: "cloud", local_url: "http://127.0.0.1:8787", cloud_url: "https://multicoder.followkol.live", service_url: "https://multicoder.followkol.live", token_set: false,
  asr: { provider: "moss", protocol: "moss", base_url: "https://api.mosi.cn/v1", model: "moss-transcribe-diarize-pro", language: "", key_set: false },
  llm: { provider: "moss", base_url: "https://api.mosi.cn/v1", model: "nex-n2.6", key_set: false },
};

export async function mockInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const id = args?.id as string | undefined;
  const r: Record<string, unknown> = {
    status: { version: "0.1.0", asr: "moss", asr_ready: true, llm_ready: true, active_sessions: 2, spent_today_usd: 0.042, daily_cap_usd: 2, api_port: 47811, data_dir: "~/Library/Application Support/Multicorder" },
    list_apps: apps,
    list_microphones: [{ id: "mock-mic", name: "Built-in microphone", is_default: true, channel: null, capturing: false, waiting_for_audio: false }],
    list_sessions: sessions,
    list_browser_sources: [
      { source_id: "[\"com.google.Chrome\",\"c1\",11]", app: "Google Chrome", bundle_id: "com.google.Chrome", title: "(2) Forget Harness Agent. Recursive Agent Harness² 10x Better - YouTube", site: "www.youtube.com", audible: true, ordinal: 1, standalone_recording: false },
      { source_id: "[\"com.google.Chrome\",\"c1\",12]", app: "Google Chrome", bundle_id: "com.google.Chrome", title: "兽医变县长，打响第一枪！细致解说赵本山_哔哩哔哩_bilibili", site: "www.bilibili.com", audible: false, ordinal: 2, standalone_recording: false },
    ],
    open_browser_source: "needs_permission",
    ai_settings: aiSettings,
    save_ai_settings: aiSettings,
    transcript: id === "s1" || id === "s3" ? lines : [],
    insights: id === "s1" || id === "s3" ? insights : [],
    recording_preview: {
      transcript: id === "s3" || id === "s4" ? lines[0].text : null,
      summary: id === "s3" ? "The team will ship the beta to the first 50 customers at month end." : null,
    },
    report: id === "s3" ? { body: "# Podcasts\n\n## Key points\n- Beta goes to the first 50 teams by month end. [10:52]\n" } : null,
    retry_asr: { queued: 3 },
    load_recording_audio: mockWav(20),
    load_paused_audio: mockWav(8),
    recording_markers: [{ id: "m1", at_ms: 4200, label: null }, { id: "m2", at_ms: 13500, label: null }],
    add_marker: "m3",
    export_audio: `~/Downloads/multicorder-${id}.wav`,
    export: `~/Downloads/multicorder-${id}.md`,
    export_recording_selection: `~/Downloads/multicorder-${id}-selection.wav`,
    export_recording_text: `~/Downloads/multicorder-${id}.pdf`,
    missed: { points: [{ text: "Beta goes to the first 50 teams by month end." }] },
  };
  return (r[cmd] ?? null) as T;
}

export const mockSessions = sessions;

/** A mono 16 kHz WAV of speech-like bursts, so the player has something to show. */
function mockWav(seconds: number): ArrayBuffer {
  const rate = 16000;
  const count = rate * seconds;
  const buffer = new ArrayBuffer(44 + count * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, 36 + count * 2, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    const time = i / rate;
    const envelope = Math.max(0, Math.sin(time * 2.1) * Math.sin(time * 0.37 + 1)) ** 1.5;
    const sample = envelope * 0.6 * (Math.sin(2 * Math.PI * 180 * time) * 0.6 + Math.sin(2 * Math.PI * 410 * time) * 0.3);
    view.setInt16(44 + i * 2, Math.round(sample * 32767), true);
  }
  return buffer;
}

/** Feeds waveform and level events for the capturing mock sessions, like the engine does. */
export function mockEngineEvents(emit: (event: { type: "waveform"; session_id: string; peaks: number[]; audio_ms: number } | { type: "level"; session_id: string; rms_db: number; silent: boolean }) => void): () => void {
  const live = sessions.filter((session) => session.status === "capturing");
  const audioMs = new Map(live.map((session) => [session.id, session.audio_ms]));
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    for (const session of live) {
      const ms = (audioMs.get(session.id) ?? 0) + 200;
      audioMs.set(session.id, ms);
      const peaks = Array.from({ length: 8 }, (_, i) => {
        const time = (ms - 200 + i * 25) / 1000;
        const envelope = Math.max(0, Math.sin(time * 2.1) * Math.sin(time * 0.37 + 1));
        return Math.min(1, envelope * 0.7 + Math.random() * 0.05);
      });
      emit({ type: "waveform", session_id: session.id, peaks, audio_ms: ms });
      if (tick % 5 === 0) emit({ type: "level", session_id: session.id, rms_db: -24 + Math.random() * 6, silent: false });
    }
  }, 200);
  return () => clearInterval(timer);
}
