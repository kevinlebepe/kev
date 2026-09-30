import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../context.js';
import { type Queryable, withTransaction } from '../db.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { authorize, requireAuth, requireCandidate, requireOrg } from '../auth/context.js';
import { audit, auditFrom } from '../audit.js';
import { idParams, parse } from '../validation.js';
import { communicationPolicy, scopedAttempt, viewer } from './live.js';

// Live video and voice (MVP 6 and 7). The invigilator starts a call; the
// candidate app learns of it at its next check in and joins. The API passes
// the WebRTC offer, answer and network candidates between them, and never
// carries the audio or video itself.

const startBody = z.object({ voice: z.boolean().default(false) });
const signalBody = z.object({
  type: z.enum(['offer', 'answer', 'ice']),
  // A session description or a network candidate, as the browser produced it.
  payload: z.record(z.string(), z.unknown()).refine((p) => JSON.stringify(p).length <= 20_000, 'Signal too large'),
});
const afterQuery = z.object({ after: z.coerce.number().int().min(0).default(0) });
const callParams = z.object({ id: z.uuid(), callId: z.uuid() });

async function signalsFor(q: Queryable, callId: string, from: 'staff' | 'candidate', after: number) {
  const { rows } = await q.query<{ id: string; type: string; payload: unknown }>(
    'SELECT id, type, payload FROM live_signals WHERE call_id = $1 AND sender = $2 AND id > $3 ORDER BY id LIMIT 200',
    [callId, from, after],
  );
  const { rows: call } = await q.query<{ status: string }>('SELECT status FROM live_calls WHERE id = $1', [callId]);
  return { status: call[0]?.status ?? 'ended', signals: rows.map((r) => ({ id: Number(r.id), type: r.type, payload: r.payload })) };
}

export async function callRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, config } = deps;

  // Both sides need the same STUN and TURN servers.
  app.get('/live/ice-servers', async (req) => {
    requireAuth(req);
    return { iceServers: config.iceServers };
  });

  app.post('/live/attempts/:id/calls', { preHandler: authorize('live:view') }, async (req, reply) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const { voice } = parse(startBody, req.body ?? {});
    if (voice && !auth.permissions.has('live:voice')) throw forbidden('Missing permission: live:voice');
    const call = await withTransaction(db, async (tx) => {
      const v = await viewer(tx, auth);
      const a = await scopedAttempt(tx, auth, v, id, true);
      if (a.status !== 'active') throw conflict('This attempt has ended');
      // Watching is monitoring and always allowed; talking follows the exam's policy.
      if (voice && (await communicationPolicy(tx, id)) === 'text') throw conflict('This exam allows text contact only');
      // One call at a time: a new one replaces the old.
      await tx.query(`UPDATE live_calls SET status = 'ended', ended_at = now() WHERE attempt_id = $1 AND status = 'open'`, [id]);
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO live_calls (organisation_id, attempt_id, started_by, voice) VALUES ($1, $2, $3, $4) RETURNING id`,
        [auth.organisationId, id, auth.userId, voice],
      );
      await tx.query(
        `INSERT INTO events (organisation_id, attempt_id, invigilator_id, type, severity, occurred_at, data)
         VALUES ($1, $2, $3, 'live_call_started', 'info', date_trunc('milliseconds', now()), $4)`,
        [auth.organisationId, id, v.invigilatorId, { voice, callId: rows[0]!.id, byUserId: auth.userId }],
      );
      if (voice) {
        // Voice contact is recorded against the invigilation assignment (spec section 15).
        await tx.query(
          `INSERT INTO invigilation_contacts (organisation_id, assignment_id, channel)
           SELECT $1, ia.id, 'voice' FROM invigilation_assignments ia
             JOIN exam_assignments ea ON ea.session_id = ia.session_id AND ea.candidate_id = ia.candidate_id
             JOIN attempts at ON at.assignment_id = ea.id
            WHERE at.id = $2 AND ia.active`,
          [auth.organisationId, id],
        );
      }
      await audit(tx, { ...auditFrom(req), action: voice ? 'live.voice_call' : 'live.video_call', targetType: 'attempt', targetId: id });
      return { id: rows[0]!.id, voice };
    });
    return reply.code(201).send(call);
  });

  /** A call the caller may use, from the staff side. */
  async function staffCall(q: Queryable, req: Parameters<typeof requireOrg>[0], callId: string) {
    const auth = requireOrg(req);
    const { rows } = await q.query<{ attempt_id: string; status: string }>(
      'SELECT attempt_id, status FROM live_calls WHERE id = $1 AND organisation_id = $2',
      [callId, auth.organisationId],
    );
    if (!rows[0]) throw notFound('Call');
    await scopedAttempt(q, auth, await viewer(q, auth), rows[0].attempt_id);
    return { auth, attemptId: rows[0].attempt_id, status: rows[0].status };
  }

  app.post('/live/calls/:id/signals', { preHandler: authorize('live:view') }, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const body = parse(signalBody, req.body);
    const call = await staffCall(db, req, id);
    if (call.status !== 'open') throw conflict('This call has ended');
    await db.query(`INSERT INTO live_signals (call_id, sender, type, payload) VALUES ($1, 'staff', $2, $3)`, [id, body.type, body.payload]);
    return reply.code(204).send();
  });

  app.get('/live/calls/:id/signals', { preHandler: authorize('live:view') }, async (req) => {
    const { id } = parse(idParams, req.params);
    const { after } = parse(afterQuery, req.query);
    await staffCall(db, req, id);
    return signalsFor(db, id, 'candidate', after);
  });

  app.post('/live/calls/:id/end', { preHandler: authorize('live:view') }, async (req) => {
    const { id } = parse(idParams, req.params);
    return withTransaction(db, async (tx) => {
      const call = await staffCall(tx, req, id);
      const { rowCount } = await tx.query(`UPDATE live_calls SET status = 'ended', ended_at = now() WHERE id = $1 AND status = 'open'`, [id]);
      if (rowCount) {
        await tx.query(
          `INSERT INTO events (organisation_id, attempt_id, type, severity, occurred_at, data)
           VALUES ($1, $2, 'live_call_ended', 'info', date_trunc('milliseconds', now()), $3)`,
          [call.auth.organisationId, call.attemptId, { callId: id }],
        );
      }
      return { status: 'ended' };
    });
  });

  // The candidate side of a call on one of their own attempts.
  async function candidateCall(req: Parameters<typeof requireCandidate>[0], attemptId: string, callId: string) {
    const auth = requireCandidate(req);
    const { rows } = await db.query<{ status: string }>(
      `SELECT c.status FROM live_calls c JOIN attempts at ON at.id = c.attempt_id JOIN exam_assignments a ON a.id = at.assignment_id
        WHERE c.id = $1 AND c.attempt_id = $2 AND a.candidate_id = $3 AND c.organisation_id = $4`,
      [callId, attemptId, auth.candidateId, auth.organisationId],
    );
    if (!rows[0]) throw notFound('Call');
    return rows[0].status;
  }

  app.post('/attempts/:id/calls/:callId/signals', async (req, reply) => {
    const { id, callId } = parse(callParams, req.params);
    const body = parse(signalBody, req.body);
    if ((await candidateCall(req, id, callId)) !== 'open') throw conflict('This call has ended');
    await db.query(`INSERT INTO live_signals (call_id, sender, type, payload) VALUES ($1, 'candidate', $2, $3)`, [callId, body.type, body.payload]);
    return reply.code(204).send();
  });

  app.get('/attempts/:id/calls/:callId/signals', async (req) => {
    const { id, callId } = parse(callParams, req.params);
    const { after } = parse(afterQuery, req.query);
    await candidateCall(req, id, callId);
    return signalsFor(db, callId, 'staff', after);
  });
}
