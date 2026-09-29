# ExamGuard

Secure online assessment, examination and live invigilation platform. The full product blueprint is in [docs/ExamGuard_Developer_Handoff_Specification_v2.0.pdf](docs/ExamGuard_Developer_Handoff_Specification_v2.0.pdf).

The repository holds four applications:

* **`api/`**: the platform API. Organisations, staff roles, candidate onboarding and approval, exams and signed exam versions, sessions, invigilator allocation (never more than 10 candidates each) with automatic failover, the device check, exam attempts with a server owned timer, the exam rules, the live console with messages, extra time, live video and voice, recording upload with evidence checks, marking, results release, email delivery and webhooks.
* **`staff-portal/`**: the website for staff. Administrators and exam managers run candidates, exams, sessions, invigilators, staff and integrations. Invigilators get the live console. Markers mark free text answers and release results. Each person sees only the sections their role allows.
* **`candidate-app/`**: the website candidates use. They accept an invitation or register, run the device check, sit the exam with autosave, a countdown and the exam rules, are recorded when the exam asks for it, receive messages and calls from the invigilator, and see released results.
* **`desktop-app/`**: the ExamGuard desktop application for Windows, macOS and Linux. It shows the candidate screens in a locked window: kiosk and full screen, always on top, screen capture blocked, closing and shortcuts intercepted, other screens, virtual machines and screen sharing programs detected. Exams can require it on laptops and desktops, while phones, tablets and Chromebooks use the browser.

See [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) for how each part of the specification is covered, and for what is not done.

| Staff portal: session | Live console | Live video | Marking with the recording |
|---|---|---|---|
| ![Session](docs/screenshots/portal-session.png) | ![Live console](docs/screenshots/portal-live-console.png) | ![Live video](docs/screenshots/portal-live-video.png) | ![Marking](docs/screenshots/portal-marking.png) |

| Candidate: my exams | Device check | Exam | Receipt with the recording sent |
|---|---|---|---|
| ![My exams](docs/screenshots/candidate-my-exams.png) | ![Device check](docs/screenshots/candidate-device-check.png) | ![Exam](docs/screenshots/attempt-exam.png) | ![Receipt](docs/screenshots/recording-receipt.png) |

| The rules | Left full screen | Computer told to use the app | Desktop application |
|---|---|---|---|
| ![Rules](docs/screenshots/rules-before-start.png) | ![Left full screen](docs/screenshots/rules-left-fullscreen.png) | ![Use the app](docs/screenshots/app-required-on-computer.png) | ![Desktop app](docs/screenshots/desktop-app-exam.png) |

## Try it yourself

You need [Node.js 22 or later](https://nodejs.org), [Git](https://git-scm.com) and [Docker Desktop](https://www.docker.com/products/docker-desktop) for the database.

**First time only.** Open a terminal and run:

```bash
git clone https://github.com/kevinlebepe/kev.git
cd kev
git checkout claude/new-session-kbmcc6      # until the pull request is merged
docker compose up -d postgres
cd api && npm install && cd ..
cd candidate-app && npm install && cd ..
cd staff-portal && npm install && cd ..
```

**Every time.** Use four terminal windows.

Window 1, the API:

```bash
cd kev/api
npm run migrate:dev
SUPER_ADMIN_EMAIL=you@example.com SUPER_ADMIN_PASSWORD='a long password' npm run seed:dev
npm run dev
```

Window 2, the candidate website (http://localhost:5173):

```bash
cd kev/candidate-app
npm run dev
```

Window 3, the staff portal (http://localhost:5174):

```bash
cd kev/staff-portal
npm run dev
```

Window 4, a demo organisation with an exam that is open now:

```bash
cd kev/api
SUPER_ADMIN_EMAIL=you@example.com SUPER_ADMIN_PASSWORD='a long password' npm run demo:dev
```

The demo prints sign ins for a candidate, the owner, an invigilator and a marker, all with the password `demo-password-123`. Run it again at any time for a fresh organisation.

### A full run through

1. **Candidate** (http://localhost:5173, in one browser): sign in, run the device check and allow the camera and microphone, open the exam, start it.
2. **Invigilator** (http://localhost:5174, in a private window or another browser): sign in, open the console for Demo sitting and click the candidate. Send a message, give extra time, press **Watch live** or **Talk to the candidate**. The candidate sees each of these.
3. **Candidate**: answer and submit. The receipt says when the recording has been sent.
4. **Marker or owner** (portal): **Marking and results**, open the session, mark the essay, and as the owner release the results.
5. **Candidate**: back on My exams, the result appears under My results.

Other things to try: press Esc or switch tabs during the exam (the exam rules warn, and the fourth time end the exam); turn off Wi-Fi mid exam (answers wait on the device and send later); invite a candidate from the portal (in development the email, with its link, is printed in window 1).

Demo options, set before `npm run demo:dev`: `RECORD_SCREEN=1` also records the screen, `REQUIRE_DESKTOP_APP=1` makes the exam desktop only on computers, `ALLOW_VIRTUAL_MACHINES=1` lets it run in a virtual machine. On Windows use Git Bash, or `set NAME=value` on its own line first.

**A browser can only detect and report the exam rules, not enforce them.** Real lockdown needs the desktop application.

### The desktop application

**From source**, with the API and candidate website running:

```bash
cd kev/desktop-app
npm install
npm run dev          # the first run downloads the Electron program, about 100 MB
```

**Installers.** Every change to the desktop application builds a Windows installer, a macOS disk image and a Linux AppImage on GitHub: open the repository's **Actions** tab, the **Desktop installers** workflow, the latest run, and download from **Artifacts** (kept 14 days). The exam address is fixed into each build: set the repository variable `EXAMGUARD_APP_URL` to your deployment (for example `https://exams.example.ac.za`), or give it when starting the workflow by hand. Without it the build uses http://localhost:5173, which is what you want for testing on your own computer.

The installers are **not yet signed**. On a Mac, open the disk image, drag ExamGuard to Applications, then the first time right click it and choose **Open**. If macOS says it is damaged, run `xattr -cr /Applications/ExamGuard.app` in Terminal. Windows shows a SmartScreen warning: choose **More info** then **Run anyway**. Signing needs an Apple Developer account and a Windows code signing certificate; see `docs/IMPLEMENTATION.md`.

Once installed, the **Open in the ExamGuard app** button on the candidate website opens the application at that exam.

## Stack

| Layer | Choice |
|---|---|
| API | Node.js 22, TypeScript, Fastify 5, Zod validation on every request |
| Database | PostgreSQL 16, plain SQL migrations |
| Auth | Short lived JWT access tokens, rotating opaque refresh tokens, scrypt password hashes |
| Exam signing | Ed25519 over canonical JSON; receipts signed the same way |
| Websites | React 19, TypeScript, Vite; WebCrypto for package verification and local encryption |
| Recording | MediaRecorder in 30 second pieces, SHA-256 per piece; local disk storage behind a storage interface |
| Live video and voice | WebRTC between the two browsers; the API only passes the connection messages |
| Email | SMTP through nodemailer, from a transactional outbox |
| Desktop application | Electron with a sandboxed window and a small, checked set of messages; electron-builder installers |
| Tests | Vitest against a real PostgreSQL database; Playwright for end to end runs |

## Configuration

`api/.env.example` lists every setting. The important ones for production:

| Setting | Purpose |
|---|---|
| `JWT_SECRET`, `EXAM_SIGNING_PRIVATE_KEY`, `EXAM_SIGNING_KEY_ID` | Required; the API refuses to start without them |
| `PUBLIC_BASE_URL` | Address of the candidate website, used in email links |
| `SMTP_URL`, `MAIL_FROM` | Outgoing email |
| `RECORDING_DIR` | Where recordings are kept |
| `ICE_SERVERS` | STUN and TURN servers for live video |
| `TRUST_PROXY` | Load balancer addresses, so rate limits see real client addresses |

## Production

```bash
cd api
npm ci && npm run build              # compiles src/ to dist/
npm ci --omit=dev                    # runtime dependencies only
NODE_ENV=production npm run migrate  # then: NODE_ENV=production npm start

cd ../candidate-app && npm ci && npm run build   # static files in dist/
cd ../staff-portal && npm ci && npm run build    # static files in dist/
```

Serve both websites from any static host, with `/api` passed to the API (or set `VITE_API_BASE` when building). The candidate website must send every path to `index.html`, because invitation links open `/invitation/...`.

## Tests

```bash
cd api && npm run typecheck && npm test        # recreates the examguard_test database
cd ../candidate-app && npm run typecheck && npm test && npm run build
cd ../staff-portal && npm run typecheck && npm test && npm run build
cd ../desktop-app && npm run typecheck && npm test
```

Set `TEST_DATABASE_URL` if your database is not at `postgres://examguard:examguard@localhost:5432/examguard_test`. The database user needs permission to create databases.

## Layout

```
api/
  migrations/          SQL migrations 001 to 010
  src/
    modules/           routes: auth, organisations, candidates, exams, sessions, invigilation, live,
                       calls, candidateApp, attempts, recording, results, integrations
    allocation.ts      invigilator allocation (spec section 7)
    failover.ts        moving candidates away from invigilators who have gone
    attempts.ts        closing an attempt: receipt, marking, evidence, expiry sweep
    recording.ts       which recordings an exam needs, and when a submission is verified
    results.ts, marking.ts   automatic and human marking
    rules.ts           exam rule events and the violation policy
    mail.ts            email templates and delivery
    webhooks.ts        signed webhooks and the private address check
    storage.ts         where recordings are kept
  test/
staff-portal/src/
  pages/               overview, candidates, exams, sessions, live console, marking and results,
                       invigilators, staff, integrations, audit log
  components/, lib/    shared parts, API client, live call
candidate-app/src/
  screens/             sign in, onboarding, my exams, device check, rules, exam, receipt, results
  lib/                 API client, package verification, server clock, save queue, encrypted store,
                       exam rules, recording, live call, heartbeat
desktop-app/
  src/                 lockdown, shortcuts, system report, navigation, launch links, exam address
  electron-builder.yml installer settings
docs/                  specification, implementation notes and screenshots
```
