import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../context.js';
import { withTransaction } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { authorize, requireCandidate, requireOrg } from '../auth/context.js';
import { audit, auditFrom } from '../audit.js';
import { evidenceState, expectedStreams, type StreamType, verifySubmission } from '../recording.js';
import { idParams, parse } from '../validation.js';

export const MAX_CHUNK_BYTES = 10 * 1024 * 1024;
export const MAX_SNAPSHOT_BYTES = 512 * 1024;
/** Recordings may still arrive this long after the attempt closes, from a slow or reconnecting device. */
export const UPLOAD_AFTER_SUBMIT_HOURS = 24;

// Safari on iPhone and iPad records MP4 rather than WebM.
const MEDIA_TYPES: Record<string, string> = { 'video/webm': 'webm', 'audio/webm': 'webm', 'video/mp4': 'mp4', 'audio/mp4': 'm4a', 'image/jpeg': 'jpg' };

const chunkParams = z.object({
  id: z.uuid(),
  stream: z.enum(['camera', 'screen', 'audio']),
  sequence: z.coerce.number().int().min(0).max(100_000),
});

const chunkHeaders = z.object({
  'x-chunk-sha256': z.string().regex(/^[0-9a-f]{64}$/),
  'x-chunk-start': z.iso.datetime({ offset: true }),
  'x-chunk-end': z.iso.datetime({ offset: true }),
});

const completeBody = z.object({
  streams: z.partialRecord(z.enum(['camera', 'screen', 'audio']), z.number().int().min(-1).max(100_000)),
});

/** The media type without parameters such as codecs. */
const mediaType = (header: string | undefined) => (header ?? '').split(';')[0]!.trim().toLowerCase();

export async function recordingRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, config } = deps;
  const store = deps.store!;

  // Recordings arrive as raw bytes, never as JSON.
  app.addContentTypeParser(Object.keys(MEDIA_TYPES), { parseAs: 'buffer', bodyLimit: MAX_CHUNK_BYTES }, (_req, body, done) =>
    done(null, body),
  );

  /** One of the candidate's own attempts that may still receive recordings. */
  async function uploadTarget(attemptId: string, organisationId: string, candidateId: string) {
    const { rows } = await db.query<{ status: string; config: unknown; late: boolean }>(
      `SELECT at.status, v.manifest->'config' AS config,
              at.status <> 'active' AND coalesce(at.submitted_at, now()) < now() - make_interval(hours => $4) AS late
         FROM attempts at
         JOIN exam_assignments a ON a.id = at.assignment_id
         JOIN exam_versions v ON v.id = at.exam_version_id
        WHERE at.id = $1 AND at.organisation_id = $2 AND a.candidate_id = $3`,
      [attemptId, organisationId, candidateId, UPLOAD_AFTER_SUBMIT_HOURS],
    );
    if (!rows[0]) throw notFound('Attempt');
    if (rows[0].late) throw conflict('Recordings for this attempt are no longer accepted');
    return rows[0];
  }

  // One piece of a recording. Each piece is a complete file, so a lost piece
  // leaves a gap rather than breaking the rest. Sending the same piece again is safe.
  app.post('/attempts/:id/recording/:stream/:sequence', async (req, reply) => {
    const auth = requireCandidate(req);
    const { id, stream, sequence } = parse(chunkParams, req.params);
    const headers = parse(chunkHeaders, req.headers);
    const type = mediaType(req.headers['content-type']);
    const ext = MEDIA_TYPES[type];
    const body = req.body;
    if (!ext || !Buffer.isBuffer(body) || body.length === 0) throw badRequest('Send the recording as WebM, MP4 or JPEG');
    if (new Date(headers['x-chunk-end']) < new Date(headers['x-chunk-start'])) throw badRequest('The chunk ends before it starts');

    const target = await uploadTarget(id, auth.organisationId, auth.candidateId);
    if (!expectedStreams(target.config).includes(stream)) throw badRequest(`This exam does not record ${stream}`);
    const checksum = createHash('sha256').update(body).digest('hex');
    if (checksum !== headers['x-chunk-sha256']) throw badRequest('The recording was damaged in transit; send it again');

    const key = `${auth.organisationId}/${id}/${stream}/${String(sequence).padStart(6, '0')}.${ext}`;
    const result = await withTransaction(db, async (tx) => {
      await tx.query(
        `INSERT INTO recording_streams (attempt_id, stream_type) VALUES ($1, $2) ON CONFLICT (attempt_id, stream_type) DO NOTHING`,
        [id, stream],
      );
      const { rows: s } = await tx.query<{ id: string }>('SELECT id FROM recording_streams WHERE attempt_id = $1 AND stream_type = $2', [id, stream]);
      const streamId = s[0]!.id;
      const { rows: existing } = await tx.query<{ checksum: string }>(
        'SELECT checksum FROM recording_chunks WHERE stream_id = $1 AND sequence = $2 FOR UPDATE',
        [streamId, sequence],
      );
      if (existing[0]) {
        if (existing[0].checksum !== checksum) throw conflict(`Chunk ${sequence} was already received with different content`);
        return { duplicate: true };
      }
      // Stored before the row commits: a failed write leaves no record pointing at nothing.
      await store.put(key, body);
      await tx.query(
        `INSERT INTO recording_chunks (stream_id, sequence, start_time, end_time, checksum, storage_key, upload_state, content_type, size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6, 'uploaded', $7, $8)`,
        [streamId, sequence, headers['x-chunk-start'], headers['x-chunk-end'], checksum, key, type, body.length],
      );
      await verifySubmission(tx, id);
      return { duplicate: false };
    });
    return reply.code(result.duplicate ? 200 : 201).send({ sequence, ...result });
  });

  // Where each stream got to, so a reopened exam carries on numbering instead of starting again at 0.
  app.get('/attempts/:id/recording/state', async (req) => {
    const auth = requireCandidate(req);
    const { id } = parse(idParams, req.params);
    const target = await uploadTarget(id, auth.organisationId, auth.candidateId);
    const { rows } = await db.query<{ stream_type: StreamType; next: number }>(
      `SELECT rs.stream_type, max(rc.sequence) + 1 AS next FROM recording_streams rs
         JOIN recording_chunks rc ON rc.stream_id = rs.id WHERE rs.attempt_id = $1 GROUP BY rs.stream_type`,
      [id],
    );
    return { streams: expectedStreams(target.config), next: Object.fromEntries(rows.map((r) => [r.stream_type, r.next])) };
  });

  // The app declares the last piece of each stream once it has sent everything.
  app.post('/attempts/:id/recording/complete', async (req) => {
    const auth = requireCandidate(req);
    const { id } = parse(idParams, req.params);
    const { streams } = parse(completeBody, req.body);
    await uploadTarget(id, auth.organisationId, auth.candidateId);
    return withTransaction(db, async (tx) => {
      await tx.query(`UPDATE attempts SET recording_manifest = coalesce(recording_manifest, '{}'::jsonb) || $2::jsonb WHERE id = $1`, [
        id,
        JSON.stringify(streams),
      ]);
      const status = await verifySubmission(tx, id);
      const state = await evidenceState(tx, id);
      return { submission: status, missing: state.missing, incomplete: state.incomplete };
    });
  });

  // A camera still for the live console. Only the latest one is kept.
  app.post('/attempts/:id/snapshot', { bodyLimit: MAX_SNAPSHOT_BYTES }, async (req, reply) => {
    const auth = requireCandidate(req);
    const { id } = parse(idParams, req.params);
    if (mediaType(req.headers['content-type']) !== 'image/jpeg' || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw badRequest('Send the snapshot as image/jpeg');
    }
    const target = await uploadTarget(id, auth.organisationId, auth.candidateId);
    if (target.status !== 'active') throw conflict('This attempt has ended');
    const key = `${auth.organisationId}/${id}/snapshot.jpg`;
    await store.put(key, req.body);
    await db.query('UPDATE attempts SET snapshot_key = $2, snapshot_at = now() WHERE id = $1', [id, key]);
    return reply.code(204).send();
  });

  // Staff review: every stream and piece, and whether the evidence is complete.
  app.get('/attempts/:id/recordings', { preHandler: authorize('recording:view') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const { rows } = await db.query<{ submission: string | null }>(
      `SELECT s.status AS submission FROM attempts at LEFT JOIN submissions s ON s.attempt_id = at.id
        WHERE at.id = $1 AND at.organisation_id = $2`,
      [id, auth.organisationId],
    );
    if (!rows[0]) throw notFound('Attempt');
    const { rows: chunks } = await db.query<{ stream: StreamType; id: string; sequence: number; startTime: Date; endTime: Date; sizeBytes: number; contentType: string }>(
      `SELECT rs.stream_type AS stream, rc.id, rc.sequence, rc.start_time AS "startTime", rc.end_time AS "endTime",
              rc.size_bytes AS "sizeBytes", rc.content_type AS "contentType"
         FROM recording_chunks rc JOIN recording_streams rs ON rs.id = rc.stream_id
        WHERE rs.attempt_id = $1 AND rc.upload_state = 'uploaded'
        ORDER BY rs.stream_type, rc.sequence`,
      [id],
    );
    const state = await evidenceState(db, id);
    await withTransaction(db, (tx) => audit(tx, { ...auditFrom(req), action: 'recording.list', targetType: 'attempt', targetId: id }));
    const streams = [...new Set([...state.expected, ...chunks.map((c) => c.stream)])].map((type) => ({
      type,
      chunks: chunks.filter((c) => c.stream === type).map(({ stream: _s, ...c }) => c),
    }));
    return { attemptId: id, submission: rows[0].submission, evidence: state, streams };
  });

  app.get('/recording-chunks/:id', { preHandler: authorize('recording:view') }, async (req, reply) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const { rows } = await db.query<{ storage_key: string; content_type: string }>(
      `SELECT rc.storage_key, rc.content_type FROM recording_chunks rc
         JOIN recording_streams rs ON rs.id = rc.stream_id
         JOIN attempts at ON at.id = rs.attempt_id
        WHERE rc.id = $1 AND at.organisation_id = $2 AND rc.upload_state = 'uploaded'`,
      [id, auth.organisationId],
    );
    if (!rows[0]) throw notFound('Recording');
    const object = await store.get(rows[0].storage_key);
    if (!object) throw notFound('Recording');
    return reply
      .header('content-type', rows[0].content_type)
      .header('content-length', object.size)
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .send(object.stream);
  });
}
