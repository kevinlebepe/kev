import type { FastifyRequest } from 'fastify';
import type { ExamConfig } from './examConfig.js';
import { conflict } from './errors.js';

export type ClientKind = 'browser' | 'desktop';

/**
 * What kind of application the request says it comes from. This is the app's
 * own claim and can be faked by someone determined; it stops honest mistakes
 * and casual attempts. Proving it needs signed builds and platform
 * attestation, which come with the packaged desktop application.
 */
export function clientKind(req: FastifyRequest): ClientKind {
  return req.headers['x-examguard-client'] === 'desktop' ? 'desktop' : 'browser';
}

// Phones, tablets and Chromebooks cannot run the desktop application, so they
// use the browser. Everything else (Windows, macOS, Linux and anything the
// server does not recognise) is a computer and must use the application.
const BROWSER_PLATFORMS: ReadonlySet<string> = new Set(['chromeos', 'android', 'ios']);

export function browserAllowedOn(platform: string | null | undefined): boolean {
  return platform != null && BROWSER_PLATFORMS.has(platform);
}

/**
 * Keeps computers in the browser away from exams that require the desktop
 * application. `platform` is what the candidate's last device check reported
 * about the device; like the client kind it is the app's own claim, and proving
 * it needs managed devices or signed builds.
 */
export function enforceClient(req: FastifyRequest, config: ExamConfig, platform: string | null | undefined): void {
  if (!config.device.requireDesktopApp) return;
  if (clientKind(req) === 'desktop' || browserAllowedOn(platform)) return;
  throw conflict('This exam must be taken in the ExamGuard desktop application on a laptop or desktop computer');
}
