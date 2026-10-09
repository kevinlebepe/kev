import type { Piece, StreamKind } from './recording';
import type { SecureStore } from './secureStore';

// Keeps recording pieces on the device, encrypted, until the server has them.
// If the page is closed or reloaded mid upload, the pieces are sent the next
// time the exam opens instead of being lost.

interface Entry {
  stream: StreamKind;
  sequence: number;
  start: string;
  end: string;
  type: string;
}

const id = (e: { stream: string; sequence: number }) => `${e.stream}:${e.sequence}`;

export class PieceVault {
  // Index updates run one after another so two changes cannot overwrite each other.
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: SecureStore,
    private readonly attemptId: string,
  ) {}

  private indexName = () => `${this.attemptId}:pieces`;
  private pieceName = (e: { stream: string; sequence: number }) => `${this.attemptId}:piece:${id(e)}`;

  private update(change: (index: Entry[]) => Entry[]): Promise<void> {
    const next = this.chain.then(async () => {
      const index = (await this.store.load<Entry[]>(this.indexName())) ?? [];
      await this.store.save(this.indexName(), change(index));
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  async save(p: Piece): Promise<void> {
    await this.store.saveBytes(this.pieceName(p), await p.blob.arrayBuffer());
    const entry: Entry = { stream: p.stream, sequence: p.sequence, start: p.start.toISOString(), end: p.end.toISOString(), type: p.blob.type };
    await this.update((index) => [...index.filter((e) => id(e) !== id(entry)), entry]);
  }

  async remove(p: { stream: StreamKind; sequence: number }): Promise<void> {
    await this.update((index) => index.filter((e) => id(e) !== id(p)));
    await this.store.remove(this.pieceName(p));
  }

  /** Every piece still waiting, oldest first. Pieces that cannot be read back are dropped. */
  async loadAll(): Promise<Piece[]> {
    await this.chain;
    const index = (await this.store.load<Entry[]>(this.indexName())) ?? [];
    const pieces: Piece[] = [];
    for (const e of index) {
      const bytes = await this.store.loadBytes(this.pieceName(e));
      if (bytes) pieces.push({ stream: e.stream, sequence: e.sequence, blob: new Blob([bytes], { type: e.type }), start: new Date(e.start), end: new Date(e.end) });
    }
    return pieces.sort((a, b) => a.start.getTime() - b.start.getTime() || a.sequence - b.sequence);
  }
}
