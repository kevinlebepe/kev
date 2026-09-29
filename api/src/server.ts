import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { finalizeExpiredAttempts } from './attempts.js';
import { runFailover } from './failover.js';
import { deliverEmails, logTransport, type MailTransport, smtpTransport } from './mail.js';

const config = loadConfig();
const db = createPool(config.databaseUrl);
const app = await buildApp({ db, config }, { logger: true });

// Submits attempts that ran out of time without the candidate's device
// reporting in. Every instance runs this; row locks keep it safe.
const sweeper = setInterval(() => {
  finalizeExpiredAttempts(db, config).catch((err) => app.log.error(err, 'expired attempt sweep failed'));
}, 30_000);
sweeper.unref();

// Moves candidates away from invigilators who have gone (see failover.ts).
const failover = setInterval(() => {
  runFailover(db).catch((err) => app.log.error(err, 'invigilator failover failed'));
}, 30_000);
failover.unref();

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
    if (mailer) clearInterval(mailer);
    await app.close();
    await db.end();
    process.exit(0);
  });
}

await app.listen({ port: config.port, host: '0.0.0.0' });
