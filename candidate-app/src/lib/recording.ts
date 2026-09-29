// Records the candidate during the exam and uploads the recording in pieces
// (spec section 12). Each piece is a complete file, so a piece lost to a bad
// connection leaves a gap rather than spoiling the rest. Pieces are sent in
// order with retries, each with a checksum, and the server keeps each one
// exactly once. When the exam ends the app sends what is left, then tells the
// server the number of the last piece of each stream so it can check nothing
// is missing before it marks the submission verified.

export type StreamKind = 'camera' | 'audio' | 'screen';

export interface Piece {
  stream: StreamKind;
  sequence: number;
  blob: Blob;
  start: Date;
  end: Date;
}

/** The parts of MediaRecorder this module uses, so tests can supply a fake. */
export interface RecorderLike {
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  start(): void;
  stop(): void;
}

type Schedule = (fn: () => void, ms: number) => () => void;
const realSchedule: Schedule = (fn, ms) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};
const realEvery: Schedule = (fn, ms) => {
  const id = setInterval(fn, ms);
  return () => clearInterval(id);
};

/** Records a media stream as a series of standalone pieces of `segmentMs` each. */
export class SegmentRecorder {
  private sequence: number;
  private current: RecorderLike | null = null;
  private cancelTimer: (() => void) | null = null;
  private stopping = false;
  private finished: Promise<void> | null = null;
  private resolveFinished: (() => void) | null = null;

  constructor(
    private readonly opts: {
      stream: StreamKind;
      createRecorder(): RecorderLike;
      segmentMs: number;
      onPiece(piece: Piece): void;
      /** Where numbering starts: after the pieces the server already has, when an exam is reopened. */
      firstSequence?: number;
      schedule?: Schedule;
      now?(): Date;
    },
  ) {
    this.sequence = opts.firstSequence ?? 0;
  }

  /** The number of the last piece produced, or -1 before the first. */
  get lastSequence(): number {
    return this.sequence - 1;
  }

  start(): void {
    this.stopping = false;
    this.next();
  }

  private next(): void {
    const rec = this.opts.createRecorder();
    const parts: Blob[] = [];
    const start = this.opts.now?.() ?? new Date();
    rec.ondataavailable = (e) => {
      if (e.data.size) parts.push(e.data);
    };
    rec.onstop = () => {
      const blob = new Blob(parts, { type: rec.mimeType.split(';')[0] || 'video/webm' });
      if (blob.size) this.opts.onPiece({ stream: this.opts.stream, sequence: this.sequence++, blob, start, end: this.opts.now?.() ?? new Date() });
      if (this.stopping) {
        this.current = null;
        this.resolveFinished?.();
      } else this.next();
    };
    this.current = rec;
    rec.start();
    this.cancelTimer = (this.opts.schedule ?? realSchedule)(() => rec.stop(), this.opts.segmentMs);
  }

  /** Ends the current piece and resolves once it has been handed over. */
  stop(): Promise<void> {
    if (this.finished) return this.finished;
    this.stopping = true;
    this.cancelTimer?.();
    if (!this.current) return (this.finished = Promise.resolve());
    this.finished = new Promise((resolve) => (this.resolveFinished = resolve));
    try {
      this.current.stop();
    } catch {
      this.resolveFinished?.();
    }
    return this.finished;
  }
}

/** Takes a still picture every `everyMs`, each one a piece of the stream. */
export class FrameRecorder {
  private sequence: number;
  private cancel: (() => void) | null = null;
  private busy = false;

  constructor(
    private readonly opts: {
      stream: StreamKind;
      capture(): Promise<Blob | null>;
      everyMs: number;
      onPiece(p: Piece): void;
      firstSequence?: number;
      every?: Schedule;
      now?(): Date;
    },
  ) {
    this.sequence = opts.firstSequence ?? 0;
  }

  get lastSequence(): number {
    return this.sequence - 1;
  }

  start(): void {
    void this.take();
    this.cancel = (this.opts.every ?? realEvery)(() => void this.take(), this.opts.everyMs);
  }

  async take(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const at = this.opts.now?.() ?? new Date();
      const blob = await this.opts.capture().catch(() => null);
      if (blob?.size) this.opts.onPiece({ stream: this.opts.stream, sequence: this.sequence++, blob, start: at, end: at });
    } finally {
      this.busy = false;
    }
  }

  async stop(): Promise<void> {
    this.cancel?.();
    this.cancel = null;
    await this.take();
  }
}

/** Uploads pieces one at a time, in order, retrying until each is accepted. */
export class PieceUploader {
  private queue: Piece[] = [];
  private running = false;
  private failures = 0;
  private cancelRetry: (() => void) | null = null;
  private waiters: (() => void)[] = [];

  constructor(
    private readonly opts: {
      send(piece: Piece): Promise<void>;
      /** A piece the server will never accept (for example a closed attempt) is dropped. */
      isFatal?(err: unknown): boolean;
      onChange?(pending: number): void;
      retryDelaysMs?: number[];
      schedule?: Schedule;
    },
  ) {}

  pending(): number {
    return this.queue.length;
  }

  add(piece: Piece): void {
    this.queue.push(piece);
    this.opts.onChange?.(this.queue.length);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const piece = this.queue[0]!;
        try {
          await this.opts.send(piece);
          this.failures = 0;
        } catch (err) {
          if (!this.opts.isFatal?.(err)) {
            const delays = this.opts.retryDelaysMs ?? [1000, 2000, 5000, 10000, 30000];
            const delay = delays[Math.min(this.failures, delays.length - 1)]!;
            this.failures += 1;
            this.cancelRetry = (this.opts.schedule ?? realSchedule)(() => {
              this.cancelRetry = null;
              void this.pump();
            }, delay);
            return;
          }
        }
        this.queue.shift();
        this.opts.onChange?.(this.queue.length);
      }
      for (const w of this.waiters.splice(0)) w();
    } finally {
      this.running = false;
    }
  }

  /** Tries again now, for example when the connection returns. */
  retryNow(): void {
    if (this.cancelRetry) {
      this.cancelRetry();
      this.cancelRetry = null;
      void this.pump();
    }
  }

  /** Resolves true once everything is sent, or false after `timeoutMs`. */
  drain(timeoutMs: number): Promise<boolean> {
    if (!this.queue.length) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = () => {
        cancel();
        resolve(true);
      };
      const cancel = (this.opts.schedule ?? realSchedule)(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve(false);
      }, timeoutMs);
      this.waiters.push(done);
      this.retryNow();
    });
  }
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface Source {
  stream: StreamKind;
  recorder: { start(): void; stop(): Promise<void>; readonly lastSequence: number };
}

/** Runs every recorder of one attempt and finishes them together. */
export class RecordingSession {
  private finishing: Promise<{ complete: boolean }> | null = null;

  constructor(
    private readonly sources: Source[],
    private readonly uploader: PieceUploader,
    private readonly complete: (lastSequences: Partial<Record<StreamKind, number>>) => Promise<void>,
  ) {}

  get streams(): StreamKind[] {
    return this.sources.map((s) => s.stream);
  }

  start(): void {
    for (const s of this.sources) s.recorder.start();
  }

  /** Stops recording, sends what is left and declares the last pieces. Safe to call more than once. */
  finish(timeoutMs = 5 * 60_000): Promise<{ complete: boolean }> {
    this.finishing ??= (async () => {
      await Promise.all(this.sources.map((s) => s.recorder.stop()));
      const sent = await this.uploader.drain(timeoutMs);
      const last = Object.fromEntries(this.sources.map((s) => [s.stream, s.recorder.lastSequence])) as Partial<Record<StreamKind, number>>;
      try {
        await this.complete(last);
      } catch {
        return { complete: false };
      }
      return { complete: sent };
    })();
    return this.finishing;
  }
}
