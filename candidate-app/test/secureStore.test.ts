import { describe, expect, it } from 'vitest';
import { memoryKV, SecureStore } from '../src/lib/secureStore';

describe('SecureStore', () => {
  it('round trips data and never stores it as readable text', async () => {
    const kv = memoryKV();
    const store = new SecureStore(kv);
    await store.save('attempt-1', { pending: [{ questionId: 'q1', response: { text: 'my secret answer' } }] });

    const raw = (await kv.get('data:attempt-1')) as { iv: Uint8Array; data: ArrayBuffer };
    expect(new TextDecoder().decode(raw.data)).not.toContain('my secret answer');
    expect(await store.load('attempt-1')).toEqual({ pending: [{ questionId: 'q1', response: { text: 'my secret answer' } }] });
  });

  it('uses a fresh iv every time and a key that cannot be exported', async () => {
    const kv = memoryKV();
    const store = new SecureStore(kv);
    await store.save('a', { n: 1 });
    const first = ((await kv.get('data:a')) as { iv: Uint8Array }).iv;
    await store.save('a', { n: 1 });
    const second = ((await kv.get('data:a')) as { iv: Uint8Array }).iv;
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);

    const key = (await kv.get('key')) as CryptoKey;
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });

  it('reads back through a new instance sharing the same storage', async () => {
    const kv = memoryKV();
    await new SecureStore(kv).save('a', { n: 7 });
    expect(await new SecureStore(kv).load('a')).toEqual({ n: 7 });
  });

  it('returns nothing for tampered data instead of trusting it', async () => {
    const kv = memoryKV();
    const store = new SecureStore(kv);
    await store.save('a', { n: 1 });
    const sealed = (await kv.get('data:a')) as { iv: Uint8Array; data: ArrayBuffer };
    const altered = new Uint8Array(sealed.data.slice(0));
    altered[0] = altered[0]! ^ 0xff;
    await kv.set('data:a', { iv: sealed.iv, data: altered.buffer });
    expect(await store.load('a')).toBeNull();
  });

  it('returns nothing when there is nothing stored, and forgets removed data', async () => {
    const store = new SecureStore(memoryKV());
    expect(await store.load('missing')).toBeNull();
    await store.save('a', { n: 1 });
    await store.remove('a');
    expect(await store.load('a')).toBeNull();
  });
});
