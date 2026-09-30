import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { expectedStreams } from '../src/recording.js';
import { call, createOrg, invigilator, login, type TestOrg, useHarness } from './helpers.js';
import { started } from './fixtures.js';

const h = useHarness();

const RECORDED = { camera: true, microphone: true, screenCapture: true };

async function upload(
  token: string,
  attemptId: string,
  stream: string,
  sequence: number,
  body: Buffer,
  opts: { type?: string; sha?: string; start?: Date; end?: Date } = {},
) {
  const res = await h.app.inject({
    method: 'POST',
    url: `/attempts/${attemptId}/recording/${stream}/${sequence}`,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': opts.type ?? 'video/webm;codecs=vp8,opus',
      'x-chunk-sha256': opts.sha ?? createHash('sha256').update(body).digest('hex'),
      'x-chunk-start': (opts.start ?? new Date(Date.now() - 10_000)).toISOString(),
      'x-chunk-end': (opts.end ?? new Date()).toISOString(),
    },
    payload: body,
  });
  return { status: res.statusCode, body: res.json() };
}

const submission = async (attemptId: string) =>
  (await h.db.query<{ status: string }>('SELECT status FROM submissions WHERE attempt_id = $1', [attemptId])).rows[0]?.status;

async function submit(c: { token: string; attemptId: string }) {
  expect((await call(h, 'POST', `/attempts/${c.attemptId}/submit`, c.token, {})).status).toBe(200);
}

describe('which recordings an exam needs', () => {
  it('follows the exam settings', () => {
    expect(expectedStreams({})).toEqual([]);
    expect(expectedStreams({ security: { camera: true, microphone: true } })).toEqual(['camera']);
    expect(expectedStreams({ security: { microphone: true } })).toEqual(['audio']);
    expect(expectedStreams({ security: RECORDED })).toEqual(['camera', 'screen']);
  });
});

describe('recording upload', () => {
  it('stores each piece once, and refuses a different piece under the same number', async () => {
    const org = await createOrg(h);
    const c = await started(h, org, RECORDED);
    const piece = Buffer.from('webm piece zero');
    expect((await upload(c.token, c.attemptId, 'camera', 0, piece)).status).toBe(201);
    const again = await upload(c.token, c.attemptId, 'camera', 0, piece);
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect((await upload(c.token, c.attemptId, 'camera', 0, Buffer.from('something else'))).status).toBe(409);
    expect(h.store.keys().filter((k) => k.includes(c.attemptId))).toEqual([`${org.id}/${c.attemptId}/camera/000000.webm`]);
  });

  it('tells a reopened exam where each stream got to', async () => {
    const org = await createOrg(h);
    const c = await started(h, org, RECORDED);
    await upload(c.token, c.attemptId, 'camera', 0, Buffer.from('a'));
    await upload(c.token, c.attemptId, 'camera', 1, Buffer.from('b'));
    const state = await call(h, 'GET', `/attempts/${c.attemptId}/recording/state`, c.token);
    expect(state.body).toEqual({ streams: ['camera', 'screen'], next: { camera: 2 } });
  });

  it('refuses piece numbers the length of the exam cannot reach', async () => {
    const org = await createOrg(h);
    const c = await started(h, org, { camera: true });
    // The fixture exam lasts 60 minutes: at most 360 pictures, doubled, plus 50.
    expect((await upload(c.token, c.attemptId, 'camera', 770, Buffer.from('x'))).status).toBe(201);
    expect((await upload(c.token, c.attemptId, 'camera', 771, Buffer.from('y'))).status).toBe(400);
  });

  it('refuses damaged pieces, unknown streams and other people’s attempts', async () => {
    const org = await createOrg(h);
    const c = await started(h, org, { camera: true });
    expect((await upload(c.token, c.attemptId, 'camera', 0, Buffer.from('x'), { sha: 'a'.repeat(64) })).status).toBe(400);
    expect((await upload(c.token, c.attemptId, 'screen', 0, Buffer.from('x'))).status).toBe(400);
    expect((await upload(c.token, c.attemptId, 'camera', 0, Buffer.from('x'), { type: 'text/html' })).status).toBe(415);
    const other = await started(h, org, { camera: true });
    expect((await upload(other.token, c.attemptId, 'camera', 0, Buffer.from('x'))).status).toBe(404);
  });

  it('verifies the submission only when every declared piece has arrived', async () => {
    const org = await createOrg(h);
    const c = await started(h, org, RECORDED);
    await upload(c.token, c.attemptId, 'camera', 0, Buffer.from('c0'));
    await upload(c.token, c.attemptId, 'screen', 0, Buffer.from('s0'));
    await submit(c);
    expect(await submission(c.attemptId)).toBe('evidence_pending');

    const declared = await call(h, 'POST', `/attempts/${c.attemptId}/recording/complete`, c.token, { streams: { camera: 1, screen: 0 } });
    expect(declared.body).toMatchObject({ submission: 'evidence_pending', missing: { camera: [1] }, incomplete: [] });

    // The last piece arrives after the exam closed, as it would from a slow connection.
    await upload(c.token, c.attemptId, 'camera', 1, Buffer.from('c1'));
    expect(await submission(c.attemptId)).toBe('verified');
  });

  it('does not verify a recording that stops long before the exam ends', async () => {
    const org = await createOrg(h);
    const c = await started(h, org, { camera: true });
    // The only piece covers a moment 10 minutes before now, and the exam is submitted now.
    await h.db.query(`UPDATE attempts SET started_at = now() - interval '20 minutes' WHERE id = $1`, [c.attemptId]);
    const early = new Date(Date.now() - 20 * 60_000);
    await upload(c.token, c.attemptId, 'camera', 0, Buffer.from('p0'), { start: early, end: new Date(early.getTime() + 30_000) });
    await submit(c);
    const res = await call(h, 'POST', `/attempts/${c.attemptId}/recording/complete`, c.token, { streams: { camera: 0 } });
    expect(res.body).toMatchObject({ submission: 'evidence_pending', missing: {}, incomplete: [] });
    const list = await call(h, 'GET', `/attempts/${c.attemptId}/recordings`, org.owner);
    expect(list.body.evidence.uncovered).toEqual(['camera']);
  });

  it('never verifies a stream with nothing in it', async () => {
    const org = await createOrg(h);
    const c = await started(h, org, { camera: true });
    await submit(c);
    const res = await call(h, 'POST', `/attempts/${c.attemptId}/recording/complete`, c.token, { streams: { camera: -1 } });
    expect(res.body).toMatchObject({ submission: 'evidence_pending', incomplete: ['camera'] });
  });

  it('verifies straight away when the exam records nothing', async () => {
    const org = await createOrg(h);
    const c = await started(h, org);
    await submit(c);
    expect(await submission(c.attemptId)).toBe('verified');
  });

  it('lets staff with permission list and play the recordings', async () => {
    const org = await createOrg(h);
    const c = await started(h, org, { camera: true });
    await upload(c.token, c.attemptId, 'camera', 0, Buffer.from('first piece'));
    const list = await call(h, 'GET', `/attempts/${c.attemptId}/recordings`, org.owner);
    expect(list.status).toBe(200);
    expect(list.body.streams).toHaveLength(1);
    expect(list.body.streams[0]).toMatchObject({ type: 'camera', chunks: [{ sequence: 0, sizeBytes: 11, contentType: 'video/webm' }] });

    const chunkId = list.body.streams[0].chunks[0].id;
    const play = await h.app.inject({ method: 'GET', url: `/recording-chunks/${chunkId}`, headers: { authorization: `Bearer ${org.owner}` } });
    expect(play.statusCode).toBe(200);
    expect(play.headers['content-type']).toBe('video/webm');
    expect(play.body).toBe('first piece');

    const outsider = await createOrg(h);
    expect((await call(h, 'GET', `/attempts/${c.attemptId}/recordings`, outsider.owner)).status).toBe(404);
    expect((await call(h, 'GET', `/recording-chunks/${chunkId}`, outsider.owner)).status).toBe(404);
    expect((await call(h, 'GET', `/recording-chunks/${chunkId}`, c.token)).status).toBe(403);
  });
});

describe('live snapshots', () => {
  async function snapshot(token: string, attemptId: string, body: Buffer) {
    const res = await h.app.inject({
      method: 'POST',
      url: `/attempts/${attemptId}/snapshot`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'image/jpeg' },
      payload: body,
    });
    return res.statusCode;
  }

  async function watched(org: TestOrg) {
    const c = await started(h, org, { camera: true });
    const inv = await invigilator(h, org);
    await call(h, 'POST', `/sessions/${c.sessionId}/invigilators`, org.owner, { invigilatorIds: [inv.id] });
    await call(h, 'POST', '/live/assignments', org.owner, { mode: 'auto', sessionId: c.sessionId });
    return { ...c, invToken: (await login(h, org.slug, inv.email)).accessToken };
  }

  it('shows the latest still to the invigilator, and only while the exam runs', async () => {
    const org = await createOrg(h);
    const c = await watched(org);
    expect((await call(h, 'GET', `/live/attempts/${c.attemptId}/snapshot`, c.invToken)).status).toBe(404);
    expect(await snapshot(c.token, c.attemptId, Buffer.from('jpeg one'))).toBe(204);
    expect(await snapshot(c.token, c.attemptId, Buffer.from('jpeg two'))).toBe(204);
    const res = await h.app.inject({ method: 'GET', url: `/live/attempts/${c.attemptId}/snapshot`, headers: { authorization: `Bearer ${c.invToken}` } });
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.body).toBe('jpeg two');
    const view = await call(h, 'GET', `/live/sessions/${c.sessionId}`, c.invToken);
    expect(view.body.candidates[0].snapshotAt).toBeTruthy();

    await submit(c);
    expect(await snapshot(c.token, c.attemptId, Buffer.from('late'))).toBe(409);
  });

  it('refuses a snapshot that is too large', async () => {
    const org = await createOrg(h);
    const c = await started(h, org, { camera: true });
    expect(await snapshot(c.token, c.attemptId, Buffer.alloc(600 * 1024))).toBe(413);
  });
});
