import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { finalizeExpiredAttempts } from './attempts.js';

const config = loadConfig();
const db = createPool(config.databaseUrl);
const app = await buildApp({ db, config }, { logger: true });

// Submits attempts that ran out of time without the candidate's device
// reporting in. Every instance runs this; row locks keep it safe.
const sweeper = setInterval(() => {
  finalizeExpiredAttempts(db, config).catch((err) => app.log.error(err, 'expired attempt sweep failed'));
}, 30_000);
sweeper.unref();

// Stateless: any number of instances can run behind the load balancer.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    clearInterval(sweeper);
    await app.close();
    await db.end();
    process.exit(0);
  });
}

await app.listen({ port: config.port, host: '0.0.0.0' });
