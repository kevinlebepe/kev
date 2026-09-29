import type { Config } from './config.js';
import type { Db } from './db.js';

export interface AppDeps {
  db: Db;
  config: Config;
}
