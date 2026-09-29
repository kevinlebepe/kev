// Local copy of unsent answers, encrypted at rest (spec sections 9 and 11).
//
// The AES-GCM key is generated on the device and stored as a non extractable
// CryptoKey, so the stored data cannot be read or edited in place by other
// programs. A web page cannot protect it from the user themselves: real
// protection needs the desktop shell, which would keep the key in the
// operating system keystore. This store exists so a crash or restart never
// loses answers that were not yet acknowledged.

export interface KV {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export function memoryKV(): KV {
  const map = new Map<string, unknown>();
  return {
    get: async (k) => map.get(k),
    set: async (k, v) => void map.set(k, v),
    delete: async (k) => void map.delete(k),
  };
}

/** IndexedDB holds CryptoKey objects directly, which localStorage cannot. */
export function idbKV(dbName = 'examguard'): KV {
  if (typeof indexedDB === 'undefined') return memoryKV();

  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

  async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction('kv', mode).objectStore('kv'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).finally(() => db.close());
  }

  return {
    get: (k) => run('readonly', (s) => s.get(k)),
    set: async (k, v) => void (await run('readwrite', (s) => s.put(v, k))),
    delete: async (k) => void (await run('readwrite', (s) => s.delete(k))),
  };
}

interface Sealed {
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
}

export class SecureStore {
  private keyPromise: Promise<CryptoKey> | null = null;

  constructor(private readonly kv: KV) {}

  private key(): Promise<CryptoKey> {
    this.keyPromise ??= (async () => {
      const existing = (await this.kv.get('key')) as CryptoKey | undefined;
      if (existing) return existing;
      const created = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await this.kv.set('key', created);
      return created;
    })();
    return this.keyPromise;
  }

  async save(name: string, value: unknown): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.key(), new TextEncoder().encode(JSON.stringify(value)));
    await this.kv.set(`data:${name}`, { iv, data } satisfies Sealed);
  }

  /** Returns null if nothing is stored or the data was altered (AES-GCM authenticates it). */
  async load<T>(name: string): Promise<T | null> {
    const sealed = (await this.kv.get(`data:${name}`)) as Sealed | undefined;
    if (!sealed) return null;
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, await this.key(), sealed.data);
      return JSON.parse(new TextDecoder().decode(plain)) as T;
    } catch {
      return null;
    }
  }

  /** Like save, for raw bytes such as a piece of a recording. */
  async saveBytes(name: string, bytes: ArrayBuffer): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.key(), bytes);
    await this.kv.set(`data:${name}`, { iv, data } satisfies Sealed);
  }

  async loadBytes(name: string): Promise<ArrayBuffer | null> {
    const sealed = (await this.kv.get(`data:${name}`)) as Sealed | undefined;
    if (!sealed) return null;
    try {
      return await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, await this.key(), sealed.data);
    } catch {
      return null;
    }
  }

  async remove(name: string): Promise<void> {
    await this.kv.delete(`data:${name}`);
  }
}
