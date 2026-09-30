import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { finalizeExpiredAttempts } from './attempts.js';
import { runFailover, runRotation } from './failover.js';
import { releaseScheduledResults } from './results.js';
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
  applyRetention(db, store).catch((err) => app.log.error(err, 'recording retention failed'));
}, 60 * 60_000);
retention.unref();

// Submits attempts that ran out of time without the candidate's device
// reporting in. Every instance runs this; row locks keep it safe.
const sweeper = setInterval(() => {
  finalizeExpiredAttempts(db, config).catch((err) => app.log.error(err, 'expired attempt sweep failed'));
}, 30_000);
sweeper.unref();

// Moves candidates away from invigilators who have gone, and rotates them when
// the exam asks for it (see failover.ts).
const failover = setInterval(() => {
  runFailover(db)
    .then(() => runRotation(db))
    .catch((err) => app.log.error(err, 'invigilator failover or rotation failed'));
  // Results whose exam set a release date that has now passed.
  releaseScheduledResults(db).catch((err) => app.log.error(err, 'scheduled results release failed'));
}, 30_000);
failover.unref();

// Webhooks to organisations' own systems.
const hooks = setInterval(() => {
  deliverWebhooks(db, { allowPrivate: config.allowPrivateWebhooks }).catch((err) => app.log.error(err, 'webhook delivery failed'));
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
      deliverEmails(db, config, transport).catch((err) => app.log.error(err, 'email delivery failed'));
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
    if (mailer) clearInterval(mailer);
    await app.close();
    await db.end();
    process.exit(0);
  });
}

await app.listen({ port: config.port, host: '0.0.0.0' });
