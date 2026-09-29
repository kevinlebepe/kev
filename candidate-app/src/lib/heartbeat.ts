import type { Receipt } from './types';

// Checks in with the server while an exam is open. The reply carries messages
// from the invigilator, the current deadline (it moves when extra time is
// given) and whether the attempt is still open, for example after an
// invigilator ended it. A failed check in is simply tried again next time:
// the exam never depends on it.

export interface InvigilatorMessage {
  id: string;
  seq: number;
  kind: 'message' | 'warning';
  body: string;
  createdAt: string;
}

export interface HeartbeatReply {
  status: string;
  deadlineAt: string;
  serverTime: string;
  messages: InvigilatorMessage[];
  receipt: Receipt | null;
  /** Set once the attempt is closed early. */
  endedBy?: 'invigilator' | 'rules' | null;
  /** A live call the invigilator has started. */
  call?: { id: string; voice: boolean } | null;
}

export interface HeartbeatOptions {
  send(afterSeq: number): Promise<HeartbeatReply>;
  onReply(reply: HeartbeatReply): void;
  intervalMs?: number;
  schedule?(fn: () => void, ms: number): () => void;
}

export const HEARTBEAT_INTERVAL_MS = 10_000;

const realSchedule = (fn: () => void, ms: number) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

export class Heartbeat {
  private afterSeq = 0;
  private cancel: (() => void) | null = null;
  private stopped = false;
  private busy = false;

  constructor(private readonly opts: HeartbeatOptions) {}

  start(): void {
    this.stopped = false;
    void this.beat();
  }

  /** Checks in now, for example when the candidate comes back to the window. */
  async beat(): Promise<void> {
    if (this.stopped || this.busy) return;
    this.busy = true;
    this.cancel?.();
    this.cancel = null;
    try {
      const reply = await this.opts.send(this.afterSeq);
      if (this.stopped) return;
      for (const m of reply.messages) this.afterSeq = Math.max(this.afterSeq, m.seq);
      this.opts.onReply(reply);
    } catch {
      // Offline or a server hiccup: the next check in will catch up.
    } finally {
      this.busy = false;
      if (!this.stopped) this.cancel = (this.opts.schedule ?? realSchedule)(() => void this.beat(), this.opts.intervalMs ?? HEARTBEAT_INTERVAL_MS);
    }
  }

  stop(): void {
    this.stopped = true;
    this.cancel?.();
    this.cancel = null;
  }
}
