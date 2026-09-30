import type { PendingEvent, RuleEventType, RulesReply } from './types';

// Sends rule events to the server and keeps them until they are acknowledged
// (spec sections 11 and 16). Each event has an id chosen here, so a retry
// after a lost response cannot record it twice. If the connection is down the
// events wait, and are also kept on the device, so a violation cannot be
// hidden by going offline.

export interface EventReporterOptions {
  send(events: PendingEvent[], keepalive: boolean): Promise<RulesReply>;
  persist?(events: PendingEvent[]): void;
  /** Called with the server's decision after every successful send. */
  onReply?(reply: RulesReply): void;
  isFatal?(err: unknown): boolean;
  onFatal?(err: unknown): void;
  initial?: PendingEvent[];
  schedule?(fn: () => void, ms: number): () => void;
  retryDelaysMs?: number[];
  newId?(): string;
  now?(): Date;
}

const MAX_PER_REQUEST = 50;

const realSchedule = (fn: () => void, ms: number) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

export class EventReporter {
  private queue: PendingEvent[];
  private inFlight: Promise<void> | null = null;
  private failures = 0;
  private cancelTimer: (() => void) | null = null;
  private closed = false;

  constructor(private readonly opts: EventReporterOptions) {
    this.queue = [...(opts.initial ?? [])];
  }

  /** Sends anything recovered from the device. Call once the reporter is in use. */
  resume(): void {
    if (this.queue.length) this.schedule(0);
  }

  report(type: RuleEventType, data?: Record<string, string | number | boolean>): void {
    if (this.closed) return;
    const event: PendingEvent = {
      id: this.opts.newId?.() ?? crypto.randomUUID(),
      type,
      occurredAt: (this.opts.now?.() ?? new Date()).toISOString(),
      ...(data ? { data } : {}),
    };
    this.queue.push(event);
    this.opts.persist?.([...this.queue]);
    this.schedule(0);
  }

  pending(): PendingEvent[] {
    return [...this.queue];
  }

  /** `keepalive` lets the request survive the page closing. */
  flush(options: { keepalive?: boolean } = {}): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    if (!this.queue.length) return Promise.resolve();
    this.cancelPending();
    this.inFlight = this.run(options.keepalive ?? false).finally(() => {
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

  private async run(keepalive: boolean): Promise<void> {
    while (!this.closed && this.queue.length) {
      const batch = this.queue.slice(0, MAX_PER_REQUEST);
      try {
        const reply = await this.opts.send(batch, keepalive);
        const sent = new Set(batch.map((e) => e.id));
        this.queue = this.queue.filter((e) => !sent.has(e.id));
        this.failures = 0;
        this.opts.persist?.([...this.queue]);
        this.opts.onReply?.(reply);
      } catch (err) {
        if (this.opts.isFatal?.(err)) {
          this.closed = true;
          this.opts.onFatal?.(err);
          return;
        }
        this.failures += 1;
        const delays = this.opts.retryDelaysMs ?? [1000, 2000, 4000, 8000, 15000];
        this.schedule(delays[Math.min(this.failures - 1, delays.length - 1)] ?? 15000);
        return;
      }
    }
  }
}
