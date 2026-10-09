import { createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyManifest } from '../src/signing.js';
import { call, createOrg, publishedExam, useHarness } from './helpers.js';

const h = useHarness();

describe('exam publishing', () => {
  it('refuses to publish an incomplete exam', async () => {
    const org = await createOrg(h);
    const exam = await call(h, 'POST', '/exams', org.owner, { code: 'EMPTY', name: 'Empty' });
    const res = await call(h, 'POST', `/exams/${exam.body.id}/publish`, org.owner);
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual(['Duration is required', 'At least one question is required']);
  });

  it('rejects invalid questions', async () => {
    const org = await createOrg(h);
    const res = await call(h, 'POST', '/questions', org.owner, {
      type: 'mcq',
      prompt: 'Two right answers?',
      options: [{ label: 'a', isCorrect: true }, { label: 'b', isCorrect: true }],
    });
    expect(res.status).toBe(400);
  });

  it('signs a manifest that excludes correct answers and verifies with the published key', async () => {
    const org = await createOrg(h);
    const { versionId } = await publishedExam(h, org);
    const pkg = await call(h, 'GET', `/exam-versions/${versionId}/package`, org.owner);
    const key = await call(h, 'GET', '/exam-signing-key');

    expect(JSON.stringify(pkg.body.manifest)).not.toMatch(/isCorrect|correct/i);
    expect(pkg.body.manifest.questions[0].options).toHaveLength(3);
    expect(verifyManifest(pkg.body.manifest, pkg.body.signature, createPublicKey(key.body.publicKeyPem))).toBe(true);

    const tampered = { ...pkg.body.manifest, name: 'Something else' };
    expect(verifyManifest(tampered, pkg.body.signature, createPublicKey(key.body.publicKeyPem))).toBe(false);
  });

  // Spec section 22: "Exam version cannot change silently after candidates begin."
  it('keeps published versions immutable; later edits produce a new version', async () => {
    const org = await createOrg(h);
    const { examId, versionId } = await publishedExam(h, org);
    const v1 = await call(h, 'GET', `/exam-versions/${versionId}/package`, org.owner);

    await call(h, 'PATCH', `/exams/${examId}`, org.owner, { name: 'Mathematics 101 (revised)' });
    const v1Again = await call(h, 'GET', `/exam-versions/${versionId}/package`, org.owner);
    expect(v1Again.body).toEqual(v1.body);

    const v2 = await call(h, 'POST', `/exams/${examId}/publish`, org.owner);
    expect(v2.body.version).toBe(2);
    expect(v2.body.manifestSha256).not.toBe(v1.body.manifestSha256);

    await expect(h.db.query(`UPDATE exam_versions SET manifest = '{}' WHERE id = $1`, [versionId])).rejects.toThrow(
      /append-only/,
    );
  });
});

describe('published versions list', () => {
  it('lists versions for session creation, inside the organisation only', async () => {
    const org = await createOrg(h);
    const { versionId } = await publishedExam(h, org);
    const res = await call(h, 'GET', '/exam-versions', org.owner);
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({ id: versionId, version: 1, name: 'Mathematics 101', durationMinutes: 90 });
    const other = await createOrg(h);
    expect((await call(h, 'GET', '/exam-versions', other.owner)).body.items).toEqual([]);
  });
});
