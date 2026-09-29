import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../context.js';
import { withTransaction } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { authorize, requireOrg } from '../auth/context.js';
import { audit, auditFrom } from '../audit.js';
import { checkWebhookUrl, enqueueWebhook, newWebhookSecret, WEBHOOK_EVENTS, type WebhookConfig } from '../webhooks.js';
import { parse } from '../validation.js';

const webhookBody = z.object({
  url: z.url().max(2000),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
  enabled: z.boolean().default(true),
  /** A new secret replaces the old one; receivers must be updated. */
  rotateSecret: z.boolean().default(false),
});

export async function integrationRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, config } = deps;
  const guard = { preHandler: authorize('organisation:manage_users') };

  // The secret is shown once, when it is created, and never again.
  app.get('/integrations/webhook', guard, async (req) => {
    const auth = requireOrg(req);
    const { rows } = await db.query<{ config: WebhookConfig; enabled: boolean }>(
      `SELECT config, enabled FROM integration_configs WHERE organisation_id = $1 AND kind = 'webhook'`,
      [auth.organisationId],
    );
    const { rows: deliveries } = await db.query(
      `SELECT id, event, attempts, created_at AS "createdAt", delivered_at AS "deliveredAt", failed_at AS "failedAt",
              last_status AS "lastStatus", last_error AS "lastError"
         FROM webhook_deliveries WHERE organisation_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [auth.organisationId],
    );
    const c = rows[0];
    return {
      configured: Boolean(c),
      url: c?.config.url ?? null,
      events: c?.config.events ?? [],
      enabled: c?.enabled ?? false,
      secretHint: c ? `${c.config.secret.slice(0, 10)}…` : null,
      availableEvents: WEBHOOK_EVENTS,
      deliveries,
    };
  });

  app.put('/integrations/webhook', guard, async (req) => {
    const auth = requireOrg(req);
    const body = parse(webhookBody, req.body);
    try {
      // The address is checked again when sending, because DNS can change.
      await checkWebhookUrl(body.url, { allowPrivate: config.allowPrivateWebhooks });
    } catch (err) {
      throw badRequest((err as Error).message);
    }
    return withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ config: WebhookConfig }>(
        `SELECT config FROM integration_configs WHERE organisation_id = $1 AND kind = 'webhook' FOR UPDATE`,
        [auth.organisationId],
      );
      const fresh = !rows[0] || body.rotateSecret;
      const secret = fresh ? newWebhookSecret() : rows[0]!.config.secret;
      await tx.query(
        `INSERT INTO integration_configs (organisation_id, kind, config, enabled) VALUES ($1, 'webhook', $2, $3)
         ON CONFLICT (organisation_id, kind) DO UPDATE SET config = EXCLUDED.config, enabled = EXCLUDED.enabled`,
        [auth.organisationId, { url: body.url, events: body.events, secret } satisfies WebhookConfig, body.enabled],
      );
      await audit(tx, {
        ...auditFrom(req),
        action: 'integration.webhook_update',
        targetType: 'organisation',
        targetId: auth.organisationId,
        data: { url: body.url, events: body.events, enabled: body.enabled, newSecret: fresh },
      });
      return { url: body.url, events: body.events, enabled: body.enabled, ...(fresh ? { secret } : {}) };
    });
  });

  app.post('/integrations/webhook/test', guard, async (req, reply) => {
    const auth = requireOrg(req);
    const { rowCount } = await db.query(
      `SELECT 1 FROM integration_configs WHERE organisation_id = $1 AND kind = 'webhook' AND enabled`,
      [auth.organisationId],
    );
    if (!rowCount) throw notFound('Switched on webhook');
    await enqueueWebhook(db, auth.organisationId, 'webhook.test', { message: 'This is a test from ExamGuard.' });
    return reply.code(202).send({ queued: true });
  });
}
