import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { s3Store, signV4 } from '../src/s3.js';
import { applyRetention } from '../src/retention.js';
import { call, createOrg, useHarness } from './helpers.js';
import { started } from './fixtures.js';

const h = useHarness();
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('S3 request signing', () => {
  it('matches the GET Object example in the Amazon S3 Signature Version 4 documentation', () => {
    const headers = signV4({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { range: 'bytes=0-9' },
      payloadHash: EMPTY,
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      service: 's3',
      date: new Date('2013-05-24T00:00:00Z'),
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('puts, gets and deletes objects with signed requests', async () => {
    const objects = new Map<string, Buffer>();
    const seen: { method: string; url: string; headers: Record<string, string> }[] = [];
    const fakeFetch = (async (url: URL, init: { method: string; headers: Record<string, string>; body?: Uint8Array }) => {
      seen.push({ method: init.method, url: url.toString(), headers: init.headers });
      const key = url.pathname;
      if (init.method === 'PUT') {
        objects.set(key, Buffer.from(init.body!));
        return new Response(null, { status: 200 });
      }
      if (init.method === 'DELETE') {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      const body = objects.get(key);
      return body ? new Response(new Uint8Array(body), { status: 200, headers: { 'content-length': String(body.length) } }) : new Response('no', { status: 404 });
    }) as unknown as typeof fetch;

    const store = s3Store({
      endpoint: 'http://minio.local:9000',
      region: 'af-south-1',
      bucket: 'recordings',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      pathStyle: true,
      serverSideEncryption: 'AES256',
      fetch: fakeFetch,
    });
    await store.put('org/attempt/camera/000001.webm', Buffer.from('video'));
    expect(seen[0]!.url).toBe('http://minio.local:9000/recordings/org/attempt/camera/000001.webm');
    expect(seen[0]!.headers['x-amz-server-side-encryption']).toBe('AES256');
    expect(seen[0]!.headers['x-amz-content-sha256']).toBe(createHash('sha256').update('video').digest('hex'));
    expect(seen[0]!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=key\/\d{8}\/af-south-1\/s3\/aws4_request/);

    const got = await store.get('org/attempt/camera/000001.webm');
    const chunks: Buffer[] = [];
    for await (const c of got!.stream) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).toString()).toBe('video');
    expect(got!.size).toBe(5);

    await store.delete('org/attempt/camera/000001.webm');
    expect(await store.get('org/attempt/camera/000001.webm')).toBeNull();
    await store.delete('org/attempt/camera/000001.webm');
  });
});

describe('recording retention', () => {
  async function recorded() {
    const org = await createOrg(h);
    const c = await started(h, org, { camera: true });
    const body = Buffer.from('piece');
    const res = await h.app.inject({
      method: 'POST',
      url: `/attempts/${c.attemptId}/recording/camera/0`,
      headers: {
        authorization: `Bearer ${c.token}`,
        'content-type': 'video/webm',
        'x-chunk-sha256': createHash('sha256').update(body).digest('hex'),
        'x-chunk-start': new Date(Date.now() - 1000).toISOString(),
        'x-chunk-end': new Date().toISOString(),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    await h.app.inject({ method: 'POST', url: `/attempts/${c.attemptId}/snapshot`, headers: { authorization: `Bearer ${c.token}`, 'content-type': 'image/jpeg' }, payload: Buffer.from('still') });
    await call(h, 'POST', `/attempts/${c.attemptId}/submit`, c.token, {});
    return { org, c };
  }

  it('deletes recordings once the organisation’s period has passed, keeping a record', async () => {
    const { org, c } = await recorded();
    const key = `${org.id}/${c.attemptId}/camera/000000.webm`;
    expect(h.store.keys()).toContain(key);
    expect((await call(h, 'PATCH', `/organisations/${org.id}`, org.owner, { recordingRetentionDays: 30 })).body.recordingRetentionDays).toBe(30);

    await applyRetention(h.db, h.store, 5000);
    // Still inside the period: kept. The camera still goes as soon as the exam closes.
    expect(h.store.keys()).toContain(key);
    expect(h.store.keys()).not.toContain(`${org.id}/${c.attemptId}/snapshot.jpg`);

    await h.db.query(`UPDATE attempts SET submitted_at = now() - interval '31 days' WHERE id = $1`, [c.attemptId]);
    await applyRetention(h.db, h.store, 5000);
    expect(h.store.keys()).not.toContain(key);
    const list = await call(h, 'GET', `/attempts/${c.attemptId}/recordings`, org.owner);
    expect(list.body.streams[0].chunks).toEqual([]);
    expect(list.body.deletedPieces).toBe(1);
    const { rows } = await h.db.query(`SELECT action FROM audit_logs WHERE target_id = $1 AND action = 'recording.retention_delete'`, [c.attemptId]);
    expect(rows).toHaveLength(1);
  });

  it('keeps recordings when the organisation chooses no period', async () => {
    const { org, c } = await recorded();
    await call(h, 'PATCH', `/organisations/${org.id}`, org.owner, { recordingRetentionDays: null });
    await h.db.query(`UPDATE attempts SET submitted_at = now() - interval '10 years' WHERE id = $1`, [c.attemptId]);
    await applyRetention(h.db, h.store, 5000);
    expect(h.store.keys()).toContain(`${org.id}/${c.attemptId}/camera/000000.webm`);
  });
});
