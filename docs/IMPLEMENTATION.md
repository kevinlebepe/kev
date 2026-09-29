# Implementation Notes

Status as at 29 September 2026: a first version of every roadmap phase (MVP 1 to MVP 8) is built, with the gaps listed at the end. This file maps the handoff specification (v2.0) to the code and says plainly what is not done.

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
| Sessions | `POST /sessions`, `GET /sessions` (also `report:view`), `PATCH /sessions/:id`, `GET /sessions/:id/status`, `POST /sessions/:id/invigilators`, `POST /assignments` | `session:manage`, `invigilation:allocate` |
| Published versions | `GET /exam-versions` | `session:manage` |
| Invigilators | `POST/GET /invigilators`, `PATCH /invigilators/:id` | `invigilator:create` |
| Allocation | `POST /live/assignments` (auto or manual), `POST /live/assignments/:id/release` | `invigilation:allocate` |
| Live console | `GET /live/sessions`, `GET /live/sessions/:id`, `GET /live/attempts/:id`, `GET /live/attempts/:id/snapshot` | `live:view`; invigilators see their own candidates, session managers see all |
| Invigilator actions | `POST /live/attempts/:id/messages`, `/extend`, `/end`, `/notes` | `live:view`, in scope |
| Live video and voice | `POST /live/attempts/:id/calls`, `POST/GET /live/calls/:id/signals`, `POST /live/calls/:id/end`, `GET /live/ice-servers` | `live:view`; voice needs `live:voice` |
| Candidate app | `GET /me/entitlements`, `POST /me/entitlements/:id/precheck`, `GET /me/entitlements/:id/package` | signed in candidate |
| Readiness | `GET /sessions/:id/readiness` | `session:manage` |
| Attempts | `POST /attempts/start`, `GET /attempts/:id`, `PATCH /attempts/:id/state`, `POST /attempts/:id/submit`, `POST /attempts/:id/heartbeat` | signed in candidate |
| Candidate side of calls | `GET/POST /attempts/:id/calls/:callId/signals` | signed in candidate |
| Recording | `POST /attempts/:id/recording/:stream/:sequence`, `GET /attempts/:id/recording/state`, `POST /attempts/:id/recording/complete`, `POST /attempts/:id/snapshot` | signed in candidate |
| Recording review | `GET /attempts/:id/recordings`, `GET /recording-chunks/:id` | `recording:view` |
| Marking | `GET/PUT /marking/attempts/:id` | `result:mark` |
| Results | `GET /sessions/:id/results` (JSON or CSV), `POST /sessions/:id/results/release`, `GET /me/results` | `report:view`, `result:release`, signed in candidate |
| Webhooks | `GET/PUT /integrations/webhook`, `POST /integrations/webhook/test` | `organisation:manage_users` |
| Exam rules | `POST /attempts/:id/events` | signed in candidate |
| Desktop application | request header `x-examguard-client`, device check fields `appKind` and `restrictedApps` | signed in candidate |
| Attempt overview and timeline | `GET /sessions/:id/attempts`, `GET /attempts/:id/timeline` | `report:view` |

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
| Secure exam layout with timer, question navigation and status indicators that do not rely on colour alone (s9, s23) | `candidate-app/src/screens/ExamSession.tsx` |
| One attempt per entitlement; starting again resumes it (s9) | unique index on `attempts.assignment_id`; the start route takes the entitlement lock first |
| The server owns the timer: deadline is the exam duration, capped at the session end (s9, s11) | `attempts.deadline_at`; the app only displays it, anchored to server time (`lib/clock.ts`) |
| Autosave of every answer, idempotent and safe to retry (s9, s16) | `PATCH /attempts/:id/state`; each answer has a sequence number and the highest wins |
| Answers validated against the signed manifest, never trusted from the client (s6) | `validateAnswer` in `modules/attempts.ts` |
| Automatic submission when the timer expires, even if the device never reports back (s9) | client submits at zero; the server closes overdue attempts after a grace period (`finalizeExpiredAttempts`, run every 30 seconds on each instance) |
| Submission receipt, signed and identical on every retry (s9) | `finalizeAttempt` in `attempts.ts` |
| Automatic marking of choice questions; free text left for a human (s6) | `marking.ts`; candidates see a result only once it is released |
| Autosave survives network loss and restarts, with a visible status that does not rely on colour (s9, s11, s23) | `lib/saveQueue.ts`, `lib/secureStore.ts` |
| Attempt events and audit trail: started, resumed, submitted, auto submitted (s16, s22) | `events` and `audit_logs` |
| Candidate is told the rules and consequences before the timer starts (s19) | `screens/RulesScreen.tsx`; the attempt starts only when the candidate presses start |
| Exam runs in full screen; leaving hides the exam until the candidate returns (s9) | `lib/fullscreen.ts`, `lib/rules.ts`, overlay in `ExamSession.tsx` |
| Copy, cut, paste, drag and drop, right click, print, save, view source and developer tools shortcuts blocked (s9) | `lib/rules.ts` (best effort in a browser) |
| Switching tab or program, and trying to close or reload, detected and reported (s8, s9) | `lib/rules.ts`; close attempts are sent with a request that outlives the page |
| The server counts violations and applies the exam's policy: record, warn then submit, or submit at once (s18) | `rules.ts`, `POST /attempts/:id/events`; the app cannot change the outcome, and a policy claimed by the app is ignored |
| Violations cannot be hidden by going offline; events are kept on the device and delivered later (s11) | `lib/eventReporter.ts`; events carry an id so retries never double count |
| Technical events are presented as events, with the organisation deciding the consequence (s18) | `violationPolicy` in the exam's security config; default is `flag` |
| Computers must use the desktop application; phones, tablets and Chromebooks use the browser (s9, s13) | `device.requireDesktopApp`; `client.ts` decides from the client kind and the platform the device check reported; the package and the start of an attempt are refused otherwise, so the questions never reach a browser on a computer |
| The website hands the candidate to the application (s9) | "Open in the ExamGuard app" button, `examguard://open?exam=...` link, handled by `desktop-app/src/launch.ts`; only the exam id travels, never an address or a password |
| Kiosk window: full screen, always on top, cannot be minimised or resized, no menu shortcuts, clipboard cleared, focus taken back (s9) | `desktop-app/src/lockdown.ts` |
| Closing, quitting, reloading, developer tools, zoom and new window keys are swallowed and reported; closing the window is intercepted (s9) | `desktop-app/src/shortcuts.ts`, `main.ts`; the exam's policy applies |
| Screen capture of the exam window is blocked (s9) | `setContentProtection` (see gap 18) |
| Real screen count, free disk, virtual machine hints and screen sharing or remote control programs (s10) | `desktop-app/src/system.ts`; a program from the list fails the device check and is named; another screen appearing during the exam is a counted violation |
| The page can only reach ExamGuard: no other sites, no new windows, no Node, only camera, microphone and full screen granted (s19) | `desktop-app/src/navigation.ts`, `preload.ts`, sandboxed window |
| API instances survive a database failover (s17) | pool error handler in `db.ts`; `test/resilience.test.ts` |
| Organisation portal and invigilator console (s13) | `staff-portal/`; the sections shown follow the person's permissions |
| Live console: presence, time left, rule breaks, last event, messages, warnings, extra time (at most 120 minutes), ending an attempt with a reason, notes (s8) | `modules/live.ts`, `staff-portal/src/pages/Live.tsx` |
| The candidate sees messages, warnings and extra time, and is told who ended the exam (s9) | `POST /attempts/:id/heartbeat` every 10 seconds, `candidate-app/src/lib/heartbeat.ts` |
| Invigilator failover: candidates of an invigilator who is paused, suspended or gone move to one who is connected and has room (s7, s8) | `failover.ts`, run every 30 seconds; never breaks the limit of 10 |
| Live video and voice, with the candidate always told (s8, s13, MVP 6 and 7) | `modules/calls.ts`, `candidate-app/src/lib/liveCall.ts`, `staff-portal/src/lib/liveCall.ts`; voice calls logged in `invigilation_contacts` |
| Camera, microphone and screen recording in pieces, each with a checksum, stored once, retried (s12, MVP 4) | `modules/recording.ts`, `candidate-app/src/lib/recording.ts`; `recording_chunks` unique on stream and sequence |
| Submission verified only when the evidence has arrived (s12) | `recording.ts`: `evidence_pending` until every declared piece of every expected stream is in; exams without recording are verified at once |
| Recordings survive a reload; a reopened exam carries on numbering (s11, s12) | `lib/pieceVault.ts` keeps unsent pieces encrypted on the device; `GET /attempts/:id/recording/state` |
| Offline: answers and rule events kept on the device; time away recorded and flagged past the exam's limit (s11, MVP 5) | `touch` in `modules/attempts.ts`, offline banner in `ExamSession.tsx` |
| Human marking of free text, results released per session, CSV export safe from spreadsheet formulas (s6, MVP 8) | `modules/results.ts`, `results.ts`; released results cannot be changed |
| Candidates see results only after release (s6) | `GET /me/results`, "My results" in the candidate app |
| Email delivery from the outbox: invitation, email confirmation, exam assigned, result released (s14, s20) | `mail.ts`; retried, links removed once sent |
| Candidate onboarding screens: accept an invitation, confirm an email address, register (s3, s4) | `candidate-app/src/screens/Onboarding.tsx` |
| Webhooks to the organisation's systems, signed, retried, never to private addresses (s24, MVP 8) | `webhooks.ts`, `modules/integrations.ts` |
| Desktop installers for Windows, macOS and Linux, with the exam address fixed at build time (s13) | `desktop-app/electron-builder.yml`, `.github/workflows/desktop-installers.yml`, `desktop-app/src/appConfig.ts` |
| CI with typecheck, tests, builds and dependency audit (s21) | `.github/workflows/` |

## Known gaps

These are the things a reviewer should know are missing or limited. Each is a deliberate stopping point, not an oversight.

**Security and identity**

1. **SSO and MFA.** Not built. Login is email and password only.
2. **Account lockout.** Login is rate limited per address, but repeated failures do not lock an account.
3. **Distributed rate limiting.** Counts are kept in memory. Several API servers need a Redis store.
4. **Database level tenant isolation.** Isolation is enforced in every query and tested. PostgreSQL row level security would add a second layer.
5. **Staff onboarding.** Staff and invigilators are created with a password set by an administrator. An emailed invitation, like the candidates', should replace this.
6. **The application's claim is not proven.** Whether a request comes from the desktop application, and which platform it is on, is the application's own claim. Signed builds with platform attestation, or managed devices, are needed to prove it.

**Desktop application**

7. **Installers are not signed.** macOS gets an ad hoc signature only, so it warns on first open and needs notarisation with an Apple Developer ID. Windows shows a SmartScreen warning until a code signing certificate is used. There are no automatic updates yet.
8. **Tested on Linux only.** Kiosk mode, real key delivery, camera prompts and link handling were driven in a real Electron window under a virtual display, and the packaged Linux build was run. Windows and macOS behaviour needs trying on those computers.
9. **What the application cannot stop.** Ctrl+Alt+Del and the Windows key on Windows, and the three finger gestures and Cmd+Tab on macOS, belong to the operating system; the application takes focus back and reports leaving. A second device, a photograph of the screen and hardware capture are not detectable. The strictest exams need managed devices or a person in the room.
10. **Detection is best effort.** Virtual machine and screen sharing detection uses the computer's own hints and a list of program names.
11. **Phones and tablets are not locked by ExamGuard.** They use the browser; the organisation must lock them with its own device management (for example Guided Access on iPad).

**Recording and live video**

12. **Storage is local disk.** Recordings are kept in `RECORDING_DIR` behind the `ObjectStore` interface in `storage.ts`. Several API servers need shared storage: an S3 compatible implementation of that interface, with encryption at rest.
13. **No retention or deletion schedule.** `recording_chunks.retention_state` exists, but nothing deletes recordings yet. The organisation's retention period must be applied before real use.
14. **Screen recording in the desktop application is a picture every 10 seconds**, taken of the locked exam window from inside the application. The protection against outside capture would blank a normal screen recording. In a browser the candidate shares the whole screen and it is recorded as video.
15. **Live video needs TURN on strict networks.** The default is a public STUN server, which connects most home and office networks. Networks that block direct connections need a TURN server in `ICE_SERVERS`. Calls start within one check in (up to 10 seconds) and connection messages are polled once a second; a push channel would make this faster.
16. **Live calls are not recorded.** The exam's own recording carries on during a call, but the invigilator's voice is not kept.

**Offline**

17. **The exam cannot start offline.** The package is downloaded shortly before the start, and starting needs the server. Caching an encrypted package with the key released at the start time is not built.
18. **Time away is recorded, not enforced.** Going past the exam's offline limit is flagged high for review; it does not end the exam, because the timer keeps running anyway and a network fault is rarely the candidate's doing.

**Exams and results**

19. **Marking.** Multiple response questions are all or nothing; partial credit needs an organisation policy. There is no second marker or moderation step.
20. **Question types.** File upload questions are refused.
21. **Retakes and accommodations.** One attempt per entitlement. Extra time can be given live, but standing per candidate accommodations are not built.
22. **Webhooks.** The address is checked for private networks before each send, but DNS is resolved again by the request itself, so a determined DNS rebinding attack is not fully closed. A pinned resolver would close it. The row is held locked while the request runs (up to 10 seconds), which is fine at modest volume.

## How the pieces fit

```
Candidate website or desktop app ──> API ──> PostgreSQL
        │   heartbeat every 10 s          ├── recordings on disk (or S3)
        │   recording pieces              ├── email outbox ──> SMTP
        │                                 └── webhook outbox ──> organisation's systems
        └──── WebRTC audio and video ────> Staff portal (invigilator)
                (API passes the connection messages only)
```

Background jobs run on every API server, each safe to run on several at once: closing overdue attempts (30 s), invigilator failover (30 s), email (10 s) and webhooks (10 s).

## Desktop application and device routing

The rule for an exam with `requireDesktopApp`: a laptop or desktop computer (Windows, macOS, Linux, or anything unrecognised) must use the desktop application. Phones, tablets and Chromebooks cannot run it, so they use the browser. The organisation lists the systems it accepts in `supportedOs`.

The **Open in the ExamGuard app** button uses an `examguard://open?exam=<id>` link. Only the exam id travels, never an address or a password, and the application always opens its own exam address. An installed build takes that address from the build (`EXAMGUARD_APP_URL`), ignores the `EXAMGUARD_URL` override that works when running from source, and refuses plain HTTP to anything but the local computer.
