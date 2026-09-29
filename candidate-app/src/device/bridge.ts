// Everything the exam UI needs from the operating system goes through this
// interface. The browser implementation below does what a web page can; the
// desktop shell (Tauri or Electron, spec section 13) supplies a native one
// with kiosk mode, display enumeration and virtual machine detection.

import { type DesktopApi, getDesktop } from '../lib/desktop';
import { detectDevice, type Platform as DevicePlatform } from '../lib/deviceType';

export const APP_VERSION = '0.1.0';

export type Platform = DevicePlatform;

export interface DeviceReport {
  appVersion: string;
  os: { platform: Platform; version: string };
  camera: { detected: boolean };
  microphone: { detected: boolean };
  screenCapture: { ready: boolean };
  storage: { freeMb: number };
  displays: { count: number };
  virtualMachine: { detected: boolean };
  network: { tested: boolean; latencyMs?: number };
  clientTime: string;
  /** Only the desktop application can tell the server it is one, and see other programs. */
  appKind?: 'browser' | 'desktop';
  restrictedApps?: string[];
}

export interface DeviceBridge {
  kind: 'browser' | 'native';
  /** Checks this bridge cannot perform reliably, shown to the candidate. */
  limitations: string[];
  collect(options: { camera: boolean; microphone: boolean; network: () => Promise<number> }): Promise<DeviceReport>;
}

function detectPlatform(): { platform: Platform; version: string } {
  return { platform: detectDevice(navigator).platform, version: '' };
}

/** Asks for the device once to confirm it exists and works, then releases it. */
async function probe(constraints: MediaStreamConstraints): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}

export const browserBridge: DeviceBridge = {
  kind: 'browser',
  limitations: ['Virtual machine detection', 'Kiosk mode', 'Screen capture permission test'],
  async collect({ camera, microphone, network }) {
    const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
    const freeMb = estimate?.quota ? Math.floor((estimate.quota - (estimate.usage ?? 0)) / 1024 / 1024) : 0;
    const screen = window.screen as Screen & { isExtended?: boolean };

    let latencyMs: number | undefined;
    try {
      latencyMs = await network();
    } catch {
      latencyMs = undefined;
    }

    return {
      appVersion: APP_VERSION,
      os: detectPlatform(),
      camera: { detected: camera ? await probe({ video: true }) : false },
      microphone: { detected: microphone ? await probe({ audio: true }) : false },
      screenCapture: { ready: typeof navigator.mediaDevices?.getDisplayMedia === 'function' },
      storage: { freeMb },
      displays: { count: screen.isExtended ? 2 : 1 },
      virtualMachine: { detected: false },
      network: { tested: latencyMs !== undefined, ...(latencyMs !== undefined ? { latencyMs } : {}) },
      clientTime: new Date().toISOString(),
    };
  },
};

/**
 * Inside the desktop application the computer itself is asked, so the real
 * number of screens, free disk space, virtual machine hints and remote control
 * programs replace the browser's guesses.
 */
export function nativeBridge(desktop: DesktopApi): DeviceBridge {
  return {
    kind: 'native',
    limitations: [],
    async collect(options) {
      const [web, sys] = await Promise.all([browserBridge.collect(options), desktop.systemReport()]);
      if (!sys) throw new Error('The desktop application did not report on this computer');
      return {
        ...web,
        appVersion: sys.appVersion,
        appKind: 'desktop',
        os: sys.os,
        storage: { freeMb: sys.freeStorageMb },
        displays: { count: sys.displayCount },
        virtualMachine: { detected: sys.virtualMachine.detected },
        screenCapture: { ready: sys.screenCaptureReady },
        restrictedApps: sys.restrictedApps,
      };
    },
  };
}

/** The desktop application's bridge when running inside it, otherwise the browser's. */
export function currentBridge(): DeviceBridge {
  const desktop = getDesktop();
  return desktop ? nativeBridge(desktop) : browserBridge;
}
