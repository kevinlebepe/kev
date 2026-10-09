import { describe, expect, it } from 'vitest';
import { type Ack, type QueuedAnswer, SaveQueue, type SaveStatus } from '../src/lib/saveQueue';

/** Timers the test fires by hand, so nothing depends on real time. */
function fakeTimers() {
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    schedule: (fn: () => void, ms: number) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => void (t.cancelled = true);
    },
    /** Delays of the timers that are still waiting. */
    waiting: () => timers.filter((t) => !t.cancelled).map((t) => t.ms),
    fire: async () => {
      const due = timers.filter((t) => !t.cancelled);
      due.forEach((t) => (t.cancelled = true));
      due.forEach((t) => t.fn());
      await Promise.resolve();
    },
  };
}

const opt = (id: string) => ({ optionId: id });

function setup(overrides: { send?: (a: QueuedAnswer[], p: number | undefined) => Promise<Ack[]>; initial?: QueuedAnswer[]; startSeq?: number } = {}) {
  const timers = fakeTimers();
  const sent: { answers: QueuedAnswer[]; position: number | undefined }[] = [];
  const statuses: SaveStatus[] = [];
  const persisted: QueuedAnswer[][] = [];
  let fatal: unknown = null;
  const queue = new SaveQueue({
    startSeq: overrides.startSeq ?? 0,
    ...(overrides.initial ? { initial: overrides.initial } : {}),
    schedule: timers.schedule,
    send:
      overrides.send ??
      (async (answers, position) => {
        sent.push({ answers, position });
        return answers.map((a) => ({ questionId: a.questionId, seq: a.seq }));
      }),
    persist: (p) => persisted.push(p),
    onStatus: (s) => statuses.push(s),
    isFatal: (e) => (e as { fatal?: boolean }).fatal === true,
    onFatal: (e) => (fatal = e),
  });
  return { queue, timers, sent, statuses, persisted, fatal: () => fatal };
}

describe('SaveQueue', () => {
  it('sends only the latest answer per question, in one batch', async () => {
    const { queue, sent, statuses } = setup();
    queue.enqueue('q1', opt('a'));
    queue.enqueue('q1', opt('b'));
    queue.enqueue('q2', opt('c'));
    await queue.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.answers.map((a) => [a.questionId, a.response])).toEqual([['q1', opt('b')], ['q2', opt('c')]]);
    expect(queue.pending()).toEqual([]);
    expect(statuses).toEqual(['saving', 'saved']);
  });

  it('keeps unsent answers and retries with growing delays when the network fails', async () => {
    let fail = true;
    const { queue, timers, statuses } = setup({
      send: async (answers) => {
        if (fail) throw new Error('network down');
        return answers.map((a) => ({ questionId: a.questionId, seq: a.seq }));
      },
    });
    queue.enqueue('q1', opt('a'));
    await queue.flush();
    expect(queue.status).toBe('offline');
    expect(queue.pending()).toHaveLength(1); // nothing lost
    expect(timers.waiting()).toEqual([1000]);

    await timers.fire();
    await new Promise((r) => setTimeout(r, 0)); // the retry runs and fails again
    expect(timers.waiting()).toEqual([2000]);

    fail = false;
    await timers.fire();
    await new Promise((r) => setTimeout(r, 0));
    expect(queue.pending()).toEqual([]);
    expect(statuses.at(-1)).toBe('saved');
  });

  it('caps the retry delay', async () => {
    const { queue, timers } = setup({ send: async () => { throw new Error('down'); } });
    queue.enqueue('q1', opt('a'));
    for (let i = 0; i < 8; i++) {
      await queue.flush();
      await timers.fire();
    }
    await queue.flush();
    expect(timers.waiting()).toEqual([15000]);
  });

  it('does not drop an answer changed while the previous request was in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: QueuedAnswer[][] = [];
    const { queue } = setup({
      send: async (answers) => {
        calls.push(answers);
        if (calls.length === 1) await gate;
        return answers.map((a) => ({ questionId: a.questionId, seq: a.seq }));
      },
    });
    queue.enqueue('q1', opt('a'));
    const flushing = queue.flush();
    await Promise.resolve();
    queue.enqueue('q1', opt('b')); // edited while request 1 is still out
    release();
    await flushing;

    expect(calls).toHaveLength(2);
    expect(calls[1]![0]!.response).toEqual(opt('b'));
    expect(queue.pending()).toEqual([]);
  });

  it('keeps an answer when the server acknowledges only an older version', async () => {
    const { queue } = setup({ send: async (answers) => answers.map((a) => ({ questionId: a.questionId, seq: a.seq - 1 })) });
    queue.enqueue('q1', opt('a'));
    await queue.flush();
    expect(queue.pending()).toHaveLength(1);
    expect(queue.status).toBe('offline'); // and it will be retried, not spun on
  });

  it('accepts a newer server version as acknowledgement', async () => {
    const { queue } = setup({ send: async (answers) => answers.map((a) => ({ questionId: a.questionId, seq: a.seq + 10 })) });
    queue.enqueue('q1', opt('a'));
    await queue.flush();
    expect(queue.pending()).toEqual([]);
  });

  it('persists the unsent set after every change, ending empty', async () => {
    const { queue, persisted } = setup();
    queue.enqueue('q1', opt('a'));
    queue.enqueue('q2', opt('b'));
    await queue.flush();
    expect(persisted.map((p) => p.length)).toEqual([1, 2, 0]);
  });

  it('resumes from saved local answers and keeps sequence numbers increasing', async () => {
    const initial: QueuedAnswer[] = [{ questionId: 'q1', seq: 41, response: opt('a') }];
    const { queue, timers, sent } = setup({ initial, startSeq: 12 });
    expect(timers.waiting()).toEqual([]); // nothing is sent until the queue is resumed
    queue.resume();
    expect(timers.waiting()).toEqual([0]); // recovered answers go out straight away
    await timers.fire();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent[0]!.answers[0]!.seq).toBe(41);
    expect(queue.enqueue('q2', opt('b')).seq).toBe(42);
  });

  it('stops for good on a fatal error and reports it once', async () => {
    const error = Object.assign(new Error('closed'), { fatal: true });
    const { queue, timers, fatal } = setup({ send: async () => { throw error; } });
    queue.enqueue('q1', opt('a'));
    await queue.flush();
    expect(queue.status).toBe('closed');
    expect(fatal()).toBe(error);
    expect(timers.waiting()).toEqual([]);
    queue.enqueue('q1', opt('b'));
    expect(timers.waiting()).toEqual([]); // no more sends once closed
  });

  it('sends a position change even when no answer changed', async () => {
    const { queue, sent } = setup();
    queue.setPosition(3);
    await queue.flush();
    expect(sent).toEqual([{ answers: [], position: 3 }]);
    await queue.flush();
    expect(sent).toHaveLength(1); // not sent again
  });

  it('waits before sending typed text so it does not send every keystroke', () => {
    const { queue, timers } = setup();
    queue.enqueue('q1', { text: 'P' }, 800);
    queue.enqueue('q1', { text: 'Pa' }, 800);
    expect(timers.waiting()).toEqual([800]); // one timer, restarted
  });
});
