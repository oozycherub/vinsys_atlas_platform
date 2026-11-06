import { type ProctorEnvelope } from './envelope';

/** A persistent key-value store (IndexedDB in the browser, memory in tests). */
export interface KeyValueStore {
  put(key: string, value: unknown): Promise<void>;
  /** Entries whose key starts with prefix, in key order. */
  entries(prefix: string): Promise<[string, unknown][]>;
  delete(keys: string[]): Promise<void>;
}

export class MemoryStore implements KeyValueStore {
  readonly data = new Map<string, unknown>();

  put(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }

  entries(prefix: string): Promise<[string, unknown][]> {
    return Promise.resolve(
      [...this.data.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  }

  delete(keys: string[]): Promise<void> {
    keys.forEach((k) => this.data.delete(k));
    return Promise.resolve();
  }
}

/** A captured frame waiting for upload. */
export interface QueuedFrame {
  kind: 'frame' | 'selfie' | 'id_document' | 'audio';
  contentType: string;
  bytes: Uint8Array;
  capturedAt: number;
  triggered: boolean;
}

/** PRD §2.3d: frames and events queue in IndexedDB, capped at 50 MB; oldest frames go first. */
export const QUEUE_CAP_BYTES = 50 * 1024 * 1024;

const pad = (n: number) => n.toString().padStart(12, '0');

/**
 * The offline queue. Events are never dropped (they carry the hash chain: losing one is
 * indistinguishable from suppressing it). Frames are evidence but bulky: past the cap the oldest
 * frames are dropped first, never references (selfie, ID).
 */
export class OfflineQueue {
  private frameSeq = 0;
  private frameBytes = 0;

  constructor(
    private readonly store: KeyValueStore,
    private readonly sessionId: string,
    private readonly capBytes = QUEUE_CAP_BYTES,
  ) {}

  private key(kind: 'e' | 'f', n: number): string {
    return `${this.sessionId}/${kind}/${pad(n)}`;
  }

  /** Restores counters after a reload (the queue survives in IndexedDB). */
  async restore(): Promise<void> {
    const frames = await this.store.entries(`${this.sessionId}/f/`);
    this.frameBytes = frames.reduce((n, [, f]) => n + (f as QueuedFrame).bytes.byteLength, 0);
    const last = frames.at(-1);
    this.frameSeq = last ? Number(last[0].split('/').pop()) : 0;
  }

  pushEvent(e: ProctorEnvelope): Promise<void> {
    return this.store.put(this.key('e', e.seq), e);
  }

  /** The oldest events, in seq order. */
  async events(limit: number): Promise<ProctorEnvelope[]> {
    return (await this.store.entries(`${this.sessionId}/e/`))
      .slice(0, limit)
      .map(([, v]) => v as ProctorEnvelope);
  }

  ackEvents(seqs: number[]): Promise<void> {
    return this.store.delete(seqs.map((s) => this.key('e', s)));
  }

  async pushFrame(f: QueuedFrame): Promise<{ dropped: number }> {
    this.frameSeq += 1;
    await this.store.put(this.key('f', this.frameSeq), f);
    this.frameBytes += f.bytes.byteLength;
    let dropped = 0;
    if (this.frameBytes > this.capBytes) {
      for (const [k, v] of await this.store.entries(`${this.sessionId}/f/`)) {
        if (this.frameBytes <= this.capBytes) break;
        const frame = v as QueuedFrame;
        if (frame.kind === 'selfie' || frame.kind === 'id_document') continue;
        await this.store.delete([k]);
        this.frameBytes -= frame.bytes.byteLength;
        dropped += 1;
      }
    }
    return { dropped };
  }

  async frames(limit: number): Promise<[string, QueuedFrame][]> {
    return (await this.store.entries(`${this.sessionId}/f/`))
      .slice(0, limit)
      .map(([k, v]) => [k, v as QueuedFrame]);
  }

  async ackFrame(key: string, frame: QueuedFrame): Promise<void> {
    await this.store.delete([key]);
    this.frameBytes -= frame.bytes.byteLength;
  }

  get bytes(): number {
    return this.frameBytes;
  }
}

/** Minimal IndexedDB surface used by IndexedDbStore (avoids depending on DOM types). */
interface IdbRequest<T> {
  result: T;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}
interface IdbStore {
  put(value: unknown, key: string): IdbRequest<unknown>;
  delete(key: string): IdbRequest<unknown>;
  getAll(range: unknown): IdbRequest<unknown[]>;
  getAllKeys(range: unknown): IdbRequest<string[]>;
}
interface IdbDatabase {
  transaction(
    name: string,
    mode: 'readonly' | 'readwrite',
  ): { objectStore(name: string): IdbStore };
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): unknown;
}
export interface IdbFactory {
  open(
    name: string,
    version: number,
  ): IdbRequest<IdbDatabase> & { onupgradeneeded: (() => void) | null };
}
export interface IdbKeyRangeFactory {
  bound(lower: string, upper: string): unknown;
}

const request = <T>(r: IdbRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

/** IndexedDB-backed store: one object store, keys are strings. */
export class IndexedDbStore implements KeyValueStore {
  private constructor(
    private readonly db: IdbDatabase,
    private readonly range: IdbKeyRangeFactory,
  ) {}

  static async open(
    factory: IdbFactory,
    range: IdbKeyRangeFactory,
    name = 'atlas-proctor',
  ): Promise<IndexedDbStore> {
    const req = factory.open(name, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('q')) req.result.createObjectStore('q');
    };
    return new IndexedDbStore(await request(req), range);
  }

  private store(mode: 'readonly' | 'readwrite'): IdbStore {
    return this.db.transaction('q', mode).objectStore('q');
  }

  async put(key: string, value: unknown): Promise<void> {
    await request(this.store('readwrite').put(value, key));
  }

  async entries(prefix: string): Promise<[string, unknown][]> {
    const range = this.range.bound(prefix, prefix + '￿');
    const store = this.store('readonly');
    const [keys, values] = await Promise.all([
      request(store.getAllKeys(range)),
      request(store.getAll(range)),
    ]);
    return keys.map((k, i) => [k, values[i]] as [string, unknown]);
  }

  async delete(keys: string[]): Promise<void> {
    const store = this.store('readwrite');
    await Promise.all(keys.map((k) => request(store.delete(k))));
  }
}
