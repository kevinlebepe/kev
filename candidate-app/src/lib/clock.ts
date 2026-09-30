// The server decides when an exam ends; the app only displays the countdown.
// The countdown is anchored to the server's clock and advances with the larger
// of two local clocks: the monotonic clock is immune to the candidate changing
// the system time, but pauses when a laptop sleeps, while the wall clock keeps
// running through sleep. Taking the larger elapsed value means neither trick
// buys extra time. Every server response re-anchors it.

export interface ClockSources {
  mono: () => number;
  wall: () => number;
}

const realSources: ClockSources = { mono: () => performance.now(), wall: () => Date.now() };

export interface ServerClock {
  /** Current server time in ms since the epoch. */
  now(): number;
  /** Re-anchor to a server timestamp taken from a response. */
  sync(serverTimeIso: string): void;
}

export function createServerClock(serverTimeIso: string, sources: ClockSources = realSources): ServerClock {
  let base = Date.parse(serverTimeIso);
  let mono0 = sources.mono();
  let wall0 = sources.wall();

  return {
    now: () => base + Math.max(0, sources.mono() - mono0, sources.wall() - wall0),
    sync(iso) {
      base = Date.parse(iso);
      mono0 = sources.mono();
      wall0 = sources.wall();
    },
  };
}

/** 7384000 ms becomes "02:03:04". Never negative. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

export type TimeWarning = 'none' | 'five_minutes' | 'one_minute';

export function timeWarning(remainingMs: number): TimeWarning {
  if (remainingMs <= 60_000) return 'one_minute';
  if (remainingMs <= 300_000) return 'five_minutes';
  return 'none';
}
