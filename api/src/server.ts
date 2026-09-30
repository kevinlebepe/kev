import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { finalizeExpiredAttempts } from './attempts.js';
import { runFailover, runRotation } from './failover.js';
import { releaseScheduledResults } from './results.js';
import { sendReminders } from './alerts.js';
import { monitorHealth, trackJob } from './health.js';
import { deliverWebhooks } from './webhooks.js';
import { deliverEmails, logTransport, type MailTransport, smtpTransport } from './mail.js';
import { applyRetention } from './retention.js';
import { storeFromConfig } from './storage.js';

const config = loadConfig();
const db = createPool(config.databaseUrl);
const store = storeFromConfig(config);
const app = await buildApp({ db, config, store }, { logger: true });

// Deletes recordings past the organisation's retention period, and camera stills after the exam.
const retention = setInterval(() => {
  trackJob(db, 'retention', () => applyRetention(db, store)).catch((err) => app.log.error(err, 'recording retention failed'));
}, 60 * 60_000);
retention.unref();

// Submits attempts that ran out of time without the candidate's device
// reporting in. Every instance runs this; row locks keep it safe.
const sweeper = setInterval(() => {
  trackJob(db, 'expiry', () => finalizeExpiredAttempts(db, config)).catch((err) => app.log.error(err, 'expired attempt sweep failed'));
}, 30_000);
sweeper.unref();

// Moves candidates away from invigilators who have gone, and rotates them when
// the exam asks for it (see failover.ts).
const failover = setInterval(() => {
  // Also releases results whose exam set a release date that has now passed.
  trackJob(db, 'failover', async () => {
    await runFailover(db);
    await runRotation(db);
    await releaseScheduledResults(db);
  }).catch((err) => app.log.error(err, 'failover, rotation or scheduled release failed'));
}, 30_000);
failover.unref();

// Reminders before exams, and alerts for recordings still missing a day on.
const reminders = setInterval(() => {
  trackJob(db, 'reminders', () => sendReminders(db)).catch((err) => app.log.error(err, 'reminders failed'));
}, 60_000);
reminders.unref();

// Checks every part of the platform, keeps the state for the status page, and
// emails the platform operators when something breaks or recovers.
const monitor = setInterval(() => {
  trackJob(db, 'monitor', () => monitorHealth(db, config, store)).catch((err) => app.log.error(err, 'health monitor failed'));
}, 60_000);
monitor.unref();

// Webhooks to organisations' own systems.
const hooks = setInterval(() => {
  trackJob(db, 'webhooks', () => deliverWebhooks(db, { allowPrivate: config.allowPrivateWebhooks })).catch((err) => app.log.error(err, 'webhook delivery failed'));
}, 10_000);
hooks.unref();

// Email from the notifications outbox. In development, without SMTP_URL, each
// email is printed to the log so invitation links can be followed.
let transport: MailTransport | null = null;
if (config.smtpUrl) transport = smtpTransport(config.smtpUrl, config.mailFrom);
else if (process.env.NODE_ENV !== 'production') transport = logTransport((line) => app.log.info(line));
else app.log.warn('SMTP_URL is not set: no email will be sent');
const mailer = transport
  ? setInterval(() => {
      trackJob(db, 'email', () => deliverEmails(db, config, transport)).catch((err) => app.log.error(err, 'email delivery failed'));
    }, 10_000)
  : null;
mailer?.unref();

// Stateless: any number of instances can run behind the load balancer.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    clearInterval(sweeper);
    clearInterval(failover);
    clearInterval(hooks);
    clearInterval(retention);
    clearInterval(reminders);
    clearInterval(monitor);
    if (mailer) clearInterval(mailer);
    await app.close();
    await db.end();
    process.exit(0);
  });
}

await app.listen({ port: config.port, host: '0.0.0.0' });
