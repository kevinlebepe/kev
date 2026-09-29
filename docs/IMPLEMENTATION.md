# Implementation Notes

Status as at 29 September 2026 (MVP 1 and MVP 2). This file maps the handoff specification (v2.0) to the code and lists what remains.

## What is built

### Data model (spec section 15)

`api/migrations/001_core_model.sql` creates every table the specification names, so later phases add behaviour rather than restructure the schema. Every tenant owned row carries `organisation_id`.

Two decisions differ slightly from the specification's wording:

1. **Candidate status is split in two.** The organisation level status (`invited`, `registered`, `pending_approval`, `approved`, `rejected`, `blocked`) lives on `candidates`. The exam specific states (`assigned`, `precheck_complete`, `active`, `submitted`, `completed`) live on `exam_assignments`, because one candidate can hold several entitlements at once.
2. **Answer keys are separate from manifests.** `exam_versions.manifest` is the signed package sent to candidate devices and never contains correct answers. `exam_versions.answer_key` stays on the server for marking.

### API endpoints

| Area | Endpoint | Permission |
|---|---|---|
| Auth | `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /me` | public or signed in |
| Platform | `POST /platform/organisations` | super admin |
| Organisation | `GET/PATCH /organisations/:id`, `GET/POST /organisations/:id/users` | `organisation:manage_security`, `organisation:manage_users` |
| Audit | `GET /audit` | `audit:view` |
| Candidates | `POST /candidates/invite`, `POST /candidates/import`, `GET /candidates`, `GET /candidates/:id` | `candidate:invite`, `candidate:view` |
| Approval | `POST /candidates/:id/approve`, `reject`, `block`, `unblock`, `request-verification` | `candidate:approve` |
| Onboarding | `POST /public/invitations/accept`, `POST /public/organisations/:slug/register`, `POST /public/verify-email` | public, rate limited |
| Exams | `POST/GET /exams`, `GET/PATCH /exams/:id`, `PUT /exams/:id/questions`, `POST /exams/:id/publish` | `exam:create`, `exam:publish` |
| Questions | `POST/GET /questions` | `exam:create` |
| Packages | `GET /exam-versions/:id/package`, `GET /exam-signing-key` | `exam:create`, public |
| Sessions | `POST /sessions`, `GET /sessions/:id/status`, `POST /sessions/:id/invigilators`, `POST /assignments` | `session:manage`, `invigilation:allocate` |
| Invigilators | `POST/GET /invigilators`, `PATCH /invigilators/:id` | `invigilator:create` |
| Live | `POST /live/assignments` (auto or manual), `POST /live/assignments/:id/release`, `GET /live/sessions/:id` | `invigilation:allocate`, `live:view` |
| Candidate app | `GET /me/entitlements`, `POST /me/entitlements/:id/precheck`, `GET /me/entitlements/:id/package` | signed in candidate |
| Readiness | `GET /sessions/:id/readiness` | `session:manage` |

### Specification requirements covered

| Requirement | Where |
|---|---|
| RBAC with permission keys, enforced by the backend (s2) | `auth/context.ts`; permissions are read from the database on each request, so a suspension takes effect at once |
| Organisation approved email domains; personal emails routed to manual review (s3) | `candidateStatus.ts`, `modules/candidates.ts` |
| Account, approval and entitlement kept separate (s4) | only `approved` candidates can be assigned to a session |
| Invitation and verification tokens are single use and stored only as hashes (s3, s19) | `candidate_tokens` |
| Immutable exam versions, signed manifest, validated publish gate (s6) | `modules/exams.ts`, `signing.ts`, `exam_versions_immutable` trigger |
| Maximum of 10 candidates per invigilator, enforced by the server (s7) | service check with row locks, plus the `invigilation_capacity` database trigger |
| Unassigned queue and administrator alert when all invigilators are full (s7) | `POST /live/assignments` in auto mode |
| Invigilators only see their own candidates (s8) | `GET /live/sessions/:id` |
| Append only audit log, written in the same transaction as the change (s16, s19) | `audit.ts`, `audit_logs_append_only` trigger |
| Tenant isolation on the server; other tenants' records return 404 (s16, s22) | every query scoped by `organisation_id`; `test/isolation.test.ts` |
| Rate limiting on login and public endpoints, schema validation, pagination (s16) | `app.ts`, `validation.ts` |
| Refresh token rotation with reuse detection (s19) | `modules/auth.ts` |
| Secrets from the environment; production refuses to start without them (s19) | `config.ts` |
| Notification outbox, so exam controls never depend on email arriving (s20) | `notifications` table |
| Candidates see their entitlements and what the exam will monitor (s4, s9, s22) | `GET /me/entitlements`, candidate app "My exams" |
| Device check available well before exam day; every run stored; organisation sees failures (s10) | `readiness.ts`, `readiness_checks` table, `GET /sessions/:id/readiness` |
| Configurable device requirements: OS, app version, storage, external monitors, virtual machines (s10) | `device` section of the exam config |
| Clock synchronisation check against server time (s4, s10) | `clock` check, 120 seconds tolerance |
| Package released only after a passed check and inside the session window (s3, s4) | `GET /me/entitlements/:id/package` |
| Signed entitlement bound to the manifest hash, for local caching (s3) | `entitlement` in the package response |
| Candidate device verifies package integrity before starting (s6) | `candidate-app/src/lib/verify.ts`; the exam view refuses to show an unverified package |
| Secure exam layout with timer, question navigation and status indicators that do not rely on colour alone (s9, s23) | `candidate-app/src/screens/ExamView.tsx` |
| API instances survive a database failover (s17) | pool error handler in `db.ts`; `test/resilience.test.ts` |
| CI with typecheck, tests and dependency audit (s21) | `.github/workflows/api.yml`, `.github/workflows/candidate-app.yml` |

## Known gaps in this phase

1. **Email delivery.** Notifications are written to the outbox, but no worker sends them yet. The worker must clear `payload.link` after sending, because it contains a live token.
2. **SSO and MFA.** Not built. Login is email and password only.
3. **Account lockout.** Login is rate limited per IP, but repeated failures do not yet lock an account.
4. **Distributed rate limiting.** The rate limiter keeps counts in memory. With several API instances it needs a Redis store.
5. **Database level tenant isolation.** Isolation is enforced in application queries and covered by tests. PostgreSQL row level security would add a second layer.
6. **Staff onboarding.** New staff and invigilators are created with a password set by an administrator. An emailed invitation flow like the one for candidates should replace this.
7. **Invigilator failover.** Assignments are preserved when an invigilator is paused. Automatic reassignment and the `disconnected` status need live presence, which arrives with the live console in MVP 6.
8. **Desktop shell.** The candidate app runs as a web interface. The spec calls for a desktop application (Tauri or Electron) for kiosk mode. All device access already goes through `DeviceBridge`, so the desktop shell only has to supply a native implementation.
9. **Browser device checks are partial.** In a browser, virtual machine detection, kiosk mode and the screen capture permission cannot be tested. The browser reports these as passing, and the screen says so. Storage is the browser's quota, not free disk space. The native bridge must report real values.
10. **Package confidentiality before the start.** The package can be downloaded from 10 minutes before the session (`PACKAGE_PREFETCH_MINUTES`). Earlier offline caching would need the package encrypted, with the key released at the start time.
11. **Local caching.** The candidate app does not yet store the package and entitlement in an encrypted local store. That arrives with MVP 3 and MVP 5 (local state and offline operation).

## Next phases (spec section 24)

| Phase | Scope | Builds on |
|---|---|---|
| MVP 2 | Done, except the desktop shell (see gap 8) | |
| MVP 3 | `POST /attempts/start`, `PATCH /attempts/:id/state` with idempotency keys, submission and auto marking | `attempts`, `answers`, `submissions`, `answer_key` |
| MVP 4 | Chunked recording upload to S3 compatible storage | `recording_streams`, `recording_chunks` (unique on stream and sequence) |
| MVP 5 | Offline sync and recovery | client side encrypted store, server idempotency |
| MVP 6 | Live console over WebRTC, presence, failover | `invigilation_assignments` |
| MVP 7 | Voice contact, events, blackout reports | `invigilation_contacts`, `events` |
| MVP 8 | Results release, recording review, exports, integrations | `results`, `integration_configs` |

The admin portal and invigilator console (React and TypeScript, spec section 13) have not been started. They can be built against the endpoints above, reusing the patterns in `candidate-app/`.
