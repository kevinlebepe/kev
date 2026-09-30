import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../context.js';
import { requireOrg } from '../auth/context.js';
import { summarise } from '../alerts.js';
import { parse } from '../validation.js';

const listQuery = z.object({
  unread: z.enum(['true', 'false']).default('false'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
const readBody = z.object({ ids: z.array(z.uuid()).max(100).optional() });

// A person's in app notifications in the organisation they are signed in to
// (spec section 20): immediate events such as a full invigilator roster or a
// candidate offline past the limit.
export async function notificationRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  app.get('/me/notifications', async (req) => {
    const auth = requireOrg(req);
    const q = parse(listQuery, req.query);
    const { rows } = await db.query<{ id: string; kind: string; payload: Record<string, unknown>; createdAt: Date; readAt: Date | null; sessionName: string | null }>(
      `SELECT n.id, n.kind, n.payload, n.created_at AS "createdAt", n.read_at AS "readAt", s.name AS "sessionName"
         FROM notifications n
         LEFT JOIN sessions s ON s.id::text = n.payload->>'sessionId' AND s.organisation_id = n.organisation_id
        WHERE n.recipient_user_id = $1 AND n.organisation_id = $2 AND n.channel = 'in_app'
          AND ($3 = 'false' OR n.read_at IS NULL)
        ORDER BY n.created_at DESC LIMIT $4`,
      [auth.userId, auth.organisationId, q.unread, q.limit],
    );
    const { rows: count } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications
        WHERE recipient_user_id = $1 AND organisation_id = $2 AND channel = 'in_app' AND read_at IS NULL`,
      [auth.userId, auth.organisationId],
    );
    return {
      unread: count[0]!.n,
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        createdAt: r.createdAt,
        readAt: r.readAt,
        sessionId: typeof r.payload.sessionId === 'string' ? r.payload.sessionId : null,
        attemptId: typeof r.payload.attemptId === 'string' ? r.payload.attemptId : null,
        ...summarise(r.kind, r.payload, r.sessionName),
      })),
    };
  });

  // Marks the given notifications read, or all of them.
  app.post('/me/notifications/read', async (req) => {
    const auth = requireOrg(req);
    const { ids } = parse(readBody, req.body ?? {});
    const { rowCount } = await db.query(
      `UPDATE notifications SET read_at = now()
        WHERE recipient_user_id = $1 AND organisation_id = $2 AND channel = 'in_app' AND read_at IS NULL
          AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))`,
      [auth.userId, auth.organisationId, ids ?? null],
    );
    return { read: rowCount };
  });
}
