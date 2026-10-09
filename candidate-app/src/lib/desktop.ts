// The ExamGuard desktop application shows these same screens inside a locked
// window and offers the abilities below through `window.examguardDesktop`.
// In a browser it does not exist, and the screens do what a browser can.

export interface DesktopSystemReport {
  appVersion: string;
  os: { platform: 'windows' | 'macos' | 'linux' | 'other'; version: string };
  displayCount: number;
  freeStorageMb: number;
  virtualMachine: { detected: boolean; hints: string[] };
  restrictedApps: string[];
  screenCaptureReady: boolean;
}

export interface DesktopApi {
  info(): Promise<{ version: string; platform: string } | null>;
  systemReport(): Promise<DesktopSystemReport | null>;
  /** Locks the window: kiosk, always on top, screen capture blocked, closing intercepted. */
  enterExamMode(): Promise<void>;
  exitExamMode(): Promise<void>;
  /** A JPEG of the locked exam window, for the screen recording. Null outside exam mode. Older versions lack it. */
  captureScreen?(): Promise<Uint8Array | null>;
  onCloseRequested(callback: () => void): () => void;
  onShortcutBlocked(callback: (combo: string) => void): () => void;
  onFullscreenChange(callback: (isFullscreen: boolean) => void): () => void;
  onDisplayAdded(callback: (displayCount: number) => void): () => void;
}

export function getDesktop(): DesktopApi | null {
  if (typeof window === 'undefined') return null;
  return (window as Window & { examguardDesktop?: DesktopApi }).examguardDesktop ?? null;
}
