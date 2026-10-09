import { describe, expect, it } from 'vitest';
import { ExamMode, type LockableWindow } from '../src/lockdown';

function setup() {
  const calls: string[] = [];
  const state = { focused: true, minimized: false };
  const win: LockableWindow = {
    setKiosk: (f) => void calls.push(`kiosk:${f}`),
    setAlwaysOnTop: (f, level) => void calls.push(`onTop:${f}${level ? `:${level}` : ''}`),
    setContentProtection: (e) => void calls.push(`protect:${e}`),
    setMinimizable: (f) => void calls.push(`minimizable:${f}`),
    setResizable: (f) => void calls.push(`resizable:${f}`),
    setClosable: (f) => void calls.push(`closable:${f}`),
    setMenuBarVisibility: (f) => void calls.push(`menubar:${f}`),
    focus: () => {
      calls.push('focus');
      state.focused = true;
    },
    isFocused: () => state.focused,
    isMinimized: () => state.minimized,
    restore: () => {
      calls.push('restore');
      state.minimized = false;
    },
  };
  let tick: (() => void) | null = null;
  let stopped = false;
  const mode = new ExamMode(win, {
    setMenu: (exam) => void calls.push(`menu:${exam ? 'none' : 'normal'}`),
    clearClipboard: () => void calls.push('clipboard:clear'),
    every: (fn) => {
      tick = fn;
      return () => {
        stopped = true;
        tick = null;
      };
    },
  });
  return { mode, calls, state, tick: () => tick?.(), stopped: () => stopped };
}

describe('exam mode', () => {
  it('locks the window down when the exam starts', () => {
    const { mode, calls } = setup();
    expect(mode.isActive()).toBe(false);
    mode.enter();
    expect(mode.isActive()).toBe(true);
    expect(calls).toEqual(
      expect.arrayContaining([
        'kiosk:true',
        'onTop:true:screen-saver',
        'protect:true',
        'minimizable:false',
        'resizable:false',
        'menubar:false',
        'menu:none',
        'clipboard:clear',
      ]),
    );
  });

  it('takes focus back if another program comes to the front', () => {
    const { mode, calls, state, tick } = setup();
    mode.enter();
    calls.length = 0;
    state.focused = false;
    tick();
    expect(calls).toEqual(['focus']);
    tick(); // focused again: nothing to do
    expect(calls).toEqual(['focus']);
  });

  it('brings the window back if it is minimised', () => {
    const { mode, calls, state, tick } = setup();
    mode.enter();
    calls.length = 0;
    state.minimized = true;
    tick();
    expect(calls).toContain('restore');
  });

  it('can be re-applied without starting a second focus guard', () => {
    const { mode, calls } = setup();
    mode.enter();
    mode.enter();
    expect(calls.filter((c) => c === 'kiosk:true')).toHaveLength(2); // the window was re-locked
    expect(mode.isActive()).toBe(true);
  });

  it('gives the window back to the candidate when the exam ends', () => {
    const { mode, calls, stopped, tick } = setup();
    mode.enter();
    calls.length = 0;
    mode.exit();
    expect(mode.isActive()).toBe(false);
    expect(stopped()).toBe(true);
    expect(calls).toEqual(
      expect.arrayContaining(['kiosk:false', 'onTop:false', 'protect:false', 'minimizable:true', 'resizable:true', 'closable:true', 'menu:normal', 'clipboard:clear']),
    );
    calls.length = 0;
    tick(); // the guard is gone
    expect(calls).toEqual([]);
  });

  it('does nothing when the exam mode was never on', () => {
    const { mode, calls } = setup();
    mode.exit();
    expect(calls).toEqual([]);
  });
});
