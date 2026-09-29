# ExamGuard

Secure online assessment, examination and live invigilation platform. The full product blueprint is in [docs/ExamGuard_Developer_Handoff_Specification_v2.0.pdf](docs/ExamGuard_Developer_Handoff_Specification_v2.0.pdf).

This repository currently holds:

* **`api/`**: the platform API. It covers roadmap phase MVP 1 (organisations, roles, candidate registration and approval) the server side of MVP 2 (exam entitlements, the pre exam device check and signed exam package delivery) and MVP 3 (exam attempts with a server owned timer, autosave, submission with a signed receipt and automatic marking). It also enforces the rules the specification marks as critical: the invigilator limit of 10, tenant isolation, immutable signed exam versions and an append only audit trail.
* **`candidate-app/`**: the web interface layer of the candidate secure application (spec section 9). Candidates sign in, see their exams, run the device check, open a verified exam package, answer with autosave and a countdown, and submit. The desktop shell with kiosk mode is a later step.

See [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) for what maps to which section of the specification and what comes next.

| Sign in | My exams | Device check | Exam |
|---|---|---|---|
| ![Sign in](docs/screenshots/candidate-sign-in.png) | ![My exams](docs/screenshots/candidate-my-exams.png) | ![Device check](docs/screenshots/candidate-device-check.png) | ![Exam](docs/screenshots/candidate-exam.png) |

| Answering with navigation | Connection lost | Submit | Receipt |
|---|---|---|---|
| ![Exam](docs/screenshots/attempt-exam.png) | ![Offline](docs/screenshots/attempt-offline.png) | ![Confirm](docs/screenshots/attempt-confirm.png) | ![Receipt](docs/screenshots/attempt-receipt.png) |

## Try it yourself

You need [Node.js 22](https://nodejs.org), [Git](https://git-scm.com) and [Docker Desktop](https://www.docker.com/products/docker-desktop) (for the database). Open a terminal and run:

```bash
git clone https://github.com/kevinlebepe/kev.git
cd kev
git checkout claude/new-session-kbmcc6      # until the pull request is merged
docker compose up -d postgres

cd api
npm install
npm run migrate:dev
SUPER_ADMIN_EMAIL=you@example.com SUPER_ADMIN_PASSWORD='a long password' npm run seed:dev
npm run dev
```

Leave that running. In a second terminal:

```bash
cd kev/api
SUPER_ADMIN_EMAIL=you@example.com SUPER_ADMIN_PASSWORD='a long password' npm run demo:dev

cd ../candidate-app
npm install
npm run dev
```

The demo command prints a candidate sign in. Open http://localhost:5173, sign in with it, run the device check (allow camera and microphone when asked), then open the exam and answer the questions. Things worth trying: reload the page halfway (you return to the same place with your answers), turn off Wi-Fi and answer a question (it says "Not saved yet" and sends when you reconnect), and submit to see your receipt. You can run the demo command again at any time for a fresh exam. On Windows, set the two variables with `set SUPER_ADMIN_EMAIL=...` on separate lines before each command, or use Git Bash.

## Stack

| Layer | Choice |
|---|---|
| API | Node.js 22, TypeScript, Fastify 5 |
| Validation | Zod schemas on every request body, query and path |
| Database | PostgreSQL 16, plain SQL migrations |
| Auth | Short lived JWT access tokens, rotating opaque refresh tokens, scrypt password hashes |
| Exam signing | Ed25519 over canonical JSON |
| Tests | Vitest against a real PostgreSQL database |
| Candidate app | React 19, TypeScript, Vite; WebCrypto Ed25519 for package verification |

## Running locally

```bash
docker compose up -d postgres        # or use any local PostgreSQL 16
cd api
npm install
cp .env.example .env                 # development defaults work as they are
npm run migrate:dev
SUPER_ADMIN_EMAIL=you@example.com SUPER_ADMIN_PASSWORD='a long password' npm run seed:dev
npm run dev                          # http://localhost:3000/health
```

Create the first organisation as the super admin:

```bash
TOKEN=$(curl -s -XPOST localhost:3000/auth/login -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"a long password"}' | jq -r .accessToken)

curl -XPOST localhost:3000/platform/organisations -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{
    "slug": "demo-uni", "name": "Demo University", "mode": "university",
    "approvedEmailDomains": ["demo-uni.example"],
    "owner": {"email": "owner@demo-uni.example", "displayName": "Owner", "password": "another long password"}
  }'
```

The owner then signs in with `{"organisation": "demo-uni", "email": ..., "password": ...}`.

To run the candidate app against the local API:

```bash
cd candidate-app
npm install
npm run dev          # http://localhost:5173, proxies /api to localhost:3000
```

Candidates sign in with the organisation slug (for example `demo-uni`), their email and password.

## Production

```bash
cd api
npm ci && npm run build              # compiles src/ to dist/
npm ci --omit=dev                    # runtime dependencies only
NODE_ENV=production npm run migrate  # then: NODE_ENV=production npm start
```

In production the API refuses to start without `JWT_SECRET`, `EXAM_SIGNING_PRIVATE_KEY` and `EXAM_SIGNING_KEY_ID`. Behind a load balancer, set `TRUST_PROXY` to its addresses so rate limits see real client IPs; see `api/.env.example`.

## Tests

```bash
cd api
npm run typecheck
npm test     # recreates the examguard_test database, then runs all suites

cd ../candidate-app
npm run typecheck && npm test && npm run build
```

Set `TEST_DATABASE_URL` if your database is not at `postgres://examguard:examguard@localhost:5432/examguard_test`. The database user needs permission to create databases.

The suites cover the critical acceptance tests from section 22 of the specification, including that an invigilator can never receive an 11th candidate, even under concurrent requests or direct database writes.

## Layout

```
api/
  migrations/        SQL migrations (core data model, spec section 15)
  src/
    app.ts           Fastify app, error handling, auth hook
    auth/            passwords, tokens, request auth context and permission checks
    modules/         route modules: auth, organisations, candidates, exams, sessions, invigilation, candidateApp
    allocation.ts    invigilator allocation algorithm (spec section 7)
    candidateStatus.ts  candidate lifecycle rules (spec section 4)
    readiness.ts     device check evaluation (spec section 10)
    attempts.ts      closing an attempt: receipt, marking, expiry sweep
    marking.ts       automatic marking of choice questions
    signing.ts       exam manifest canonicalisation and signing
  test/              unit and integration tests
candidate-app/
  src/device/        device bridge: browser implementation now, native desktop later
  src/lib/           API client, package verification, server clock, save queue, encrypted local store
  src/screens/       sign in, my exams, device check, exam session, receipt
docs/                specification, implementation notes and screenshots
```
