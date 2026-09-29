import { describe, expect, it, vi } from 'vitest';
import { FrameRecorder, type Piece, PieceUploader, type RecorderLike, RecordingSession, SegmentRecorder, sha256Hex } from '../src/lib/recording';
import { streamsFor } from '../src/lib/examRecording';

function timers() {
  const due: { fn: () => void; ms: number }[] = [];
  return {
    schedule: (fn: () => void, ms: number) => {
      const t = { fn, ms };
      due.push(t);
      return () => {
        const i = due.indexOf(t);
        if (i >= 0) due.splice(i, 1);
      };
    },
    fire() {
      const t = due.shift();
      t?.fn();
      return t;
    },
    count: () => due.length,
    fireMs(ms: number) {
      const i = due.findIndex((t) => t.ms === ms);
      if (i < 0) throw new Error(`No timer of ${ms} ms`);
      const [t] = due.splice(i, 1);
      t!.fn();
    },
  };
}

/** A recorder that produces one blob per segment, like MediaRecorder does when stopped. */
function fakeRecorders() {
  let n = 0;
  const made: RecorderLike[] = [];
  const create = (): RecorderLike => {
    const id = n++;
    const rec: RecorderLike = {
      mimeType: 'video/webm;codecs=vp8',
      ondataavailable: null,
      onstop: null,
      start() {},
      stop() {
        rec.ondataavailable?.({ data: new Blob([`segment ${id}`]) });
        rec.onstop?.();
      },
    };
    made.push(rec);
    return rec;
  };
  return { create, made };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('segment recorder', () => {
  it('cuts the stream into numbered, standalone pieces and finishes the last one on stop', async () => {
    const t = timers();
    const r = fakeRecorders();
    const pieces: Piece[] = [];
    const rec = new SegmentRecorder({ stream: 'camera', createRecorder: r.create, segmentMs: 30_000, onPiece: (p) => pieces.push(p), schedule: t.schedule });
    expect(rec.lastSequence).toBe(-1);
    rec.start();
    t.fire();
    t.fire();
    await rec.stop();
    expect(pieces.map((p) => [p.stream, p.sequence, p.blob.type])).toEqual([
      ['camera', 0, 'video/webm'],
      ['camera', 1, 'video/webm'],
      ['camera', 2, 'video/webm'],
    ]);
    expect(await pieces[1]!.blob.text()).toBe('segment 1');
    expect(rec.lastSequence).toBe(2);
    expect(t.count()).toBe(0);
    expect(r.made).toHaveLength(3);
  });

  it('carries on numbering after a reopened exam', async () => {
    const r = fakeRecorders();
    const pieces: Piece[] = [];
    const rec = new SegmentRecorder({ stream: 'screen', createRecorder: r.create, segmentMs: 1, onPiece: (p) => pieces.push(p), firstSequence: 7, schedule: timers().schedule });
    rec.start();
    await rec.stop();
    expect(pieces[0]!.sequence).toBe(7);
  });
});

describe('frame recorder', () => {
  it('takes a picture now, on every tick and a last one on stop, skipping failed captures', async () => {
    const t = timers();
    const results = [new Blob(['a']), null, new Blob(['c']), new Blob(['d'])];
    const pieces: Piece[] = [];
    const rec = new FrameRecorder({ stream: 'screen', everyMs: 10_000, capture: async () => results.shift() ?? null, onPiece: (p) => pieces.push(p), every: t.schedule });
    rec.start();
    await flush();
    t.fire();
    await flush();
    await rec.stop();
    expect(pieces.map((p) => p.sequence)).toEqual([0, 1]);
    expect(rec.lastSequence).toBe(1);
  });
});

describe('piece uploader', () => {
  const piece = (sequence: number): Piece => ({ stream: 'camera', sequence, blob: new Blob([String(sequence)]), start: new Date(), end: new Date() });

  it('sends in order and retries a failed piece before moving on', async () => {
    const t = timers();
    const sent: number[] = [];
    let fail = true;
    const up = new PieceUploader({
      send: async (p) => {
        if (p.sequence === 1 && fail) {
          fail = false;
          throw new Error('offline');
        }
        sent.push(p.sequence);
      },
      schedule: t.schedule,
    });
    [0, 1, 2].forEach((i) => up.add(piece(i)));
    await flush();
    expect(sent).toEqual([0]);
    expect(up.pending()).toBe(2);
    t.fire();
    await flush();
    expect(sent).toEqual([0, 1, 2]);
    expect(up.pending()).toBe(0);
  });

  it('drops a piece the server will never accept', async () => {
    const sent: number[] = [];
    const up = new PieceUploader({
      send: async (p) => {
        if (p.sequence === 0) throw new Error('409');
        sent.push(p.sequence);
      },
      isFatal: () => true,
    });
    up.add(piece(0));
    up.add(piece(1));
    await flush();
    expect(sent).toEqual([1]);
  });

  it('drains, retrying at once, and gives up after the time limit', async () => {
    const t = timers();
    let online = false;
    const up = new PieceUploader({
      send: async () => {
        if (!online) throw new Error('offline');
      },
      schedule: t.schedule,
    });
    up.add(piece(0));
    await flush();
    const first = up.drain(60_000);
    await flush();
    t.fireMs(60_000);
    expect(await first).toBe(false);
    expect(up.pending()).toBe(1);

    // The connection returns: draining retries straight away instead of waiting.
    online = true;
    const second = up.drain(60_000);
    await flush();
    expect(await second).toBe(true);
    expect(up.pending()).toBe(0);
  });
});

describe('recording session', () => {
  it('stops everything, sends what is left, then declares the last pieces', async () => {
    const order: string[] = [];
    const up = new PieceUploader({ send: async (p) => void order.push(`send ${p.stream} ${p.sequence}`) });
    const r = fakeRecorders();
    const camera = new SegmentRecorder({ stream: 'camera', createRecorder: r.create, segmentMs: 30_000, onPiece: (p) => up.add(p), schedule: timers().schedule });
    const complete = vi.fn(async (last: object) => void order.push(`complete ${JSON.stringify(last)}`));
    const session = new RecordingSession([{ stream: 'camera', recorder: camera }], up, complete);
    session.start();
    const result = await session.finish();
    expect(result).toEqual({ complete: true });
    expect(order).toEqual(['send camera 0', 'complete {"camera":0}']);
    expect(await session.finish()).toEqual({ complete: true });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('reports an incomplete recording when the declaration fails', async () => {
    const up = new PieceUploader({ send: async () => {} });
    const session = new RecordingSession([], up, async () => {
      throw new Error('offline');
    });
    expect(await session.finish()).toEqual({ complete: false });
  });
});

describe('streams and checksums', () => {
  it('asks for the same streams as the server', () => {
    expect(streamsFor({ camera: false, microphone: false, screen: false })).toEqual([]);
    expect(streamsFor({ camera: true, microphone: true, screen: true })).toEqual(['camera', 'screen']);
    expect(streamsFor({ camera: false, microphone: true, screen: false })).toEqual(['audio']);
  });

  it('computes a SHA-256 the server can check', async () => {
    expect(await sha256Hex(new Blob(['abc']))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
