import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';

const config = loadConfig();
const db = createPool(config.databaseUrl);
const app = await buildApp({ db, config }, { logger: true });

// Stateless: any number of instances can run behind the load balancer.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    await db.end();
    process.exit(0);
  });
}

await app.listen({ port: config.port, host: '0.0.0.0' });
