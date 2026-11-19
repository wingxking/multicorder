// Transcription queue (port of mc-asr's scheduler): priority live > after > backfill, round-robin
// across sessions inside a priority, bounded parallelism. A slow provider delays text, never recording.

export type Pass = "live" | "after" | "backfill";
const ORDER: Pass[] = ["live", "after", "backfill"];

export interface Job<T> {
  sessionId: string;
  pass: Pass;
  run: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

export class FairQueue<T = unknown> {
  private queues = new Map<Pass, Map<string, Job<T>[]>>();
  private last = new Map<Pass, string>();
  private running = 0;

  constructor(private concurrency = 3) {}

  submit(sessionId: string, pass: Pass, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const byPass = this.queues.get(pass) ?? new Map<string, Job<T>[]>();
      this.queues.set(pass, byPass);
      const q = byPass.get(sessionId) ?? [];
      byPass.set(sessionId, q);
      q.push({ sessionId, pass, run, resolve, reject });
      this.pump();
    });
  }

  pending(sessionId: string): number {
    let n = 0;
    for (const m of this.queues.values()) n += m.get(sessionId)?.length ?? 0;
    return n;
  }

  cancel(sessionId: string, pass: Pass) {
    const q = this.queues.get(pass)?.get(sessionId);
    if (q) for (const j of q.splice(0)) j.reject(new Error("cancelled"));
  }

  /** Next job by priority, then the session after the one served last (round-robin). */
  pop(): Job<T> | undefined {
    for (const pass of ORDER) {
      const m = this.queues.get(pass);
      if (!m) continue;
      const keys = [...m.keys()].filter((k) => (m.get(k)?.length ?? 0) > 0).sort();
      if (!keys.length) continue;
      const last = this.last.get(pass) ?? "";
      const key = keys.find((k) => k > last) ?? keys[0];
      this.last.set(pass, key);
      return m.get(key)!.shift();
    }
    return undefined;
  }

  private pump() {
    while (this.running < this.concurrency) {
      const job = this.pop();
      if (!job) return;
      this.running++;
      job
        .run()
        .then(job.resolve, job.reject)
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }
}
