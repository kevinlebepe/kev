import { describe, expect, it } from 'vitest';
import { browserIsEnough, detectDevice } from '../src/lib/deviceType';

const UA = {
  windowsChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  windowsEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  windowsSurfaceArm: 'Mozilla/5.0 (Windows NT 10.0; ARM64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
  chromebook: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  androidPhone: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  androidTablet: 'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
};

describe('device detection', () => {
  it.each([
    ['Windows', UA.windowsChrome, 'windows', 'computer'],
    ['Windows (Edge)', UA.windowsEdge, 'windows', 'computer'],
    ['Windows on ARM', UA.windowsSurfaceArm, 'windows', 'computer'],
    ['a Mac (Safari)', UA.macSafari, 'macos', 'computer'],
    ['a Mac (Chrome)', UA.macChrome, 'macos', 'computer'],
    ['Linux', UA.linuxFirefox, 'linux', 'computer'],
    ['a Chromebook', UA.chromebook, 'chromeos', 'chromebook'],
    ['an iPhone', UA.iphone, 'ios', 'phone'],
    ['an iPad', UA.ipad, 'ios', 'tablet'],
    ['an Android phone', UA.androidPhone, 'android', 'phone'],
    ['an Android tablet', UA.androidTablet, 'android', 'tablet'],
  ])('recognises %s', (_name, userAgent, platform, kind) => {
    expect(detectDevice({ userAgent, maxTouchPoints: 0 })).toEqual({ platform, kind });
  });

  it('sees an iPad that asks for the desktop website, because a Mac has no touch screen', () => {
    expect(detectDevice({ userAgent: UA.macSafari, maxTouchPoints: 5 })).toEqual({ platform: 'ios', kind: 'tablet' });
    expect(detectDevice({ userAgent: UA.macSafari, maxTouchPoints: 0 })).toEqual({ platform: 'macos', kind: 'computer' });
    expect(detectDevice({ userAgent: UA.macSafari })).toEqual({ platform: 'macos', kind: 'computer' });
  });

  it('does not mistake Android for Linux', () => {
    expect(detectDevice({ userAgent: UA.androidPhone }).platform).toBe('android');
  });

  it('treats a touch screen laptop as the computer it is', () => {
    expect(detectDevice({ userAgent: UA.windowsChrome, maxTouchPoints: 10 })).toEqual({ platform: 'windows', kind: 'computer' });
  });

  it('treats an unrecognised device as a computer, so it cannot slip past the application rule', () => {
    expect(detectDevice({ userAgent: 'SomeNewBrowser/1.0' })).toEqual({ platform: 'other', kind: 'computer' });
    expect(detectDevice({ userAgent: '' })).toEqual({ platform: 'other', kind: 'computer' });
  });

  it('lets everything except a computer carry on in the browser', () => {
    expect(browserIsEnough('computer')).toBe(false);
    for (const kind of ['tablet', 'phone', 'chromebook'] as const) expect(browserIsEnough(kind), kind).toBe(true);
  });
});
