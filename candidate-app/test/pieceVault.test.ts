import { describe, expect, it } from 'vitest';
import { PieceVault } from '../src/lib/pieceVault';
import { PieceUploader, type Piece } from '../src/lib/recording';
import { memoryKV, SecureStore } from '../src/lib/secureStore';

const piece = (stream: 'camera' | 'screen', sequence: number, text: string, at: number): Piece => ({
  stream,
  sequence,
  blob: new Blob([text], { type: 'video/webm' }),
  start: new Date(at),
  end: new Date(at + 1000),
});

describe('piece vault', () => {
  it('keeps pieces encrypted on the device and gives them back in order', async () => {
    const kv = memoryKV();
    const vault = new PieceVault(new SecureStore(kv), 'attempt-1');
    await Promise.all([vault.save(piece('screen', 0, 'second', 2000)), vault.save(piece('camera', 0, 'first', 1000))]);
    const back = await new PieceVault(new SecureStore(kv), 'attempt-1').loadAll();
    expect(back.map((p) => [p.stream, p.sequence])).toEqual([
      ['camera', 0],
      ['screen', 0],
    ]);
    expect(await back[0]!.blob.text()).toBe('first');
    expect(back[0]!.blob.type).toBe('video/webm');
    // Stored encrypted: the raw bytes are not in the store.
    const raw = (await kv.get('data:attempt-1:piece:camera:0')) as { data: ArrayBuffer };
    expect(new TextDecoder().decode(raw.data)).not.toContain('first');
  });

  it('forgets a piece once the uploader has sent it', async () => {
    const vault = new PieceVault(new SecureStore(memoryKV()), 'a');
    const up = new PieceUploader({ send: async () => {}, keep: (p) => vault.save(p), forget: (p) => vault.remove(p) });
    up.add(piece('camera', 0, 'x', 0));
    up.add(piece('camera', 1, 'y', 1));
    await new Promise((r) => setTimeout(r, 20));
    expect(await vault.loadAll()).toEqual([]);
  });

  it('still has the piece if sending failed', async () => {
    const vault = new PieceVault(new SecureStore(memoryKV()), 'a');
    const up = new PieceUploader({
      send: async () => {
        throw new Error('offline');
      },
      keep: (p) => vault.save(p),
      forget: (p) => vault.remove(p),
      schedule: () => () => {},
    });
    up.add(piece('camera', 3, 'kept', 0));
    await new Promise((r) => setTimeout(r, 20));
    const left = await vault.loadAll();
    expect(left.map((p) => p.sequence)).toEqual([3]);
  });
});
