import { afterEach, describe, expect, it, vi } from 'vitest';
import { enterFullscreen, exitFullscreen, fullscreenSupported } from '../src/lib/fullscreen';

function fakeDoc(over: { request?: () => Promise<void>; startsFullscreen?: boolean } = {}) {
  const doc = {
    fullscreenElement: over.startsFullscreen ? {} : null,
    documentElement: {
      requestFullscreen:
        over.request ??
        (async () => {
          doc.fullscreenElement = {};
        }),
    },
    exitFullscreen: vi.fn(async () => {
      doc.fullscreenElement = null;
    }),
  };
  return doc as unknown as Document & { exitFullscreen: ReturnType<typeof vi.fn> };
}

afterEach(() => vi.unstubAllGlobals());

describe('full screen helpers', () => {
  it('enters full screen and locks Escape where the browser allows it', async () => {
    const lock = vi.fn(async () => {});
    vi.stubGlobal('navigator', { keyboard: { lock, unlock: vi.fn() } });
    expect(await enterFullscreen(fakeDoc())).toBe(true);
    expect(lock).toHaveBeenCalledWith(['Escape']);
  });

  it('still succeeds when the keyboard lock is unavailable or refused', async () => {
    vi.stubGlobal('navigator', { keyboard: { lock: async () => { throw new Error('denied'); } } });
    expect(await enterFullscreen(fakeDoc())).toBe(true);
    vi.stubGlobal('navigator', {});
    expect(await enterFullscreen(fakeDoc())).toBe(true);
  });

  it('reports failure when the browser refuses full screen', async () => {
    vi.stubGlobal('navigator', {});
    expect(await enterFullscreen(fakeDoc({ request: async () => { throw new Error('not allowed'); } }))).toBe(false);
  });

  it('exits full screen and releases the keyboard', async () => {
    const unlock = vi.fn();
    vi.stubGlobal('navigator', { keyboard: { unlock } });
    const doc = fakeDoc({ startsFullscreen: true });
    await exitFullscreen(doc);
    expect(doc.exitFullscreen).toHaveBeenCalled();
    expect(unlock).toHaveBeenCalled();
  });

  it('knows whether the device can do full screen at all', () => {
    expect(fullscreenSupported(fakeDoc())).toBe(true);
    expect(fullscreenSupported({ documentElement: {} } as unknown as Document)).toBe(false);
  });
});
