# Implementation Notes

Status as at 29 September 2026 (MVP 1, MVP 2 and MVP 3 except recording, the exam rules layer from MVP 7, and the first version of the desktop application). This file maps the handoff specification (v2.0) to the code and lists what remains.

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
| Attempts | `POST /attempts/start`, `GET /attempts/:id`, `PATCH /attempts/:id/state`, `POST /attempts/:id/submit` | signed in candidate |
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
| Automatic marking of choice questions; free text left for a human (s6) | `marking.ts`; results are stored, never shown to candidates |
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
| CI with typecheck, tests and dependency audit (s21) | `.github/workflows/api.yml`, `.github/workflows/candidate-app.yml` |

## Known gaps in this phase

1. **Email delivery.** Notifications are written to the outbox, but no worker sends them yet. The worker must clear `payload.link` after sending, because it contains a live token.
2. **SSO and MFA.** Not built. Login is email and password only.
3. **Account lockout.** Login is rate limited per IP, but repeated failures do not yet lock an account.
4. **Distributed rate limiting.** The rate limiter keeps counts in memory. With several API instances it needs a Redis store.
5. **Database level tenant isolation.** Isolation is enforced in application queries and covered by tests. PostgreSQL row level security would add a second layer.
6. **Staff onboarding.** New staff and invigilators are created with a password set by an administrator. An emailed invitation flow like the one for candidates should replace this.
7. **Invigilator failover.** Assignments are preserved when an invigilator is paused. Automatic reassignment and the `disconnected` status need live presence, which arrives with the live console in MVP 6.
8. **Desktop shell (first version built).** A web page cannot enforce the exam rules; it can only detect and report them. In a browser the candidate can exit full screen (the app hides the exam and reports it), switch tabs or programs (reported), and close the window (a prompt appears and the attempt is reported). The candidate can still use a second device, take a photo of the screen, or use a screenshot tool, and none of that is detectable. Real enforcement needs the desktop application: kiosk mode, blocked system shortcuts, a disabled clipboard, protection against screen capture of the exam window, detection of extra displays and virtual machines, and closing intercepted. Even then, on an unmanaged laptop the operating system keeps some keys, such as Ctrl+Alt+Del on Windows, so the specification's guidance to use managed devices for the strictest exams still applies. The desktop application now exists (`desktop-app/`, Electron) and locks the window as described above. What is not done: installers for Windows and macOS, code signing and notarisation (needs an Apple developer account and a Windows certificate), automatic updates, and proof that a request really comes from a genuine, unmodified application (see gap 19). It was built and tested on Linux under a virtual display; how kiosk mode behaves on real Windows and macOS screens has to be tried on those computers. The spec calls for a desktop application (Tauri or Electron) for kiosk mode. All device access already goes through `DeviceBridge`, so the desktop shell only has to supply a native implementation.
9. **Browser device checks are partial.** In a browser, virtual machine detection, kiosk mode and the screen capture permission cannot be tested. The browser reports these as passing, and the screen says so. Storage is the browser's quota, not free disk space. The native bridge must report real values.
10. **Package confidentiality before the start.** The package can be downloaded from 10 minutes before the session (`PACKAGE_PREFETCH_MINUTES`). Earlier offline caching would need the package encrypted, with the key released at the start time.
11. **Local encryption is only as strong as a browser allows.** Unsent answers are encrypted with a non extractable AES key held in IndexedDB. That stops other programs reading or editing the data in place, but not the person using the device. The desktop shell should keep the key in the operating system keystore. The package itself is not cached locally yet (MVP 5).
12. **No recording, so no evidence check yet.** A submission is stored as `received`. It becomes `verified` once the recording pipeline (MVP 4) confirms the evidence chunks. The specification says submission waits for evidence unless policy allows deferral.
13. **Offline is short term only.** A dropped connection is survived: answers are kept and retried, and the timer keeps running. The full offline engine (local timer policy, maximum offline duration, resumable uploads) is MVP 5. Until then a candidate who is offline at the deadline is submitted by the server with what it holds.
14. **Marking.** Multiple response is all or nothing. Partial credit needs an organisation policy. There is no screen yet for a human to mark free text, and results are not yet released to candidates (MVP 8).
15. **Question types.** File upload questions are refused by the API and shown as unsupported in the app.
16. **What counts as a violation.** Leaving full screen, leaving the window (another tab or program) and trying to close or reload count. Blocked clipboard and shortcut attempts are recorded but do not count, because the action was already prevented and an accidental Ctrl+C should not end someone's exam. Reloading the page counts as a close attempt. Sending a notification, an operating system pop up or a screen reader dialog that takes focus can look like leaving the window, so organisations should choose `warn_then_submit` with a sensible limit unless they accept ending exams for such events. Accessibility accommodations that need other software must be configured explicitly (specification section 23), and that is not built.
17. **Retakes and extra time.** There is one attempt per entitlement. Assigning a candidate again after a failure, and per candidate time accommodations, are not built.

## Next phases (spec section 24)

| Phase | Scope | Builds on |
|---|---|---|
| MVP 2 | Done, except the desktop shell (see gap 8) | |
| MVP 3 | Done, except that evidence is not yet checked before a submission counts as verified (gap 12) | |
| MVP 4 | Chunked recording upload to S3 compatible storage | `recording_streams`, `recording_chunks` (unique on stream and sequence) |
| MVP 5 | Offline sync and recovery | client side encrypted store, server idempotency |
| MVP 6 | Live console over WebRTC, presence, failover | `invigilation_assignments` |
| MVP 7 | Rule events and timeline are done. Still to do: voice contact and blackout reports | `invigilation_contacts`, `events` |
| MVP 8 | Results release, recording review, exports, integrations | `results`, `integration_configs` |

The admin portal and invigilator console (React and TypeScript, spec section 13) have not been started. They can be built against the endpoints above, reusing the patterns in `candidate-app/`.


## Desktop application and device routing

The rule for an exam with `requireDesktopApp`: a laptop or desktop computer (Windows, macOS, Linux, or anything unrecognised) must use the desktop application. Phones, tablets and Chromebooks cannot run it, so they use the browser. The organisation lists the systems it accepts in `supportedOs`, and must lock down phones and tablets with its own device management (for example Guided Access on iPad or a kiosk profile on Android), which ExamGuard cannot do from a web page.

18. **Screen capture protection blocks the exam window from other programs.** That includes ExamGuard's own screen recording (MVP 4): the exam window will look blank in it. The recording pipeline will have to record the screen from inside the application, or the setting has to be revisited.
19. **The application's claim is not proven.** The client kind and the platform come from the application itself. A determined person could send the same messages from a browser. Closing this gap needs signed builds and platform attestation, or managed devices.
20. **Things the desktop application cannot stop.** Ctrl+Alt+Del on Windows, the Windows key combinations, and on macOS the three finger swipes and Cmd+Tab are handled by the operating system. The application takes focus back and reports leaving. A second device, a photograph of the screen, and a hardware screen capture are not detectable. The strictest exams need managed devices or a person watching.
21. **Detection is best effort.** Virtual machine and screen sharing program detection uses the computer's own hints and a list of program names. It lowers the chance of an honest mistake or a casual attempt and can be evaded by someone who prepares.
22. **The installed application must be found.** The "Open in the ExamGuard app" link works once the packaged application is installed, because only installed builds register the `examguard://` link type. Running from source does not change the computer's settings.
23. **Tested on Linux only.** The window locking, blocked keys, closing interception, second screen and link handling were driven in a real Electron window under a virtual display, and all their logic has unit tests. Real key delivery, the macOS and Windows behaviour of kiosk mode, and camera permission prompts on macOS need to be tried on those computers.
