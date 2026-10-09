// Development only: fills a running local API with a demo organisation, an
// approved candidate and an exam session that is already open, so the
// candidate app can be tried end to end. Run `npm run dev` first.

const API = process.env.API_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD;
const PASSWORD = 'demo-password-123';

if (process.env.NODE_ENV === 'production') {
  console.error('The demo script is for local development only.');
  process.exit(1);
}
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD to the account created by `npm run seed:dev`.');
  process.exit(1);
}

async function call<T = any>(method: string, path: string, token: string | null, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} failed (${res.status}): ${JSON.stringify(data)}`);
  return data as T;
}

const slug = `demo-${Date.now().toString(36)}`;
const root = (await call('POST', '/auth/login', null, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).accessToken;

await call('POST', '/platform/organisations', root, {
  slug,
  name: 'Demo University',
  mode: 'university',
  approvedEmailDomains: [`${slug}.example`],
  owner: { email: `owner@${slug}.example`, displayName: 'Demo Owner', password: PASSWORD },
});
const owner = (await call('POST', '/auth/login', null, { organisation: slug, email: `owner@${slug}.example`, password: PASSWORD }))
  .accessToken;

// An address outside the approved domain goes to manual review, so the owner
// can approve it straight away without an email verification step.
const loginEmail = `student-${slug}@example.com`;
const { candidateId } = await call('POST', `/public/organisations/${slug}/register`, null, {
  email: loginEmail,
  fullName: 'Demo Student',
  password: PASSWORD,
});
await call('POST', `/candidates/${candidateId}/approve`, owner, {});

const exam = await call('POST', '/exams', owner, {
  code: 'MATH101',
  name: 'Mathematics 101',
  config: {
    // Generous start window so the demo stays usable for the whole session.
    timing: { durationMinutes: 120, startWindowMinutes: 170 },
    // Leaving the exam is warned about three times; the fourth ends it.
    // RECORD_SCREEN=1 also records the screen (the browser asks to share it).
    security: {
      camera: true,
      microphone: true,
      screenCapture: process.env.RECORD_SCREEN === '1',
      violationPolicy: 'warn_then_submit',
      maxViolations: 3,
    },
    // Browsers report a storage quota, not free disk space, so keep this low for the demo.
    device: {
      supportedOs: ['windows', 'macos', 'linux', 'chromeos', 'android', 'ios'],
      minFreeStorageMb: 100,
      // REQUIRE_DESKTOP_APP=1 makes a desktop only exam; ALLOW_VIRTUAL_MACHINES=1 lets it run in one.
      requireDesktopApp: process.env.REQUIRE_DESKTOP_APP === '1',
      allowVirtualMachines: process.env.ALLOW_VIRTUAL_MACHINES === '1',
    },
  },
});
const questions: [string, string[], number][] = [
  ['Which statement best describes a prime number?', ['It has exactly two distinct positive divisors', 'It is always odd', 'It is divisible by 3', 'It is greater than 10'], 0],
  ['What is the derivative of x²?', ['x', '2x', 'x²', '2'], 1],
  ['Solve for x: 3x + 5 = 20', ['3', '4', '5', '6'], 2],
];
const questionIds: string[] = [];
for (const [prompt, options, correct] of questions) {
  const q = await call('POST', '/questions', owner, {
    type: 'mcq',
    prompt,
    options: options.map((label, i) => ({ label, isCorrect: i === correct })),
  });
  questionIds.push(q.id);
}
questionIds.push((await call('POST', '/questions', owner, { type: 'essay', prompt: 'Explain why the square root of 2 is irrational.' })).id);
await call('PUT', `/exams/${exam.id}/questions`, owner, { items: questionIds.map((questionId) => ({ questionId, points: 2 })) });
const version = await call('POST', `/exams/${exam.id}/publish`, owner);

const session = await call('POST', '/sessions', owner, {
  examVersionId: version.id,
  name: 'Demo sitting',
  startsAt: new Date(Date.now() - 60_000).toISOString(),
  endsAt: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
});
await call('POST', '/assignments', owner, { sessionId: session.id, candidateIds: [candidateId] });
await call('PATCH', `/sessions/${session.id}`, owner, { status: 'open' });

// Staff to try the portal with: an invigilator watching the candidate, and a marker.
const invigilatorEmail = `invigilator@${slug}.example`;
const markerEmail = `marker@${slug}.example`;
const invigilator = await call('POST', '/invigilators', owner, { email: invigilatorEmail, displayName: 'Demo Invigilator', password: PASSWORD });
await call('POST', `/sessions/${session.id}/invigilators`, owner, { invigilatorIds: [invigilator.id] });
await call('POST', '/live/assignments', owner, { mode: 'auto', sessionId: session.id });
const org = (await call('GET', '/me', owner)).organisationId;
await call('POST', `/organisations/${org}/users`, owner, { email: markerEmail, displayName: 'Demo Marker', role: 'reviewer', password: PASSWORD });

console.log(`
Demo ready. Every account uses the password ${PASSWORD}
and the organisation code ${slug}

Candidate app, http://localhost:5173
  Institution or organisation:  ${slug}
  Email:                        ${loginEmail}
  Password:                     ${PASSWORD}

Staff portal, http://localhost:5174
  Owner (everything):           owner@${slug}.example
  Invigilator (live console):   ${invigilatorEmail}
  Marker (marking):             ${markerEmail}

The exam session is open now and runs for 3 hours. The exam itself lasts 2 hours.
`);
