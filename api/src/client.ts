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

/** Refuses browsers for exams that require the desktop application. */
export function enforceClient(req: FastifyRequest, config: ExamConfig): void {
  if (config.device.requireDesktopApp && clientKind(req) !== 'desktop') {
    throw conflict('This exam must be taken in the ExamGuard desktop application, not a browser');
  }
}
