import type { Db } from './db.js';
import type { ObjectStore } from './storage.js';
import { audit } from './audit.js';

// Deletes recordings once the organisation's retention period has passed
// (spec sections 12 and 19), and camera stills once an attempt has closed.
// The database rows stay, marked deleted, so the record of what existed and
// when it was removed is kept.

export async function applyRetention(db: Db, store: ObjectStore, limit = 200): Promise<{ recordings: number; snapshots: number }> {
  const { rows: due } = await db.query<{ id: string; storage_key: string | null; organisation_id: string; attempt_id: string }>(
    `SELECT rc.id, rc.storage_key, at.organisation_id, at.id AS attempt_id
       FROM recording_chunks rc
       JOIN recording_streams rs ON rs.id = rc.stream_id
       JOIN attempts at ON at.id = rs.attempt_id
       JOIN organisations o ON o.id = at.organisation_id
      WHERE rc.retention_state = 'retained' AND at.status <> 'active'
        AND o.recording_retention_days IS NOT NULL
        AND at.submitted_at < now() - make_interval(days => o.recording_retention_days)
      ORDER BY at.submitted_at
      LIMIT $1`,
    [limit],
  );
  const perAttempt = new Map<string, { organisationId: string; count: number }>();
  for (const chunk of due) {
    // The object goes first: if deleting it fails, the row still says it exists and the next run tries again.
    if (chunk.storage_key) await store.delete(chunk.storage_key);
    await db.query(`UPDATE recording_chunks SET retention_state = 'deleted' WHERE id = $1`, [chunk.id]);
    const entry = perAttempt.get(chunk.attempt_id) ?? { organisationId: chunk.organisation_id, count: 0 };
    entry.count += 1;
    perAttempt.set(chunk.attempt_id, entry);
  }
  for (const [attemptId, { organisationId, count }] of perAttempt) {
    await audit(db, {
      organisationId,
      actorUserId: null,
      action: 'recording.retention_delete',
      targetType: 'attempt',
      targetId: attemptId,
      data: { pieces: count },
    });
  }

  // Camera stills are only for the live console.
  const { rows: stills } = await db.query<{ id: string; snapshot_key: string }>(
    `SELECT id, snapshot_key FROM attempts WHERE snapshot_key IS NOT NULL AND status <> 'active' LIMIT $1`,
    [limit],
  );
  for (const s of stills) {
    await store.delete(s.snapshot_key);
    await db.query('UPDATE attempts SET snapshot_key = NULL WHERE id = $1', [s.id]);
  }
  return { recordings: due.length, snapshots: stills.length };
}
