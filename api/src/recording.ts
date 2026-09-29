import type { Queryable } from './db.js';
import { examConfig } from './examConfig.js';

export type StreamType = 'camera' | 'screen' | 'audio';

/**
 * The recordings an exam asks for. The camera stream carries the microphone
 * too; an exam with a microphone but no camera records sound alone.
 */
export function expectedStreams(rawConfig: unknown): StreamType[] {
  const s = examConfig.parse(rawConfig ?? {}).security;
  const streams: StreamType[] = [];
  if (s.camera) streams.push('camera');
  else if (s.microphone) streams.push('audio');
  if (s.screenCapture) streams.push('screen');
  return streams;
}

export interface EvidenceState {
  expected: StreamType[];
  /** Missing sequence numbers per stream, up to the last one the app declared. */
  missing: Partial<Record<StreamType, number[]>>;
  /** Streams with no recording at all, or no declared end yet. */
  incomplete: StreamType[];
  complete: boolean;
}

/**
 * Checks the recordings of an attempt against what the app said it sent.
 * Complete means every expected stream has at least one chunk and no gaps
 * up to its declared last chunk.
 */
export async function evidenceState(q: Queryable, attemptId: string): Promise<EvidenceState> {
  const { rows } = await q.query<{ config: unknown; manifest: Partial<Record<StreamType, number>> | null }>(
    `SELECT v.manifest->'config' AS config, at.recording_manifest AS manifest
       FROM attempts at JOIN exam_versions v ON v.id = at.exam_version_id WHERE at.id = $1`,
    [attemptId],
  );
  const expected = expectedStreams(rows[0]!.config);
  const declared = rows[0]!.manifest ?? {};
  const { rows: chunks } = await q.query<{ stream_type: StreamType; sequence: number }>(
    `SELECT rs.stream_type, rc.sequence FROM recording_chunks rc JOIN recording_streams rs ON rs.id = rc.stream_id
      WHERE rs.attempt_id = $1 AND rc.upload_state = 'uploaded'`,
    [attemptId],
  );
  const have = new Map<StreamType, Set<number>>();
  for (const c of chunks) (have.get(c.stream_type) ?? have.set(c.stream_type, new Set()).get(c.stream_type)!).add(c.sequence);

  const missing: EvidenceState['missing'] = {};
  const incomplete: StreamType[] = [];
  for (const stream of expected) {
    const last = declared[stream];
    const got = have.get(stream) ?? new Set();
    if (last === undefined || last < 0 || got.size === 0) {
      incomplete.push(stream);
      continue;
    }
    const gaps: number[] = [];
    for (let i = 0; i <= last && gaps.length < 100; i++) if (!got.has(i)) gaps.push(i);
    if (gaps.length) missing[stream] = gaps;
  }
  return { expected, missing, incomplete, complete: incomplete.length === 0 && Object.keys(missing).length === 0 };
}

/** Marks a submission verified once its evidence is complete. Returns the submission status. */
export async function verifySubmission(q: Queryable, attemptId: string): Promise<string | null> {
  const { rows } = await q.query<{ status: string }>('SELECT status FROM submissions WHERE attempt_id = $1 FOR UPDATE', [attemptId]);
  const submission = rows[0];
  if (!submission) return null;
  if (submission.status !== 'evidence_pending') return submission.status;
  const state = await evidenceState(q, attemptId);
  if (!state.complete) return submission.status;
  await q.query(`UPDATE submissions SET status = 'verified', verified_at = now() WHERE attempt_id = $1`, [attemptId]);
  return 'verified';
}
