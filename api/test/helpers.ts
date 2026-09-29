import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createPool, type Db } from '../src/db.js';
import { hashPassword } from '../src/auth/passwords.js';
import { TEST_DATABASE_URL } from './globalSetup.js';

export const PASSWORD = 'correct-horse-battery-staple';

export interface Harness {
  app: FastifyInstance;
  db: Db;
  config: Config;
}

/** One app + pool per test file. Tests isolate themselves by creating their own organisations. */
export function useHarness(): Harness {
  const h = {} as Harness;
  beforeAll(async () => {
    h.config = loadConfig({ databaseUrl: TEST_DATABASE_URL, authRateLimitPerMinute: 100_000 });
    h.db = createPool(TEST_DATABASE_URL);
    h.app = await buildApp({ db: h.db, config: h.config });
  });
  afterAll(async () => {
    await h.app.close();
    await h.db.end();
  });
  return h;
}

export async function call(
  h: Harness,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  token?: string | null,
  body?: unknown,
) {
  const res = await h.app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { status: res.statusCode, body: res.body ? res.json() : undefined };
}

export const uniq = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

export async function superAdminToken(h: Harness): Promise<string> {
  const email = `${uniq('root')}@platform.example`;
  await h.db.query(
    `INSERT INTO users (email, display_name, password_hash, platform_role) VALUES ($1, 'Root', $2, 'super_admin')`,
    [email, await hashPassword(PASSWORD)],
  );
  const res = await call(h, 'POST', '/auth/login', null, { email, password: PASSWORD });
  return res.body.accessToken;
}

export async function login(h: Harness, organisation: string, email: string, password = PASSWORD) {
  const res = await call(h, 'POST', '/auth/login', null, { organisation, email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body as { accessToken: string; refreshToken: string };
}

export interface TestOrg {
  id: string;
  slug: string;
  ownerEmail: string;
  owner: string;
}

export async function createOrg(h: Harness, opts: { approvedEmailDomains?: string[] } = {}): Promise<TestOrg> {
  const root = await superAdminToken(h);
  const slug = uniq('org');
  const ownerEmail = `${uniq('owner')}@${slug}.example`;
  const res = await call(h, 'POST', '/platform/organisations', root, {
    slug,
    name: `Org ${slug}`,
    mode: 'university',
    approvedEmailDomains: opts.approvedEmailDomains ?? [],
    owner: { email: ownerEmail, displayName: 'Owner', password: PASSWORD },
  });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  const { accessToken } = await login(h, slug, ownerEmail);
  return { id: res.body.id, slug, ownerEmail, owner: accessToken };
}

/** Invite → accept → approve; returns the approved candidate id. */
export async function approvedCandidate(h: Harness, org: TestOrg, name = uniq('cand')): Promise<string> {
  const email = `${name}@${org.slug}.example`;
  const invited = await call(h, 'POST', '/candidates/invite', org.owner, { email, fullName: name });
  const token = await latestLinkToken(h, email);
  await call(h, 'POST', '/public/invitations/accept', null, { token, password: PASSWORD });
  const approved = await call(h, 'POST', `/candidates/${invited.body.id}/approve`, org.owner, {});
  if (approved.status !== 200) throw new Error(JSON.stringify(approved.body));
  return invited.body.id;
}

/** Reads the token from the most recent emailed link in the notification outbox. */
export async function latestLinkToken(h: Harness, email: string): Promise<string> {
  const { rows } = await h.db.query<{ link: string }>(
    `SELECT payload->>'link' AS link FROM notifications
      WHERE lower(recipient_email) = lower($1) AND payload ? 'link'
      ORDER BY created_at DESC LIMIT 1`,
    [email],
  );
  if (!rows[0]) throw new Error(`No link emailed to ${email}`);
  return rows[0].link.split('/').pop()!;
}

export async function publishedExam(h: Harness, org: TestOrg, maxPerInvigilator = 10) {
  const exam = await call(h, 'POST', '/exams', org.owner, {
    code: uniq('EX'),
    name: 'Mathematics 101',
    config: { timing: { durationMinutes: 90 }, invigilation: { required: true, maxCandidatesPerInvigilator: maxPerInvigilator } },
  });
  const q = await call(h, 'POST', '/questions', org.owner, {
    type: 'mcq',
    prompt: 'What is 2 + 2?',
    options: [{ label: '3' }, { label: '4', isCorrect: true }, { label: '5' }],
  });
  await call(h, 'PUT', `/exams/${exam.body.id}/questions`, org.owner, { items: [{ questionId: q.body.id, points: 2 }] });
  const version = await call(h, 'POST', `/exams/${exam.body.id}/publish`, org.owner);
  if (version.status !== 201) throw new Error(JSON.stringify(version.body));
  return { examId: exam.body.id as string, versionId: version.body.id as string, questionId: q.body.id as string };
}

export async function session(h: Harness, org: TestOrg, versionId: string): Promise<string> {
  const res = await call(h, 'POST', '/sessions', org.owner, {
    examVersionId: versionId,
    name: 'Morning sitting',
    startsAt: '2026-10-14T09:00:00+02:00',
    endsAt: '2026-10-14T12:00:00+02:00',
  });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.id;
}

export async function invigilator(h: Harness, org: TestOrg) {
  const email = `${uniq('inv')}@${org.slug}.example`;
  const res = await call(h, 'POST', '/invigilators', org.owner, { email, displayName: email, password: PASSWORD });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return { id: res.body.id as string, email };
}
