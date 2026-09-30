import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { AppDeps } from './context.js';
import { HttpError } from './errors.js';
import { resolveAuth } from './auth/context.js';
import { authRoutes } from './modules/auth.js';
import { organisationRoutes } from './modules/organisations.js';
import { candidateRoutes } from './modules/candidates.js';
import { examRoutes } from './modules/exams.js';
import { sessionRoutes } from './modules/sessions.js';
import { invigilationRoutes } from './modules/invigilation.js';
import { candidateAppRoutes } from './modules/candidateApp.js';
import { attemptRoutes } from './modules/attempts.js';
import { liveRoutes } from './modules/live.js';
import { resultRoutes } from './modules/results.js';
import { recordingRoutes } from './modules/recording.js';
import { callRoutes } from './modules/calls.js';
import { integrationRoutes } from './modules/integrations.js';
import { reportRoutes } from './modules/reports.js';
import { notificationRoutes } from './modules/notifications.js';
import { storeFromConfig } from './storage.js';

export async function buildApp(given: AppDeps, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const deps: AppDeps = { ...given, store: given.store ?? storeFromConfig(given.config) };
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: deps.config.trustProxy, bodyLimit: 5 * 1024 * 1024 });

  // Rate limits apply only where a route opts in (auth and public onboarding).
  // Production should back this with Redis so limits hold across instances.
  await app.register(rateLimit, { global: false });

  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    req.auth = await resolveAuth(deps.db, deps.config, req);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: 'request_error', message: (err as Error).message } });
    }
    req.log.error(err);
    return reply.code(500).send({ error: { code: 'internal', message: 'Internal server error' } });
  });

  // Liveness/readiness for the load balancer; a failing database takes the instance out of rotation.
  app.get('/health', async (_req, reply) => {
    try {
      await deps.db.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'degraded', database: 'unreachable' });
    }
  });

  for (const routes of [authRoutes, organisationRoutes, candidateRoutes, examRoutes, sessionRoutes, invigilationRoutes, candidateAppRoutes, attemptRoutes, liveRoutes, resultRoutes, recordingRoutes, callRoutes, integrationRoutes, reportRoutes, notificationRoutes]) {
    await app.register(async (scope) => routes(scope, deps));
  }
  return app;
}
