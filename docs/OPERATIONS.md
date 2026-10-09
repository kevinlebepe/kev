# Operations

How to run ExamGuard in production, keep it healthy, and get an exam day through safely. This covers specification sections 13, 14, 17, 19 and 21. What the code does is in [IMPLEMENTATION.md](IMPLEMENTATION.md).

## What runs where

```
DNS ──> CDN and web application firewall ──> load balancer
                                              ├── API server 1 ┐
                                              ├── API server 2 ├──> PostgreSQL (managed, with a standby)
                                              └── API server n ┘    Redis (rate limits)
                                                                    S3 compatible storage (recordings, files, logos)
                                                                    SMTP provider (email)
Candidate website and staff portal: static files on the CDN
Live video: browser to browser, through a TURN relay on strict networks
```

| Service | What to use | Notes |
|---|---|---|
| API | Two or more instances of `api/` behind a load balancer | Stateless. Every background job is safe on every instance. |
| PostgreSQL 16 | A managed service with automatic failover and point in time recovery | The API survives a failover: broken connections are replaced. |
| Redis | A managed Redis, set as `REDIS_URL` | Shares sign in rate limits between instances. If Redis fails, limits are skipped rather than blocking sign in. |
| Object storage | Amazon S3, MinIO, Cloudflare R2 or similar, set with the `S3_` settings | Turn on encryption at rest (`S3_SERVER_SIDE_ENCRYPTION`) and versioning. |
| Email | Any SMTP provider, set as `SMTP_URL` | Use a second provider in reserve for major exam periods. |
| TURN | coturn, or a hosted TURN service, set in `ICE_SERVERS` | Needed for live video on networks that block direct connections. Run it in more than one zone. |
| Websites | Any static host or CDN | Send `/api` to the API, and every other path of the candidate website to `index.html`. |

Do not run exam days on a single server. One server is one point of failure.

## Environments

Keep three: development, staging and production, each with its own database, storage bucket, secrets and signing key. Staging should match production in size before a major exam, so load tests there mean something. Never point a load test or the demo script at production; both refuse to run with `NODE_ENV=production`.

## Settings and secrets

Every setting is listed in `api/.env.example`. In production load them from a managed secret store, not from files in the repository. The API refuses to start without `JWT_SECRET`, `EXAM_SIGNING_PRIVATE_KEY` and `EXAM_SIGNING_KEY_ID`.

| Secret | If it leaks |
|---|---|
| `JWT_SECRET` | Anyone could make sign in tokens. It also derives the key that encrypts two factor secrets and single sign on client secrets, so changing it signs everyone out and those secrets must be set again. |
| `EXAM_SIGNING_PRIVATE_KEY` | Anyone could sign an exam package or a receipt. Issue a new key with a new `EXAM_SIGNING_KEY_ID`; versions already published keep their old signatures. |
| `S3_SECRET_ACCESS_KEY`, `SMTP_URL` | Rotate at the provider. |
| `METRICS_TOKEN` | Only counts are exposed, but rotate it. |

## Deploying

1. Build: `cd api && npm ci && npm run build`, and `npm run build` in `candidate-app/` and `staff-portal/`.
2. Run the migrations once, before the new API starts: `NODE_ENV=production npm run migrate`.
3. Roll the API instances one at a time. The load balancer takes an instance out when `GET /health` fails, and a stopping instance finishes its requests first.
4. Publish the two websites. Their files are named by content, so old and new can be served side by side during the change.

Avoid deploying during a session. The session list in the portal shows what is open.

### Migrations and rolling back

Migrations only add: new tables, new columns with defaults, new indexes. The code of the release before still runs against the new schema, which is what lets instances roll one at a time. There are no down migrations. To roll back, deploy the previous release; its code ignores what it does not know. If a migration itself was wrong, fix it forwards with a new migration. Restoring the database is the last resort, because it loses what candidates did since the backup.

## Backups and restore tests

* Use the managed database's point in time recovery, kept for at least 35 days, with daily snapshots copied to another region.
* Turn on versioning for the recordings bucket, with a lifecycle rule that removes old versions after the organisation's longest retention period.
* Test a restore every month, and within 72 hours before a major exam: restore the latest snapshot to a scratch database, run `npm run migrate` against it (it should say there is nothing to apply), and check that the newest submissions are there:

```sql
SELECT count(*), max(received_at) FROM submissions;
SELECT count(*) FROM audit_logs WHERE created_at > now() - interval '1 day';
```

Record the test on the session's checklist ("Database backups verified by a test restore").

## Monitoring

`GET /metrics` gives the Prometheus format. Set `METRICS_TOKEN` and have the monitoring system send it as a bearer token. Suggested alerts:

| Alert | Rule | Why |
|---|---|---|
| API errors | `rate(examguard_http_requests_total{status=~"5.."}[5m])` above 1% of all requests | Something is failing for users. |
| Slow API | 95th percentile of `examguard_http_request_duration_seconds` above 1 s for 5 minutes | Candidates feel it before it breaks. |
| Database pool | `examguard_db_connections{state="waiting"}` above 0 for 2 minutes | The database, or the pool size, is the limit. |
| Component down | `examguard_component_up < 1` | Storage, email, database or workers are failing; the health monitor also emails the platform operators. |
| Worker stalled | `examguard_job_last_run_seconds` above 3 times the job's interval, or `examguard_job_failing == 1` | Attempts may not close on time, or email may stop. |
| Email queue | `examguard_email_queue_oldest_seconds` above 900 | Invitations and reminders are late. |
| Recordings | `examguard_submissions_evidence_pending` rising an hour after a session | Devices cannot upload. |
| Many offline | `examguard_attempts_offline` above 30% of `examguard_attempts_active` | A network or service problem, not individual candidates. |
| Health check | Uptime check on `GET /health` and `GET /status` from outside | The load balancer, DNS or certificate. |

Logs are JSON lines. Every response carries `x-request-id`; a request id from the load balancer is kept when it is well formed, so one request can be followed from the edge through every log line. For full distributed tracing, run the API under the OpenTelemetry Node auto instrumentation, which picks up Fastify and `pg` without code changes.

## Capacity and load tests

`npm run loadtest:dev` in `api/` creates an organisation, signs many candidates in at once, has them sit an exam with saves every few seconds, check ins, and recording pieces if asked, then prints latency percentiles and any errors. Run it against staging with a high sign in limit on the API under test (`AUTH_RATE_LIMIT_PER_MINUTE=100000`), because every candidate signs in from one machine.

```bash
SUPER_ADMIN_EMAIL=... SUPER_ADMIN_PASSWORD=... CANDIDATES=500 MINUTES=5 RECORD=1 npm run loadtest:dev
```

A run on one development API with 100 candidates and camera recording: all 100 signed in and started within 2 seconds; saves, check ins and recording pieces stayed under 30 ms at the 99th percentile; no request failed. Signing in took about 1.2 seconds each during the burst, because password hashing is deliberately slow. For large sessions, add API instances before the start, or have candidates sign in during the start window rather than all in the same minute; single sign on moves this work to the identity provider.

Recording traffic is the largest load: about 250 KB every 30 seconds per stream per candidate. Size storage and bandwidth for the number of candidates times the streams the exam records.

## Exam day

### 24 to 72 hours before

Open the session in the portal and work through **Before the exam**. The checklist works out what it can: the roster, invigilator cover at the exam's limit per invigilator, the locked version, how many candidates have passed the device check, whether single sign on has been used recently, storage, the video relay and email. People confirm the rest, and who confirmed each item is recorded: a tested backup restore, monitoring alerts reaching the people on duty, support contacts shared with candidates, and capacity for the expected load.

Also: send reminders early for candidates who have not run the device check (the platform emails them 72 hours out), confirm the status page shows everything working, and make sure the people on duty can sign in to the portal.

### On the day

* Watch the **System health** panel on the portal overview and the session's **Reports**, **Session health** tab.
* Keep invigilator load at 10 or fewer each; the server will not allow more.
* Triage incidents as they appear on the overview (see below), and watch the recordings still arriving after the session.

## Incident mode

The overview's System health panel sorts problems by where they lie (spec section 17):

| Area | What it means | What to do |
|---|---|---|
| Individual candidates | A few candidates are offline | Their answers are kept on their devices and sent when they return. The invigilator can message them and give extra time. |
| One session or venue | Many candidates in one session are offline while others are fine | Likely the venue's network or a local provider. Contact the venue; consider extra time for the session. |
| Many candidates at once | Candidates across sessions dropped together | A network or service problem. Check the status page, the load balancer and the database. |
| Whole service | The exam service or database is down | Candidates keep working offline for as long as the exam's offline limit allows. Restore service; attempts that ran out of time close by themselves when the service returns. |
| Sign in | Many failed sign ins | Possibly an identity provider outage or an attack. Exam access codes are the controlled fallback for verified candidates. |
| Recording storage | Storage is slow or failing | Devices keep recordings and retry. Submissions wait as "evidence pending" until the recordings arrive. |
| Live video | No TURN relay, or it is down | Invigilators can still message and watch camera stills. |

After an incident, the **Time offline** and **Incidents** reports give the facts for each candidate, for fair decisions on extra time or resits. Technical events are events, not findings against candidates.

## Support

Candidates ask for help from the exam app (Help), including straight from the device check. Questions about rules, eligibility and accommodations go to the organisation's Support section. Problems with signing in, the device check or the exam app are also visible to platform support (`GET /platform/support-cases`, for platform operators). A support agent handles cases and sees the candidate behind each one, without browsing every candidate record.

## Data protection

* Recordings and answer files are deleted after the organisation's retention period (365 days unless it chooses otherwise). An attempt on hold for an appeal or investigation keeps everything until the hold is lifted.
* Staff can export everything held about a candidate; candidates can download their own copy from Help.
* The owner can erase a candidate: identity, answers, messages, recordings, files and, when used nowhere else, the sign in account. Scores and the audit trail stay, so results still add up.
* Every look at a recording is in the audit log, and saving a copy needs its own permission.
* The organisation's notice to candidates is shown before every exam, and each candidate's agreement is recorded with a fingerprint of the exact text.

This is an operational summary, not legal advice. Each organisation should have its retention periods and notice reviewed against the law that applies to it, such as POPIA in South Africa.

## Security reviews

Run the dependency audit in CI (`npm audit`), and before launch commission an independent penetration test and a review of the desktop application's lockdown on the operating systems in use. TLS is required everywhere; the desktop application refuses plain HTTP except to the local computer.
