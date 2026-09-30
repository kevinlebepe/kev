// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachExamRules, type RulesConfig } from '../src/lib/rules';
import type { RuleEventType } from '../src/lib/types';

const strict: RulesConfig = { fullscreen: true, blockClipboard: true };

let reports: { type: RuleEventType; data?: Record<string, unknown> }[];
let detach: () => void;
let hooks: { fullscreen: boolean[]; closing: number };

function attach(cfg: RulesConfig = strict) {
  detach = attachExamRules(window, cfg, (type, data) => reports.push({ type, data }), {
    onFullscreenChange: (v) => hooks.fullscreen.push(v),
    onClosing: () => void hooks.closing++,
  });
}

/** jsdom has no full screen, so tests stand in for it. */
function setFullscreen(on: boolean) {
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => (on ? document.documentElement : null) });
  document.dispatchEvent(new Event('fullscreenchange'));
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

const types = () => reports.map((r) => r.type);
const cancelable = (type: string, init: EventInit = {}) => new Event(type, { bubbles: true, cancelable: true, ...init });

beforeEach(() => {
  reports = [];
  hooks = { fullscreen: [], closing: 0 };
  setFullscreen(true);
  reports = []; // ignore the setup change
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});
afterEach(() => detach?.());

describe('clipboard and shortcuts', () => {
  it('prevents copy, cut, paste and right click, and reports each', () => {
    attach();
    for (const name of ['copy', 'cut', 'paste', 'contextmenu']) {
      const e = cancelable(name);
      document.body.dispatchEvent(e);
      expect(e.defaultPrevented, name).toBe(true);
    }
    expect(types()).toEqual(['copy_attempt', 'cut_attempt', 'paste_attempt', 'context_menu']);
  });

  it('treats dropping text in like pasting it', () => {
    attach();
    const e = cancelable('drop');
    document.body.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(reports[0]).toEqual({ type: 'paste_attempt', data: { via: 'drop' } });
  });

  it('blocks print, save, view source and developer tools shortcuts', () => {
    attach();
    const keys: KeyboardEventInit[] = [
      { key: 'p', ctrlKey: true },
      { key: 's', metaKey: true },
      { key: 'u', ctrlKey: true },
      { key: 'F12' },
      { key: 'I', ctrlKey: true, shiftKey: true },
      { key: 'j', metaKey: true, altKey: true },
    ];
    for (const init of keys) {
      const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      document.body.dispatchEvent(e);
      expect(e.defaultPrevented, JSON.stringify(init)).toBe(true);
    }
    expect(types()).toEqual(Array(keys.length).fill('shortcut_blocked'));
    expect(reports[3]!.data).toEqual({ key: 'F12' });
  });

  it('leaves ordinary typing alone, including letters used in shortcuts', () => {
    attach();
    for (const init of [{ key: 'p' }, { key: 'a' }, { key: 's', shiftKey: true }, { key: 'Enter' }, { key: 'ArrowDown' }]) {
      const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      document.body.dispatchEvent(e);
      expect(e.defaultPrevented, init.key).toBe(false);
    }
    expect(reports).toEqual([]);
  });

  it('does not touch the clipboard when the exam allows it', () => {
    attach({ fullscreen: true, blockClipboard: false });
    const e = cancelable('paste');
    document.body.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(reports).toEqual([]);
  });
});

describe('leaving the window', () => {
  it('reports one absence, however many events the browser raises for it', () => {
    attach();
    window.dispatchEvent(new Event('blur'));
    setVisibility('hidden'); // switching tab raises both
    window.dispatchEvent(new Event('blur'));
    expect(types()).toEqual(['left_window']);
    expect(reports[0]!.data).toEqual({ reason: 'focus_lost' });
  });

  it('reports the return and how long the candidate was away', () => {
    vi.useFakeTimers();
    try {
      attach();
      setVisibility('hidden');
      vi.advanceTimersByTime(7_000);
      setVisibility('visible');
      window.dispatchEvent(new Event('focus'));
      expect(types()).toEqual(['left_window', 'returned_window']);
      expect(reports[0]!.data).toEqual({ reason: 'tab_hidden' });
      expect(reports[1]!.data).toEqual({ awayMs: 7000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not report coming back while the tab is still hidden', () => {
    attach();
    setVisibility('hidden');
    window.dispatchEvent(new Event('focus'));
    expect(types()).toEqual(['left_window']);
  });

  it('reports two separate absences separately', () => {
    attach();
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('blur'));
    expect(types()).toEqual(['left_window', 'returned_window', 'left_window']);
  });
});

describe('full screen', () => {
  it('reports leaving and returning, and tells the screen', () => {
    attach();
    setFullscreen(false);
    setFullscreen(true);
    expect(types()).toEqual(['left_fullscreen', 'returned_fullscreen']);
    expect(hooks.fullscreen).toEqual([false, true]);
  });

  it('ignores changes when the exam does not need full screen', () => {
    attach({ fullscreen: false, blockClipboard: true });
    setFullscreen(false);
    expect(reports).toEqual([]);
  });
});

describe('closing the window', () => {
  it('reports the attempt, asks the browser to confirm, and lets the app send it in time', () => {
    attach();
    const e = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(e);
    expect(types()).toEqual(['close_attempt']);
    expect(e.defaultPrevented).toBe(true);
    expect(hooks.closing).toBe(1);
  });
});

describe('detaching', () => {
  it('stops watching completely', () => {
    attach();
    detach();
    document.body.dispatchEvent(cancelable('copy'));
    window.dispatchEvent(new Event('blur'));
    setFullscreen(false);
    window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
    expect(reports).toEqual([]);
  });
});
