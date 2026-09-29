# ExamGuard

Secure online assessment, examination and live invigilation platform. The full product blueprint is in [docs/ExamGuard_Developer_Handoff_Specification_v2.0.pdf](docs/ExamGuard_Developer_Handoff_Specification_v2.0.pdf).

This repository currently holds the **platform API foundation (roadmap phase MVP 1)**, plus the server side rules the specification marks as critical: the invigilator limit of 10, tenant isolation, immutable signed exam versions and an append only audit trail. See [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) for what maps to which section of the specification and what comes next.

## Stack

| Layer | Choice |
|---|---|
| API | Node.js 22, TypeScript, Fastify 5 |
| Validation | Zod schemas on every request body, query and path |
| Database | PostgreSQL 16, plain SQL migrations |
| Auth | Short lived JWT access tokens, rotating opaque refresh tokens, scrypt password hashes |
| Exam signing | Ed25519 over canonical JSON |
| Tests | Vitest against a real PostgreSQL database |

## Running locally

```bash
docker compose up -d postgres        # or use any local PostgreSQL 16
cd api
npm install
cp .env.example .env                 # development defaults work as they are
npm run migrate
SUPER_ADMIN_EMAIL=you@example.com SUPER_ADMIN_PASSWORD='a long password' npm run seed
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

## Tests

```bash
cd api
npm run typecheck
npm test     # recreates the examguard_test database, then runs all suites
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
    modules/         route modules: auth, organisations, candidates, exams, sessions, invigilation
    allocation.ts    invigilator allocation algorithm (spec section 7)
    candidateStatus.ts  candidate lifecycle rules (spec section 4)
    signing.ts       exam manifest canonicalisation and signing
  test/              unit and integration tests
docs/                specification and implementation notes
```
