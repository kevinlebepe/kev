import { describe, expect, it } from 'vitest';
import { EventReporter } from '../src/lib/eventReporter';
import type { PendingEvent, RulesReply } from '../src/lib/types';

function fakeTimers() {
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    schedule: (fn: () => void, ms: number) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => void (t.cancelled = true);
    },
    waiting: () => timers.filter((t) => !t.cancelled).map((t) => t.ms),
    fire: async () => {
      const due = timers.filter((t) => !t.cancelled);
      due.forEach((t) => (t.cancelled = true));
      due.forEach((t) => t.fn());
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

const reply = (over: Partial<RulesReply> = {}): RulesReply => ({ violations: 1, policy: 'flag', maxViolations: 3, action: 'recorded', ...over });

function setup(over: { send?: (e: PendingEvent[], keepalive: boolean) => Promise<RulesReply>; initial?: PendingEvent[] } = {}) {
  const timers = fakeTimers();
  const sent: { events: PendingEvent[]; keepalive: boolean }[] = [];
  const replies: RulesReply[] = [];
  const persisted: PendingEvent[][] = [];
  let n = 0;
  let fatal: unknown = null;
  const reporter = new EventReporter({
    schedule: timers.schedule,
    newId: () => `id-${++n}`,
    now: () => new Date('2026-10-14T09:00:00Z'),
    ...(over.initial ? { initial: over.initial } : {}),
    send:
      over.send ??
      (async (events, keepalive) => {
        sent.push({ events, keepalive });
        return reply();
      }),
    persist: (e) => persisted.push(e),
    onReply: (r) => replies.push(r),
    isFatal: (e) => (e as { fatal?: boolean }).fatal === true,
    onFatal: (e) => (fatal = e),
  });
  return { reporter, timers, sent, replies, persisted, fatal: () => fatal };
}

describe('EventReporter', () => {
  it('sends events in order, then passes on the server decision', async () => {
    const { reporter, sent, replies } = setup();
    reporter.report('left_window', { reason: 'tab_hidden' });
    reporter.report('returned_window', { awayMs: 5000 });
    await reporter.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.events.map((e) => [e.id, e.type, e.occurredAt])).toEqual([
      ['id-1', 'left_window', '2026-10-14T09:00:00.000Z'],
      ['id-2', 'returned_window', '2026-10-14T09:00:00.000Z'],
    ]);
    expect(reporter.pending()).toEqual([]);
    expect(replies).toEqual([reply()]);
  });

  it('keeps events when the network is down and resends the same ones, never new ids', async () => {
    let fail = true;
    const seen: string[][] = [];
    const { reporter, timers } = setup({
      send: async (events) => {
        seen.push(events.map((e) => e.id));
        if (fail) throw new Error('offline');
        return reply();
      },
    });
    reporter.report('left_fullscreen');
    await reporter.flush();
    expect(reporter.pending()).toHaveLength(1);
    expect(timers.waiting()).toEqual([1000]);

    reporter.report('left_window'); // a second violation while offline
    fail = false;
    await timers.fire();
    expect(reporter.pending()).toEqual([]);
    expect(seen).toEqual([['id-1'], ['id-1', 'id-2']]);
  });

  it('backs off between retries and caps the delay', async () => {
    const { reporter, timers } = setup({ send: async () => { throw new Error('offline'); } });
    reporter.report('left_window');
    for (let i = 0; i < 8; i++) {
      await reporter.flush();
      await timers.fire();
    }
    await reporter.flush();
    expect(timers.waiting()).toEqual([15000]);
  });

  it('persists the unsent events after every change, ending empty', async () => {
    const { reporter, persisted } = setup();
    reporter.report('left_window');
    reporter.report('left_fullscreen');
    await reporter.flush();
    expect(persisted.map((p) => p.length)).toEqual([1, 2, 0]);
  });

  it('resumes events left on the device from an earlier run', async () => {
    const initial: PendingEvent[] = [{ id: 'old-1', type: 'close_attempt', occurredAt: '2026-10-14T08:59:00.000Z' }];
    const { reporter, timers, sent } = setup({ initial });
    expect(timers.waiting()).toEqual([]);
    reporter.resume();
    await timers.fire();
    expect(sent[0]!.events.map((e) => e.id)).toEqual(['old-1']);
  });

  it('asks the browser to keep the request alive when the page is closing', async () => {
    const { reporter, sent } = setup();
    reporter.report('close_attempt');
    await reporter.flush({ keepalive: true });
    expect(sent[0]!.keepalive).toBe(true);
  });

  it('sends at most 50 events per request', async () => {
    const { reporter, sent } = setup();
    for (let i = 0; i < 120; i++) reporter.report('context_menu');
    await reporter.flush();
    expect(sent.map((s) => s.events.length)).toEqual([50, 50, 20]);
    expect(reporter.pending()).toEqual([]);
  });

  it('stops for good on a fatal error', async () => {
    const error = Object.assign(new Error('closed'), { fatal: true });
    const { reporter, timers, fatal } = setup({ send: async () => { throw error; } });
    reporter.report('left_window');
    await reporter.flush();
    expect(fatal()).toBe(error);
    expect(timers.waiting()).toEqual([]);
    reporter.report('left_window');
    expect(timers.waiting()).toEqual([]);
  });
});
