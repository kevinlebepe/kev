import type { AnswerResponse } from './types';

// Autosave with retry (spec sections 9 and 11). Every answer is given a
// sequence number and kept until the server acknowledges it, so a dropped
// connection loses nothing and a retry can never overwrite a newer answer.

export interface QueuedAnswer {
  questionId: string;
  seq: number;
  response: AnswerResponse;
}

export interface Ack {
  questionId: string;
  seq: number;
}

export type SaveStatus = 'saved' | 'saving' | 'offline' | 'closed';

export interface SaveQueueOptions {
  send(answers: QueuedAnswer[], position: number | undefined): Promise<Ack[]>;
  /** Called whenever the unsent set changes, so it survives a restart. */
  persist?(pending: QueuedAnswer[]): void;
  onStatus?(status: SaveStatus): void;
  /** A fatal error (for example the attempt was closed) stops all retrying. */
  isFatal?(err: unknown): boolean;
  onFatal?(err: unknown): void;
  /** Highest sequence number already used, so new ones keep increasing. */
  startSeq: number;
  /** Unsent answers recovered from local storage. */
  initial?: QueuedAnswer[];
  schedule?(fn: () => void, ms: number): () => void;
  retryDelaysMs?: number[];
}

const realSchedule = (fn: () => void, ms: number) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

export class SaveQueue {
  status: SaveStatus = 'saved';

  private seq: number;
  private readonly pendingMap = new Map<string, QueuedAnswer>();
  private position: number | undefined;
  private positionDirty = false;
  private inFlight: Promise<void> | null = null;
  private failures = 0;
  private cancelTimer: (() => void) | null = null;
  private closed = false;

  constructor(private readonly opts: SaveQueueOptions) {
    this.seq = opts.startSeq;
    for (const a of opts.initial ?? []) {
      this.pendingMap.set(a.questionId, a);
      this.seq = Math.max(this.seq, a.seq);
    }
  }

  /** Starts sending any answers recovered from local storage. Call once the queue is in use. */
  resume(): void {
    if (this.pendingMap.size) this.schedule(0);
  }

  /** Records an answer immediately; sending happens after `delayMs` (used to batch typing). */
  enqueue(questionId: string, response: AnswerResponse, delayMs = 0): QueuedAnswer {
    const entry: QueuedAnswer = { questionId, seq: ++this.seq, response };
    if (this.closed) return entry;
    this.pendingMap.set(questionId, entry);
    this.opts.persist?.(this.pending());
    this.schedule(delayMs);
    return entry;
  }

  setPosition(position: number): void {
    if (this.closed) return;
    this.position = position;
    this.positionDirty = true;
    this.schedule(300);
  }

  pending(): QueuedAnswer[] {
    return [...this.pendingMap.values()].sort((a, b) => a.seq - b.seq);
  }

  /** Sends everything now. Resolves when the queue is empty or a send failed. */
  flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    if (!this.pendingMap.size && !this.positionDirty) return Promise.resolve();
    this.cancelPending();
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  dispose(): void {
    this.closed = true;
    this.cancelPending();
  }

  private schedule(ms: number): void {
    this.cancelPending();
    this.cancelTimer = (this.opts.schedule ?? realSchedule)(() => {
      this.cancelTimer = null;
      void this.flush();
    }, ms);
  }

  private cancelPending(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  private setStatus(status: SaveStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.opts.onStatus?.(status);
  }

  private async run(): Promise<void> {
    while (!this.closed && (this.pendingMap.size || this.positionDirty)) {
      const batch = this.pending();
      const sentPosition = this.positionDirty ? this.position : undefined;
      this.setStatus('saving');
      try {
        const acks = await this.opts.send(batch, sentPosition);
        for (const ack of acks) {
          const current = this.pendingMap.get(ack.questionId);
          // Keep the entry if the answer changed while this request was in flight.
          if (current && current.seq <= ack.seq) this.pendingMap.delete(ack.questionId);
        }
        // Progress means the server confirmed at least one answer we sent, even
        // if it has since been superseded. Without it we would resend forever.
        const confirmed = batch.some((sent) => acks.some((a) => a.questionId === sent.questionId && a.seq >= sent.seq));
        if (batch.length > 0 && !confirmed) throw new Error('The server did not acknowledge the saved answers');
        if (sentPosition !== undefined && this.position === sentPosition) this.positionDirty = false;
        this.failures = 0;
        this.opts.persist?.(this.pending());
      } catch (err) {
        if (this.opts.isFatal?.(err)) {
          this.closed = true;
          this.setStatus('closed');
          this.opts.onFatal?.(err);
          return;
        }
        this.failures += 1;
        this.setStatus('offline');
        const delays = this.opts.retryDelaysMs ?? [1000, 2000, 4000, 8000, 15000];
        this.schedule(delays[Math.min(this.failures - 1, delays.length - 1)] ?? 15000);
        return;
      }
    }
    if (!this.closed) this.setStatus('saved');
  }
}
