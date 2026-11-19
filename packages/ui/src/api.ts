// Types and a tiny client for the Multicorder local API (protocol v1). Shared by the Chrome
// extension side panel and the desktop app.

export type SummaryMode = "off" | "live" | "after";

export interface Session {
  id: string;
  kind: "chromium_tab" | "mac_app" | "mic";
  title: string;
  app_bundle_id?: string | null;
  capture_source_id?: string | null;
  url?: string | null;
  video_key?: string | null;
  status: string;
  summary_mode: SummaryMode;
  started_at: string;
  ended_at?: string | null;
  failure?: string | null;
  audio_ms: number;
  sample_rate?: number;
  bits_per_sample?: number;
  /** Transcription health (Mac app sessions and standalone sessions). */
  asr?: { state: "ok" | "degraded"; failed_chunks: number; failed_ms?: number };
}

export interface TranscriptEvent {
  id: string;
  session_id: string;
  start_ms: number;
  end_ms: number;
  state: string;
  text: string;
  engine: string;
}

export interface Evidence {
  event_id: string;
  start_ms: number;
  end_ms: number;
}

export interface Insight {
  id: string;
  session_id: string;
  key: string;
  revision: number;
  kind: string;
  state: "tentative" | "confirmed" | "retracted";
  text: string;
  evidence: Evidence[];
}

export type EngineEvent =
  | { type: "status"; session_id: string; status: string; detail?: string | null }
  | { type: "level"; session_id: string; rms_db: number; silent: boolean }
  | { type: "waveform"; session_id: string; peaks: number[]; audio_ms: number }
  | { type: "transcript"; session_id: string; event: TranscriptEvent }
  | { type: "insight"; session_id: string; insight: Insight }
  | { type: "gap"; session_id: string; start_ms: number; end_ms: number; cause: string }
  | { type: "report"; session_id: string; is_final: boolean }
  | { type: "backlog"; session_id: string; pending_chunks: number };

export interface Pairing {
  port: number;
  token: string;
}

export function fmtTs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60) % 60).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${mm}:${ss}`;
}

export class Api {
  constructor(public pairing: Pairing) {}

  get base(): string {
    return `http://127.0.0.1:${this.pairing.port}`;
  }

  async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(this.base + path, {
      ...init,
      headers: { Authorization: `Bearer ${this.pairing.token}`, "Content-Type": "application/json", ...(init.headers || {}) },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  sessions(active = false) {
    return this.req<Session[]>(`/v1/sessions${active ? "?status=active" : ""}`);
  }
  setMode(id: string, mode: SummaryMode) {
    return this.req(`/v1/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ summary_mode: mode }) });
  }
  stop(id: string) {
    return this.req(`/v1/sessions/${id}/stop`, { method: "POST" });
  }
  transcript(id: string) {
    return this.req<TranscriptEvent[]>(`/v1/sessions/${id}/transcript`);
  }
  insights(id: string) {
    return this.req<Insight[]>(`/v1/sessions/${id}/insights`);
  }
  missed(id: string, minutes: number) {
    return this.req<{ points: { text: string; evidence: Evidence[] }[]; from_ms: number; to_ms: number }>(`/v1/sessions/${id}/missed?minutes=${minutes}`);
  }
  retryAsr(id: string) {
    return this.req<{ queued: number }>(`/v1/sessions/${id}/retry-asr`, { method: "POST" });
  }
  audioUrl(id: string) {
    return `${this.base}/v1/sessions/${id}/audio`;
  }
  async audioBlob(id: string): Promise<Blob> {
    const r = await fetch(this.audioUrl(id), { headers: { Authorization: `Bearer ${this.pairing.token}` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.blob();
  }
  marker(id: string) {
    return this.req(`/v1/sessions/${id}/markers`, { method: "POST", body: "{}" });
  }

  /** Server-sent events; SSE cannot send headers, so a one-time ticket is exchanged first. */
  async events(onEvent: (e: EngineEvent) => void): Promise<EventSource> {
    const { ticket } = await this.req<{ ticket: string }>("/v1/sse-ticket", { method: "POST" });
    const es = new EventSource(`${this.base}/v1/events?t=${ticket}`);
    es.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data));
      } catch {
        /* ignore malformed */
      }
    };
    return es;
  }
}
