import type { RuleEventType } from './types';

// Detects the exam rules being broken and reports each one (spec sections 8
// and 9). It only observes and prevents what a web page can prevent; the
// server counts what is reported and decides the consequence.

export interface RulesConfig {
  /** The exam must stay in full screen. */
  fullscreen: boolean;
  /** Copy, cut, paste, right click, drag and drop, and browser shortcuts are blocked. */
  blockClipboard: boolean;
}

export type Report = (type: RuleEventType, data?: Record<string, string | number | boolean>) => void;

export interface RulesHooks {
  onFullscreenChange?(isFullscreen: boolean): void;
  /** The candidate is trying to leave the page (close, reload or navigate away). */
  onClosing?(): void;
}

// Browser shortcuts that would print, save, view source or open developer
// tools. Copy, cut and paste are handled by their own events instead.
function blockedShortcut(e: KeyboardEvent): string | null {
  const key = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'F12') return 'F12';
  if (mod && e.shiftKey && ['i', 'j', 'c', 'k'].includes(key)) return `Ctrl+Shift+${key.toUpperCase()}`;
  if (mod && ['p', 's', 'u'].includes(key)) return `Ctrl+${key.toUpperCase()}`;
  if (e.metaKey && e.altKey && ['i', 'j', 'c', 'u'].includes(key)) return `Cmd+Alt+${key.toUpperCase()}`;
  return null;
}

/** Starts watching. Returns a function that stops. */
export function attachExamRules(win: Window, cfg: RulesConfig, report: Report, hooks: RulesHooks = {}): () => void {
  const doc = win.document;
  const cleanups: (() => void)[] = [];
  const on = (target: EventTarget, type: string, handler: (e: never) => void, capture = false) => {
    const fn = handler as unknown as EventListener;
    target.addEventListener(type, fn, capture);
    cleanups.push(() => target.removeEventListener(type, fn, capture));
  };

  // Leaving the window: another tab or another application. One report per
  // absence, however many events the browser raises for it.
  let awaySince: number | null = null;
  const leave = (reason: string) => {
    if (awaySince !== null) return;
    awaySince = Date.now();
    report('left_window', { reason });
  };
  const back = () => {
    if (awaySince === null || doc.visibilityState === 'hidden') return;
    const awayMs = Date.now() - awaySince;
    awaySince = null;
    report('returned_window', { awayMs });
  };
  on(win, 'blur', () => leave('focus_lost'));
  on(win, 'focus', back);
  on(doc, 'visibilitychange', () => (doc.visibilityState === 'hidden' ? leave('tab_hidden') : back()));

  // Trying to close, reload or navigate away.
  on(win, 'beforeunload', (e: BeforeUnloadEvent) => {
    report('close_attempt');
    hooks.onClosing?.();
    e.preventDefault();
    e.returnValue = '';
  });

  if (cfg.fullscreen) {
    let wasFullscreen = Boolean(doc.fullscreenElement);
    on(doc, 'fullscreenchange', () => {
      const isFullscreen = Boolean(doc.fullscreenElement);
      if (isFullscreen === wasFullscreen) return;
      wasFullscreen = isFullscreen;
      hooks.onFullscreenChange?.(isFullscreen);
      report(isFullscreen ? 'returned_fullscreen' : 'left_fullscreen');
    });
  }

  if (cfg.blockClipboard) {
    const block = (type: RuleEventType, data?: Record<string, string | number | boolean>) => (e: Event) => {
      e.preventDefault();
      report(type, data);
    };
    // Capture phase, so nothing on the page can handle the event first.
    on(doc, 'copy', block('copy_attempt'), true);
    on(doc, 'cut', block('cut_attempt'), true);
    on(doc, 'paste', block('paste_attempt'), true);
    on(doc, 'contextmenu', block('context_menu'), true);
    on(doc, 'drop', block('paste_attempt', { via: 'drop' }), true);
    on(doc, 'dragstart', (e: Event) => e.preventDefault(), true);
    on(
      doc,
      'keydown',
      (e: KeyboardEvent) => {
        const combo = blockedShortcut(e);
        if (!combo) return;
        e.preventDefault();
        report('shortcut_blocked', { key: combo });
      },
      true,
    );
  }

  return () => cleanups.forEach((fn) => fn());
}
