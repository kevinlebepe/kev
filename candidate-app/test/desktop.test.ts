import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopApi, DesktopSystemReport } from '../src/lib/desktop';
import { browserBridge, currentBridge, type DeviceReport, nativeBridge } from '../src/device/bridge';

const webPart: DeviceReport = {
  appVersion: '0.1.0',
  os: { platform: 'linux', version: '' },
  camera: { detected: true },
  microphone: { detected: true },
  screenCapture: { ready: true },
  storage: { freeMb: 878 }, // a browser's guess: its storage quota
  displays: { count: 1 }, // a browser's guess
  virtualMachine: { detected: false }, // a browser cannot tell
  network: { tested: true, latencyMs: 12 },
  clientTime: '2026-10-14T09:00:00.000Z',
};

const system: DesktopSystemReport = {
  appVersion: '1.4.2',
  os: { platform: 'macos', version: '14.5.0' },
  displayCount: 2,
  freeStorageMb: 90_000,
  virtualMachine: { detected: true, hints: ['VMware'] },
  restrictedApps: ['AnyDesk'],
  screenCaptureReady: false,
};

function fakeDesktop(report: DesktopSystemReport | null = system): DesktopApi {
  const off = () => () => {};
  return {
    info: async () => ({ version: '1.4.2', platform: 'darwin' }),
    systemReport: async () => report,
    enterExamMode: async () => {},
    exitExamMode: async () => {},
    onCloseRequested: off,
    onShortcutBlocked: off,
    onFullscreenChange: off,
    onDisplayAdded: off,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('native device bridge', () => {
  const options = { camera: true, microphone: true, network: async () => 12 };

  it('replaces the browser’s guesses with what the computer reports, and says it is the desktop application', async () => {
    vi.spyOn(browserBridge, 'collect').mockResolvedValue(webPart);
    const report = await nativeBridge(fakeDesktop()).collect(options);
    expect(report).toMatchObject({
      appKind: 'desktop',
      appVersion: '1.4.2',
      os: { platform: 'macos', version: '14.5.0' },
      displays: { count: 2 },
      storage: { freeMb: 90_000 },
      virtualMachine: { detected: true },
      screenCapture: { ready: false },
      restrictedApps: ['AnyDesk'],
    });
  });

  it('keeps what only the web page can find out: camera, microphone, network and time', async () => {
    vi.spyOn(browserBridge, 'collect').mockResolvedValue(webPart);
    const report = await nativeBridge(fakeDesktop()).collect(options);
    expect(report).toMatchObject({ camera: { detected: true }, microphone: { detected: true }, network: { tested: true, latencyMs: 12 }, clientTime: webPart.clientTime });
  });

  it('has no limitations to warn the candidate about', () => {
    expect(nativeBridge(fakeDesktop())).toMatchObject({ kind: 'native', limitations: [] });
  });

  it('fails clearly if the desktop application does not answer', async () => {
    vi.spyOn(browserBridge, 'collect').mockResolvedValue(webPart);
    await expect(nativeBridge(fakeDesktop(null)).collect(options)).rejects.toThrow(/did not report/);
  });
});

describe('choosing the bridge', () => {
  it('uses the browser bridge in a browser', () => {
    vi.stubGlobal('window', {});
    expect(currentBridge()).toBe(browserBridge);
  });

  it('uses the native bridge inside the desktop application', () => {
    vi.stubGlobal('window', { examguardDesktop: fakeDesktop() });
    expect(currentBridge().kind).toBe('native');
  });
});
