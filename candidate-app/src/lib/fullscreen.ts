// Full screen for the exam (spec section 9). A web page can ask for it and
// notice when it ends, but cannot stop the candidate leaving. The desktop
// shell provides real kiosk mode; this is the best a browser can do.

export function fullscreenSupported(doc: Document = document): boolean {
  return typeof doc.documentElement.requestFullscreen === 'function';
}

interface KeyboardLockApi {
  lock?: (keys?: string[]) => Promise<void>;
  unlock?: () => void;
}

/** Must be called from a click or key press, or the browser refuses. */
export async function enterFullscreen(doc: Document = document): Promise<boolean> {
  try {
    await doc.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    return false;
  }
  try {
    // Where supported, Escape no longer leaves full screen at once: the
    // candidate has to hold it, which makes an accidental exit less likely.
    await (navigator as Navigator & { keyboard?: KeyboardLockApi }).keyboard?.lock?.(['Escape']);
  } catch {
    // Not supported: full screen still works, Escape just exits it.
  }
  return Boolean(doc.fullscreenElement);
}

export async function exitFullscreen(doc: Document = document): Promise<void> {
  try {
    (navigator as Navigator & { keyboard?: KeyboardLockApi }).keyboard?.unlock?.();
    if (doc.fullscreenElement) await doc.exitFullscreen();
  } catch {
    // Already out.
  }
}
