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
import { systemRoutes } from './modules/system.js';
import { governanceRoutes } from './modules/governance.js';
import { peopleRoutes } from './modules/people.js';
import { ssoRoutes } from './modules/sso.js';
import { checklistRoutes } from './modules/checklist.js';
import { storeFromConfig } from './storage.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Redis } from 'ioredis';
import { recordRequest, renderMetrics } from './metrics.js';

/** The API's stable prefix for long lived integrations (spec section 16). Every route answers with and without it. */
export const API_VERSION_PREFIX = '/v1';

export async function buildApp(given: AppDeps, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const deps: AppDeps = { ...given, store: given.store ?? storeFromConfig(given.config) };
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: deps.config.trustProxy,
    bodyLimit: 5 * 1024 * 1024,
    // A request id from the load balancer is kept, so one request can be followed through every log line.
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    // /v1/... is the same API as /...: integrations can pin the version.
    rewriteUrl: (req) => (req.url === API_VERSION_PREFIX || req.url?.startsWith(`${API_VERSION_PREFIX}/`) ? req.url.slice(API_VERSION_PREFIX.length) || '/' : req.url!),
  });

  // Rate limits apply only where a route opts in (sign in and public pages).
  // With REDIS_URL they are shared by every instance behind the load balancer.
  const redis = deps.config.redisUrl ? new Redis(deps.config.redisUrl, { connectTimeout: 2000, maxRetriesPerRequest: 1 }) : null;
  redis?.on('error', (err) => app.log.warn({ err }, 'redis error'));
  if (redis) app.addHook('onClose', async () => void (await redis.quit().catch(() => undefined)));
  await app.register(rateLimit, { global: false, ...(redis ? { redis, nameSpace: 'examguard-rl-', skipOnError: true } : {}) });

  // The websites may be hosted apart from the API (cross origin). Only the
  // listed addresses may call it from a browser; tokens travel in headers,
  // never cookies, so no credentials are shared with other sites.
  const allowedOrigins = new Set(deps.config.corsOrigins);
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (!origin || !allowedOrigins.has(origin)) return;
    reply.header('access-control-allow-origin', origin).header('vary', 'Origin');
    reply.header('access-control-expose-headers', 'Date, Content-Disposition, X-Request-Id');
    if (req.method === 'OPTIONS') {
      return reply
        .header('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
        .header(
          'access-control-allow-headers',
          'Authorization, Content-Type, X-ExamGuard-Client, X-Chunk-Sha256, X-Chunk-Start, X-Chunk-End, X-File-Name, X-Request-Id',
        )
        .header('access-control-max-age', '600')
        .code(204)
        .send();
    }
  });

  // Only a well formed id is echoed back.
  app.addHook('onRequest', async (req, reply) => {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(String(req.id))) (req as { id: string }).id = randomUUID();
    reply.header('x-request-id', req.id);
  });
  app.addHook('onResponse', async (req, reply) => {
    recordRequest(req.method, req.routeOptions.url ?? 'unmatched', reply.statusCode, reply.elapsedTime / 1000);
  });

  // Metrics for the monitoring system. With METRICS_TOKEN set it must be
  // presented; without it, metrics are off in production.
  app.get('/metrics', async (req, reply) => {
    const token = deps.config.metricsToken;
    if (token) {
      const given = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
      const want = Buffer.from(token);
      if (given.length !== want.length || !timingSafeEqual(given, want)) return reply.code(401).send({ error: { code: 'unauthorized', message: 'Metrics token required' } });
    } else if (process.env.NODE_ENV === 'production') {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
    }
    return reply.header('content-type', 'text/plain; version=0.0.4').send(await renderMetrics(deps.db));
  });

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

  for (const routes of [authRoutes, organisationRoutes, candidateRoutes, examRoutes, sessionRoutes, invigilationRoutes, candidateAppRoutes, attemptRoutes, liveRoutes, resultRoutes, recordingRoutes, callRoutes, integrationRoutes, reportRoutes, notificationRoutes, systemRoutes, governanceRoutes, peopleRoutes, ssoRoutes, checklistRoutes]) {
    await app.register(async (scope) => routes(scope, deps));
  }
  return app;
}
