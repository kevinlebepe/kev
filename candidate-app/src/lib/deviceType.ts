// What kind of device is this? Phones, tablets and Chromebooks cannot run the
// ExamGuard desktop application, so they use the browser; laptops and desktop
// computers must use the application when the exam requires it. This is read
// from what the browser says about itself, which a determined candidate can
// change, so the organisation's own device management must still lock down the
// phones and tablets it allows.

export type Platform = 'windows' | 'macos' | 'linux' | 'chromeos' | 'android' | 'ios' | 'other';
export type DeviceKind = 'computer' | 'tablet' | 'phone' | 'chromebook';

export interface DeviceInfo {
  platform: Platform;
  kind: DeviceKind;
}

export interface NavigatorLike {
  userAgent: string;
  maxTouchPoints?: number;
}

export function detectDevice(nav: NavigatorLike): DeviceInfo {
  const ua = nav.userAgent;
  if (/\bCrOS\b/.test(ua)) return { platform: 'chromeos', kind: 'chromebook' };
  if (/\b(iPhone|iPod)\b/.test(ua)) return { platform: 'ios', kind: 'phone' };
  if (/\biPad\b/.test(ua)) return { platform: 'ios', kind: 'tablet' };
  // iPadOS asks websites for the desktop version by default: it says
  // "Macintosh", but a Mac has no touch screen and an iPad does.
  if (/\bMacintosh\b/.test(ua) && (nav.maxTouchPoints ?? 0) > 1) return { platform: 'ios', kind: 'tablet' };
  // Android must come before Linux: its user agent contains both.
  if (/\bAndroid\b/.test(ua)) return { platform: 'android', kind: /\bMobile\b/.test(ua) ? 'phone' : 'tablet' };
  if (/\bWindows\b/.test(ua)) return { platform: 'windows', kind: 'computer' };
  if (/\bMacintosh\b|Mac OS X/.test(ua)) return { platform: 'macos', kind: 'computer' };
  if (/\bLinux\b|\bX11\b/.test(ua)) return { platform: 'linux', kind: 'computer' };
  // Unrecognised is treated as a computer, so an unknown device cannot slip past the application rule.
  return { platform: 'other', kind: 'computer' };
}

/** True when the browser is enough: the device cannot run the desktop application anyway. */
export function browserIsEnough(kind: DeviceKind): boolean {
  return kind !== 'computer';
}
