// Load test (spec sections 21 and 25): many candidates sign in at once, sit an
// exam that saves answers, checks in and, if asked, uploads recording pieces,
// then submit. Prints the latency of each kind of request and any errors.
//
// Run it against a local or staging API, never production. The API under
// test needs a high sign in rate limit, for example
// AUTH_RATE_LIMIT_PER_MINUTE=100000, because every candidate signs in from
// this one machine.
//
//   SUPER_ADMIN_EMAIL=... SUPER_ADMIN_PASSWORD=... CANDIDATES=200 MINUTES=3 RECORD=1 npm run loadtest:dev

import { createHash, randomUUID } from 'node:crypto';

const API = process.env.API_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD;
const CANDIDATES = Number(process.env.CANDIDATES ?? 50);
const MINUTES = Number(process.env.MINUTES ?? 2);
const RECORD = process.env.RECORD === '1';
const SAVE_SECONDS = Number(process.env.SAVE_SECONDS ?? 5);
const PIECE_KB = Number(process.env.PIECE_KB ?? 256);
const PASSWORD = 'load-test-password-123';

if (process.env.NODE_ENV === 'production') {
  console.error('The load test is not for production.');
  process.exit(1);
}
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD.');
  process.exit(1);
}

const timings = new Map<string, number[]>();
const errors = new Map<string, number>();

async function call<T = any>(kind: string, method: string, path: string, token: string | null, body?: unknown, raw?: { data: Buffer; headers: Record<string, string> }): Promise<T> {
  const started = performance.now();
  try {
    const res = await fetch(API + path, {
      method,
      headers: {
        ...(raw ? raw.headers : body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: raw ? new Uint8Array(raw.data) : body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(data).slice(0, 200)}`);
    return data as T;
  } catch (err) {
    errors.set(kind, (errors.get(kind) ?? 0) + 1);
    if ((errors.get(kind) ?? 0) <= 3) console.error(`${kind}: ${(err as Error).message}`);
    throw err;
  } finally {
    (timings.get(kind) ?? timings.set(kind, []).get(kind)!).push(performance.now() - started);
  }
}

/** Runs tasks with at most `limit` at a time. */
async function pool<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i]!, i).catch(() => undefined);
      }
    }),
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (list: number[], p: number) => {
  const s = [...list].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! : 0;
};

console.log(`Load test against ${API}: ${CANDIDATES} candidates, ${MINUTES} minutes${RECORD ? `, recording ${PIECE_KB} KB pieces` : ''}.`);

// ---- Set up: an organisation, an exam of 20 questions, an open session ----
const slug = `load-${Date.now().toString(36)}`;
const root = (await call('setup', 'POST', '/auth/login', null, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).accessToken;
await call('setup', 'POST', '/platform/organisations', root, {
  slug,
  name: 'Load test',
  mode: 'university',
  owner: { email: `owner@${slug}.example`, displayName: 'Load Owner', password: PASSWORD },
});
const owner = (await call('setup', 'POST', '/auth/login', null, { organisation: slug, email: `owner@${slug}.example`, password: PASSWORD })).accessToken;
const exam = await call('setup', 'POST', '/exams', owner, {
  code: 'LOAD1',
  name: 'Load test exam',
  config: {
    timing: { durationMinutes: MINUTES + 30, startWindowMinutes: 60 },
    security: { camera: RECORD, fullscreen: false },
    device: { supportedOs: ['windows', 'macos', 'linux'], minFreeStorageMb: 0, allowVirtualMachines: true },
  },
});
const questionIds: string[] = [];
for (let i = 0; i < 20; i++) {
  const q = await call('setup', 'POST', '/questions', owner, { type: 'mcq', prompt: `Question ${i + 1}`, options: [{ label: 'A', isCorrect: true }, { label: 'B' }, { label: 'C' }] });
  questionIds.push(q.id);
}
await call('setup', 'PUT', `/exams/${exam.id}/questions`, owner, { items: questionIds.map((questionId) => ({ questionId, points: 1 })) });
const version = await call('setup', 'POST', `/exams/${exam.id}/publish`, owner);
const pkg = await call('setup', 'GET', `/exam-versions/${version.id}/package`, owner);
const options = new Map<string, string>(pkg.manifest.questions.map((q: { id: string; options: { id: string }[] }) => [q.id, q.options[0]!.id]));
const sessionRes = await call('setup', 'POST', '/sessions', owner, {
  examVersionId: version.id,
  name: 'Load sitting',
  startsAt: new Date(Date.now() - 60_000).toISOString(),
  endsAt: new Date(Date.now() + (MINUTES + 60) * 60_000).toISOString(),
});
await call('setup', 'PATCH', `/sessions/${sessionRes.id}`, owner, { status: 'open' });

// ---- Candidates register, are approved and assigned ----
const people = Array.from({ length: CANDIDATES }, (_, i) => ({ email: `c${i}-${slug}@example.com`, id: '', token: '', assignmentId: '', attemptId: '' }));
await pool(people, 20, async (p, i) => {
  const r = await call('register', 'POST', `/public/organisations/${slug}/register`, null, { email: p.email, fullName: `Candidate ${i}`, password: PASSWORD });
  p.id = r.candidateId;
  await call('approve', 'POST', `/candidates/${p.id}/approve`, owner, {});
});
await call('assign', 'POST', '/assignments', owner, { sessionId: sessionRes.id, candidateIds: people.filter((p) => p.id).map((p) => p.id) });
console.log(`Set up: organisation ${slug}, ${people.filter((p) => p.id).length} candidates assigned.`);

// ---- Peak sign in and device checks: everyone at once ----
const report = {
  appVersion: '1.0.0',
  os: { platform: 'windows', version: '11' },
  camera: { detected: true },
  microphone: { detected: true },
  screenCapture: { ready: true },
  storage: { freeMb: 10_000 },
  displays: { count: 1 },
  virtualMachine: { detected: false },
  network: { tested: true, latencyMs: 40 },
};
const peakStarted = performance.now();
await pool(people, CANDIDATES, async (p) => {
  p.token = (await call('login', 'POST', '/auth/login', null, { organisation: slug, email: p.email, password: PASSWORD })).accessToken;
  p.assignmentId = (await call('entitlements', 'GET', '/me/entitlements', p.token)).items[0].id;
  await call('device check', 'POST', `/me/entitlements/${p.assignmentId}/precheck`, p.token, { ...report, clientTime: new Date().toISOString() });
  await call('package', 'GET', `/me/entitlements/${p.assignmentId}/package`, p.token);
  p.attemptId = (await call('start', 'POST', '/attempts/start', p.token, { assignmentId: p.assignmentId })).id;
});
console.log(`Peak sign in: ${people.filter((p) => p.attemptId).length} candidates signed in and started in ${((performance.now() - peakStarted) / 1000).toFixed(1)} s.`);

// ---- Sitting: saves, check ins and recording pieces ----
const until = Date.now() + MINUTES * 60_000;
const piece = Buffer.alloc(PIECE_KB * 1024, 7);
const pieceHash = createHash('sha256').update(piece).digest('hex');
await pool(
  people.filter((p) => p.attemptId),
  CANDIDATES,
  async (p) => {
    let seq = 0;
    let sequence = 0;
    let lastBeat = 0;
    let lastPiece = Date.now();
    await sleep(Math.random() * SAVE_SECONDS * 1000);
    while (Date.now() < until) {
      const q = questionIds[seq % questionIds.length]!;
      seq += 1;
      await call('save', 'PATCH', `/attempts/${p.attemptId}/state`, p.token, { answers: [{ questionId: q, seq, response: { optionId: options.get(q) } }], position: seq % 20 }).catch(() => undefined);
      if (Date.now() - lastBeat > 10_000) {
        lastBeat = Date.now();
        await call('heartbeat', 'POST', `/attempts/${p.attemptId}/heartbeat`, p.token, {}).catch(() => undefined);
      }
      if (RECORD && Date.now() - lastPiece > 30_000) {
        const start = new Date(lastPiece).toISOString();
        lastPiece = Date.now();
        await call('recording piece', 'POST', `/attempts/${p.attemptId}/recording/camera/${sequence++}`, p.token, undefined, {
          data: piece,
          headers: { 'content-type': 'video/webm', 'x-chunk-sha256': pieceHash, 'x-chunk-start': start, 'x-chunk-end': new Date().toISOString() },
        }).catch(() => undefined);
      }
      await sleep(SAVE_SECONDS * 1000);
    }
    if (RECORD) await call('recording complete', 'POST', `/attempts/${p.attemptId}/recording/complete`, p.token, { streams: { camera: sequence - 1 } }).catch(() => undefined);
    await call('submit', 'POST', `/attempts/${p.attemptId}/submit`, p.token, { answers: [] }).catch(() => undefined);
  },
);

// ---- Results ----
console.log('\nRequest            count   p50 ms   p95 ms   p99 ms   max ms  errors');
for (const [kind, list] of [...timings].sort()) {
  if (kind === 'setup') continue;
  console.log(
    `${kind.padEnd(18)} ${String(list.length).padStart(5)} ${pct(list, 50).toFixed(0).padStart(8)} ${pct(list, 95).toFixed(0).padStart(8)} ${pct(list, 99).toFixed(0).padStart(8)} ${Math.max(...list).toFixed(0).padStart(8)} ${String(errors.get(kind) ?? 0).padStart(7)}`,
  );
}
const failed = [...errors.entries()].filter(([k]) => k !== 'setup').reduce((n, [, v]) => n + v, 0);
console.log(`\n${failed ? `${failed} requests failed.` : 'No requests failed.'} Run id ${randomUUID().slice(0, 8)}; organisation ${slug} can be deleted afterwards.`);
process.exit(failed ? 1 : 0);
