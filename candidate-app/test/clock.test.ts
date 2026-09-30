import { describe, expect, it } from 'vitest';
import { createServerClock, formatDuration, timeWarning } from '../src/lib/clock';

function sources() {
  const t = { mono: 1000, wall: 1_700_000_000_000 };
  return { t, s: { mono: () => t.mono, wall: () => t.wall } };
}

describe('server clock', () => {
  it('advances from the server time as real time passes', () => {
    const { t, s } = sources();
    const clock = createServerClock('2026-10-14T09:00:00.000Z', s);
    t.mono += 5000;
    t.wall += 5000;
    expect(clock.now()).toBe(Date.parse('2026-10-14T09:00:05.000Z'));
  });

  it('cannot be slowed down by setting the system clock back', () => {
    const { t, s } = sources();
    const clock = createServerClock('2026-10-14T09:00:00.000Z', s);
    t.mono += 60_000;
    t.wall -= 3_600_000; // candidate moves the system clock back an hour
    expect(clock.now()).toBe(Date.parse('2026-10-14T09:01:00.000Z'));
  });

  it('keeps counting through laptop sleep, when the monotonic clock pauses', () => {
    const { t, s } = sources();
    const clock = createServerClock('2026-10-14T09:00:00.000Z', s);
    t.mono += 1000;
    t.wall += 600_000; // ten minutes asleep
    expect(clock.now()).toBe(Date.parse('2026-10-14T09:10:00.000Z'));
  });

  it('re-anchors to each server response', () => {
    const { t, s } = sources();
    const clock = createServerClock('2026-10-14T09:00:00.000Z', s);
    t.mono += 10_000;
    t.wall += 10_000;
    clock.sync('2026-10-14T09:00:12.000Z'); // the server says 12s have passed
    expect(clock.now()).toBe(Date.parse('2026-10-14T09:00:12.000Z'));
    t.mono += 1000;
    t.wall += 1000;
    expect(clock.now()).toBe(Date.parse('2026-10-14T09:00:13.000Z'));
  });
});

describe('formatting', () => {
  it('formats a countdown and never goes negative', () => {
    expect(formatDuration(7_384_000)).toBe('02:03:04');
    expect(formatDuration(59_001)).toBe('00:01:00'); // rounds up, so 00:00:00 means truly out of time
    expect(formatDuration(0)).toBe('00:00:00');
    expect(formatDuration(-5000)).toBe('00:00:00');
  });

  it('warns at five minutes and one minute', () => {
    expect(timeWarning(301_000)).toBe('none');
    expect(timeWarning(300_000)).toBe('five_minutes');
    expect(timeWarning(61_000)).toBe('five_minutes');
    expect(timeWarning(60_000)).toBe('one_minute');
    expect(timeWarning(-1)).toBe('one_minute');
  });
});
