// Keys that would let the candidate leave, reload, resize or inspect the exam
// window. While the exam runs these are swallowed and the exam screens are
// told, so each attempt is recorded. Copy, cut and paste are left to the exam
// screens, which block and record them themselves.

export interface KeyInput {
  type: string;
  key: string;
  control: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

function label(input: KeyInput): string {
  const parts = [input.control && 'Ctrl', input.alt && 'Alt', input.shift && 'Shift', input.meta && 'Cmd'].filter(Boolean);
  const key = input.key.length === 1 ? input.key.toUpperCase() : input.key;
  return [...parts, key].join('+');
}

/** Returns a description of the shortcut if it must be blocked, otherwise null. */
export function blockedShortcut(input: KeyInput): string | null {
  if (input.type !== 'keyDown') return null;
  const k = input.key.toLowerCase();
  const mod = input.control || input.meta;

  const blocked =
    // Closing, quitting, hiding
    (input.alt && k === 'f4') ||
    (mod && ['w', 'q'].includes(k)) ||
    (input.control && k === 'f4') ||
    (input.meta && ['m', 'h'].includes(k)) ||
    // Reloading
    k === 'f5' ||
    (mod && k === 'r') ||
    // Leaving full screen
    k === 'f11' ||
    (input.control && input.meta && k === 'f') ||
    // Developer tools and view source
    k === 'f12' ||
    (mod && input.shift && ['i', 'j', 'c', 'k'].includes(k)) ||
    (input.meta && input.alt && ['i', 'j', 'c', 'u'].includes(k)) ||
    (mod && ['u', 'p', 's'].includes(k)) ||
    // Opening other windows or tabs
    (mod && ['n', 't'].includes(k)) ||
    // Going back or forward, zooming
    (input.alt && ['arrowleft', 'arrowright'].includes(k)) ||
    (input.meta && ['[', ']'].includes(k)) ||
    (mod && ['+', '=', '-', '_', '0'].includes(k));

  return blocked ? label(input) : null;
}
