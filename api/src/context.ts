import type { Config } from './config.js';
import type { Db } from './db.js';
import type { ObjectStore } from './storage.js';

export interface AppDeps {
  db: Db;
  config: Config;
  /** Where recordings are kept. Defaults to a folder on local disk (RECORDING_DIR). */
  store?: ObjectStore;
}
