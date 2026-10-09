import { describe, expect, it, vi } from 'vitest';
import { Heartbeat, type HeartbeatReply } from '../src/lib/heartbeat';

const reply = (messages: { seq: number }[] = [], status = 'active'): HeartbeatReply => ({
  status,
  deadlineAt: '2030-01-01T10:00:00.000Z',
  serverTime: '2030-01-01T09:00:00.000Z',
  messages: messages.map((m) => ({ id: `m${m.seq}`, seq: m.seq, kind: 'message', body: `hello ${m.seq}`, createdAt: '' })),
  receipt: null,
});

function manualTimers() {
  const due: (() => void)[] = [];
  return {
    schedule: (fn: () => void) => {
      due.push(fn);
      return () => due.splice(due.indexOf(fn), 1);
    },
    fire: async () => {
      const fn = due.shift();
      fn?.();
      await Promise.resolve();
      await Promise.resolve();
    },
    pending: () => due.length,
  };
}

describe('heartbeat', () => {
  it('asks only for messages it has not seen', async () => {
    const timers = manualTimers();
    const send = vi.fn().mockResolvedValueOnce(reply([{ seq: 3 }, { seq: 5 }])).mockResolvedValue(reply());
    const onReply = vi.fn();
    const hb = new Heartbeat({ send, onReply, schedule: timers.schedule });
    await hb.beat();
    await timers.fire();
    expect(send.mock.calls.map((c) => c[0])).toEqual([0, 5]);
    expect(onReply).toHaveBeenCalledTimes(2);
  });

  it('keeps going after a failure without reporting it', async () => {
    const timers = manualTimers();
    const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(reply());
    const onReply = vi.fn();
    const hb = new Heartbeat({ send, onReply, schedule: timers.schedule });
    await hb.beat();
    expect(onReply).not.toHaveBeenCalled();
    expect(timers.pending()).toBe(1);
    await timers.fire();
    expect(onReply).toHaveBeenCalledTimes(1);
  });

  it('stops for good, even if a reply arrives afterwards', async () => {
    const timers = manualTimers();
    let resolve!: (r: HeartbeatReply) => void;
    const send = vi.fn(() => new Promise<HeartbeatReply>((r) => (resolve = r)));
    const onReply = vi.fn();
    const hb = new Heartbeat({ send, onReply, schedule: timers.schedule });
    const beat = hb.beat();
    hb.stop();
    resolve(reply());
    await beat;
    expect(onReply).not.toHaveBeenCalled();
    expect(timers.pending()).toBe(0);
  });

  it('does not overlap check ins', async () => {
    const send = vi.fn(() => new Promise<HeartbeatReply>(() => {}));
    const hb = new Heartbeat({ send, onReply: () => {}, schedule: () => () => {} });
    void hb.beat();
    void hb.beat();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
