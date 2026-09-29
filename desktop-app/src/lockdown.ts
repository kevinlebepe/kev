// Exam mode: the window becomes a locked down exam window and stops being one
// when the exam ends (spec section 9). The window and the operating system
// hooks are passed in, so all of this is tested without a screen.

export interface LockableWindow {
  setKiosk(flag: boolean): void;
  setAlwaysOnTop(flag: boolean, level?: 'screen-saver'): void;
  /** Keeps other programs from capturing the window's contents (screenshots, recordings, sharing). */
  setContentProtection(enable: boolean): void;
  setMinimizable(flag: boolean): void;
  setResizable(flag: boolean): void;
  setClosable(flag: boolean): void;
  setMenuBarVisibility(flag: boolean): void;
  focus(): void;
  isFocused(): boolean;
  isMinimized(): boolean;
  restore(): void;
}

export interface ExamModeDeps {
  /** Shows the normal menu, or none at all, whose shortcuts would let the candidate out. */
  setMenu(examMode: boolean): void;
  clearClipboard(): void;
  /** Calls `fn` repeatedly until the returned function is called. */
  every(fn: () => void, ms: number): () => void;
}

const FOCUS_CHECK_MS = 500;

export class ExamMode {
  private active = false;
  private stopGuard: (() => void) | null = null;

  constructor(
    private readonly win: LockableWindow,
    private readonly deps: ExamModeDeps,
  ) {}

  isActive(): boolean {
    return this.active;
  }

  enter(): void {
    // Also used to re-lock the window if something knocked it out of exam mode.
    this.deps.setMenu(true);
    this.deps.clearClipboard();
    this.win.setMinimizable(false);
    this.win.setResizable(false);
    this.win.setMenuBarVisibility(false);
    this.win.setContentProtection(true);
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.setKiosk(true);
    this.win.focus();
    if (!this.active) {
      // If the exam loses focus (another program came to the front), take it back.
      this.stopGuard = this.deps.every(() => {
        if (this.win.isMinimized()) this.win.restore();
        if (!this.win.isFocused()) this.win.focus();
      }, FOCUS_CHECK_MS);
    }
    this.active = true;
  }

  exit(): void {
    if (!this.active) return;
    this.active = false;
    this.stopGuard?.();
    this.stopGuard = null;
    this.win.setKiosk(false);
    this.win.setAlwaysOnTop(false);
    this.win.setContentProtection(false);
    this.win.setMinimizable(true);
    this.win.setResizable(true);
    this.win.setClosable(true);
    this.win.setMenuBarVisibility(true);
    this.deps.setMenu(false);
    this.deps.clearClipboard();
  }
}
