/**
 * Answers waiting to reach the server (Component Prompt 14 §7: flaky networks). Each save lands
 * in IndexedDB first, keyed by session and question, so only the latest answer per question is
 * kept; the queue is flushed in order when the network is back. Nothing is lost on a reload.
 */
export interface PendingAnswer {
  sessionId: string;
  questionId: string;
  answer: unknown;
  queuedAt: number;
}

const DB = 'atlas-runner';
const STORE = 'pending-answers';

function open(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(DB, 1);
    req.onupgradeneeded = () =>
      req.result.createObjectStore(STORE, { keyPath: ['sessionId', 'questionId'] });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('indexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'));
  });
}

export class AnswerQueue {
  private db: Promise<IDBDatabase> | null = null;

  constructor(private readonly idb: IDBFactory = indexedDB) {}

  private database(): Promise<IDBDatabase> {
    this.db ??= open(this.idb);
    return this.db;
  }

  async put(entry: PendingAnswer): Promise<void> {
    const db = await this.database();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(entry);
    await done(tx);
  }

  async pending(sessionId: string): Promise<PendingAnswer[]> {
    const db = await this.database();
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll(IDBKeyRange.bound([sessionId, ''], [sessionId, '￿']));
    await done(tx);
    return (req.result as PendingAnswer[]).sort((a, b) => a.queuedAt - b.queuedAt);
  }

  /** Removes an entry only if it was not overwritten by a newer answer meanwhile. */
  async remove(entry: PendingAnswer): Promise<void> {
    const db = await this.database();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.get([entry.sessionId, entry.questionId]);
    req.onsuccess = () => {
      const current = req.result as PendingAnswer | undefined;
      if (current && current.queuedAt === entry.queuedAt)
        store.delete([entry.sessionId, entry.questionId]);
    };
    await done(tx);
  }
}

export type SaveOutcome = 'saved' | 'offline' | 'conflict' | 'closed';

/**
 * Sends pending answers oldest first. `save` returns 'offline' on a network failure (stop and
 * keep the rest), 'conflict' when the revision moved (the caller refreshes it; retried next
 * time), or 'closed' when the session no longer accepts answers (drop).
 */
export async function flush(
  queue: AnswerQueue,
  sessionId: string,
  save: (p: PendingAnswer) => Promise<SaveOutcome>,
): Promise<{ sent: number; remaining: number }> {
  let sent = 0;
  const items = await queue.pending(sessionId);
  for (const [i, p] of items.entries()) {
    const outcome = await save(p);
    if (outcome === 'offline') return { sent, remaining: items.length - i };
    if (outcome === 'saved' || outcome === 'closed') {
      await queue.remove(p);
      if (outcome === 'saved') sent += 1;
    }
  }
  return { sent, remaining: (await queue.pending(sessionId)).length };
}
