import { createHash, createHmac, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  attachSignals,
  type BrowserEnv,
  canonicalJson,
  FrameSampler,
  HEARTBEAT_MS,
  type IdbFactory,
  IndexedDbStore,
  type Listener,
  MAX_INTERVAL_MS,
  MemoryStore,
  MIN_INTERVAL_MS,
  nextDelay,
  OfflineQueue,
  type ProctorEnvelope,
  ProctorClient,
  type ProctorEventType,
  type RequestInitLike,
  Signer,
  type SubtleLike,
  TRIGGER_SPACING_MS,
  WorkerFaceDetector,
} from '../../src';

const subtle = webcrypto.subtle as unknown as SubtleLike;

class Target {
  readonly listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, fn: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: Listener) {
    this.listeners.get(type)?.delete(fn);
  }
  dispatch(type: string, event: unknown = {}) {
    this.listeners.get(type)?.forEach((fn) => fn(event));
  }
  count() {
    return [...this.listeners.values()].reduce((n, s) => n + s.size, 0);
  }
}

interface FakeEnv extends BrowserEnv {
  doc: Target & { visibilityState: string; fullscreenElement: unknown };
  win: Target & { screen?: { isExtended?: boolean } };
  advance(ms: number): Promise<void>;
  requests: { url: string; init: RequestInitLike }[];
  respond: (url: string, init: RequestInitLike) => Promise<{ status: number; body: unknown }>;
}

/** Web Crypto completes on the libuv thread pool: give it a few real milliseconds. */
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 2));
};

function fakeEnv(start = 1_762_336_800_000): FakeEnv {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void; every?: number }>();
  const doc = Object.assign(new Target(), {
    visibilityState: 'visible',
    fullscreenElement: {} as unknown,
  });
  const win = Object.assign(new Target(), {
    screen: { isExtended: false } as { isExtended?: boolean },
  });
  const env: FakeEnv = {
    doc,
    win,
    document: doc,
    window: win,
    navigator: {},
    now: () => now,
    setTimeout: (fn, ms) => {
      timers.set(nextId, { at: now + ms, fn });
      return nextId++;
    },
    clearTimeout: (h) => void timers.delete(h as number),
    setInterval: (fn, ms) => {
      timers.set(nextId, { at: now + ms, fn, every: ms });
      return nextId++;
    },
    clearInterval: (h) => void timers.delete(h as number),
    random: () => 0.5,
    subtle,
    requests: [],
    respond: () =>
      Promise.resolve({
        status: 200,
        body: { accepted: 0, duplicates: 0, rejected: 0, last_seq: 0, key_epoch: 1, notices: [] },
      }),
    fetch: async (url, init) => {
      env.requests.push({ url, init });
      const r = await env.respond(url, init);
      return {
        status: r.status,
        ok: r.status >= 200 && r.status < 300,
        json: () => Promise.resolve(r.body),
      };
    },
    advance: async (ms: number) => {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, t] = due;
        now = t.at;
        if (t.every) t.at += t.every;
        else timers.delete(id);
        t.fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
  return env;
}

const vectors = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', '..', 'contracts', 'fixtures', 'proctor-envelope-vectors.json'),
    'utf8',
  ),
) as {
  key_hex: string;
  session_id: string;
  vectors: { wire: string; canonical_unsigned: string; mac: string; hash: string }[];
};

describe('envelope', () => {
  it('reproduces the shared vectors byte for byte (the Go server checks the same file)', async () => {
    const key = Uint8Array.from(Buffer.from(vectors.key_hex, 'hex'));
    const signer = new Signer(subtle, vectors.session_id, {
      key,
      epoch: 1,
      nextSeq: 1,
      prevHash: '',
    });
    for (const v of vectors.vectors) {
      const wire = JSON.parse(v.wire) as ProctorEnvelope;
      const { mac, ...unsigned } = wire;
      expect(canonicalJson(unsigned)).toBe(v.canonical_unsigned);
      const signed = await signer.sign(wire.type, wire.payload, wire.client_ts);
      expect(JSON.stringify(signed)).toBe(v.wire);
      expect(signed.mac).toBe(mac);
    }
    expect(signer.epoch).toBe(1);
    expect(canonicalJson({ b: undefined, a: [1, null] })).toBe('{"a":[1,null]}');
  });

  it('keeps seq and the chain in order under concurrent calls, and rotates keys', async () => {
    const key = new Uint8Array(32).fill(1);
    const signer = new Signer(subtle, 's', { key, epoch: 1, nextSeq: 5, prevHash: 'p' });
    const all = await Promise.all([1, 2, 3].map((i) => signer.sign('heartbeat', { i }, i)));
    expect(all.map((e) => e.seq)).toEqual([5, 6, 7]);
    for (let i = 1; i < all.length; i++) {
      const hash = createHash('sha256')
        .update(canonicalJson(all[i - 1]))
        .digest('hex');
      expect(all[i]!.prev_hash).toBe(hash);
    }
    const unsigned = { ...all[0]! } as Partial<ProctorEnvelope>;
    delete unsigned.mac;
    expect(all[0]!.mac).toBe(
      createHmac('sha256', Buffer.from(key)).update(canonicalJson(unsigned)).digest('hex'),
    );
    const next = new Uint8Array(32).fill(2);
    signer.rotate(2, next);
    signer.rotate(1, key); // older epochs are ignored
    const rotated = await signer.sign('heartbeat', {}, 9);
    const { mac, ...rest } = rotated;
    expect(rotated.key_epoch).toBe(2);
    expect(mac).toBe(
      createHmac('sha256', Buffer.from(next)).update(canonicalJson(rest)).digest('hex'),
    );
  });
});

describe('offline queue', () => {
  const frame = (kind: 'frame' | 'selfie', size: number) => ({
    kind,
    contentType: 'image/jpeg',
    bytes: new Uint8Array(size),
    capturedAt: 1,
    triggered: false,
  });

  it('never drops events; drops the oldest frames first past the cap, never references', async () => {
    const store = new MemoryStore();
    const q = new OfflineQueue(store, 's1', 100);
    for (let seq = 1; seq <= 300; seq++) await q.pushEvent({ seq } as ProctorEnvelope);
    expect((await q.events(1000)).length).toBe(300);
    expect((await q.events(2)).map((e) => e.seq)).toEqual([1, 2]);
    await q.ackEvents([1, 2]);
    expect((await q.events(1))[0]!.seq).toBe(3);

    await q.pushFrame(frame('selfie', 40));
    await q.pushFrame(frame('frame', 40));
    expect((await q.pushFrame(frame('frame', 40))).dropped).toBe(1);
    const kept = await q.frames(10);
    expect(kept.map(([, f]) => f.kind)).toEqual(['selfie', 'frame']);
    expect(q.bytes).toBe(80);
    await q.ackFrame(kept[1]![0], kept[1]![1]);
    expect(q.bytes).toBe(40);
    // A reload restores the byte count and continues numbering.
    const again = new OfflineQueue(store, 's1', 100);
    await again.restore();
    expect(again.bytes).toBe(40);
    await again.pushFrame(frame('frame', 10));
    expect((await again.frames(10)).length).toBe(2);
    // Sessions do not see each other's entries.
    expect(await new OfflineQueue(store, 's2').events(10)).toEqual([]);
  });
});

describe('sampling', () => {
  it('waits 20–40 s, at random', () => {
    expect(nextDelay(() => 0)).toBe(MIN_INTERVAL_MS);
    expect(nextDelay(() => 1)).toBe(MAX_INTERVAL_MS);
    expect(nextDelay(() => 0.5)).toBe(30_000);
  });

  it('captures on schedule and on MediaPipe triggers (0 or ≥ 2 faces), spaced out', async () => {
    const env = fakeEnv();
    const captures: boolean[] = [];
    const s = new FrameSampler(env, (t) => captures.push(t));
    expect(s.observe(0)).toBe(false); // not started
    s.start();
    await env.advance(29_999);
    expect(captures).toEqual([]);
    await env.advance(1);
    expect(captures).toEqual([false]);
    expect(s.observe(1)).toBe(false);
    expect(s.observe(2)).toBe(true);
    expect(s.observe(0)).toBe(false); // within the spacing
    await env.advance(TRIGGER_SPACING_MS);
    expect(s.observe(0)).toBe(true);
    s.stop();
    await env.advance(60_000);
    expect(captures).toEqual([false, true, true]);
  });

  it('talks to the MediaPipe worker by message', async () => {
    const posted: { id: number }[] = [];
    let listener: (e: { data: unknown }) => void = () => undefined;
    const d = new WorkerFaceDetector({
      postMessage: (m) => posted.push(m as { id: number }),
      addEventListener: (_t, l) => {
        listener = l;
      },
    });
    const a = d.detect('frame-a');
    const b = d.detect('frame-b');
    listener({ data: { id: posted[1]!.id, faces: 2 } });
    listener({ data: { nonsense: true } });
    listener({ data: { id: posted[0]!.id, faces: 1 } });
    expect(await a).toBe(1);
    expect(await b).toBe(2);
  });
});

describe('browser signals', () => {
  it('reports absences, fullscreen exits, clipboard use, displays, automation and heartbeats', async () => {
    const env = fakeEnv();
    env.win.screen = { isExtended: true };
    env.navigator.webdriver = true;
    const events: [ProctorEventType, Record<string, unknown>][] = [];
    const detach = attachSignals(
      env,
      (t, p) => events.push([t, p]),
      (text) => Promise.resolve(`h(${text.length})`),
    );
    expect(events.map(([t]) => t)).toEqual(['multi_monitor', 'automation_suspected']);
    events.length = 0;

    env.doc.visibilityState = 'hidden';
    env.doc.dispatch('visibilitychange');
    env.win.dispatch('blur'); // the same absence
    await env.advance(4200);
    env.doc.visibilityState = 'visible';
    env.doc.dispatch('visibilitychange');
    env.win.dispatch('focus'); // already reported
    env.win.dispatch('blur');
    await env.advance(1000);
    env.win.dispatch('focus');
    env.doc.fullscreenElement = null;
    env.doc.dispatch('fullscreenchange');
    env.doc.dispatch('paste', {
      clipboardData: { getData: () => 'secret code' },
      target: { closest: () => ({ getAttribute: () => 'q-7' }) },
    });
    env.doc.dispatch('copy');
    env.doc.dispatch('cut');
    env.doc.dispatch('contextmenu');
    env.win.dispatch('resize'); // already reported
    await settle(); // the paste hash resolves
    await env.advance(HEARTBEAT_MS - 5200);
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual([
      ['tab_hidden', { duration_ms: 4200, via: 'visibility' }],
      ['tab_hidden', { duration_ms: 1000, via: 'blur' }],
      ['fullscreen_exit', {}],
      ['copy', {}],
      ['cut', {}],
      ['context_menu', {}],
      ['paste', { chars: 11, sha256: 'h(11)', target_question: 'q-7' }],
      ['heartbeat', {}],
    ]);
    expect(JSON.stringify(events)).not.toContain('secret');
    detach();
    expect(env.doc.count() + env.win.count()).toBe(0);
    await env.advance(HEARTBEAT_MS * 3);
    expect(events.length).toBe(8);
  });
});

describe('client', () => {
  const key = new Uint8Array(32).fill(9);
  const start = {
    proctor_token: 'apt_test',
    session_key: Buffer.from(key).toString('base64'),
    key_epoch: 1,
    next_seq: 1,
    prev_hash: '',
  };
  const ok = (extra: Record<string, unknown> = {}) => ({
    status: 200,
    body: {
      accepted: 1,
      duplicates: 0,
      rejected: 0,
      last_seq: 1,
      key_epoch: 1,
      notices: [],
      ...extra,
    },
  });
  const sent = (env: FakeEnv) =>
    env.requests
      .filter((r) => r.url.endsWith('/events'))
      .flatMap((r) => (JSON.parse(r.init.body as string) as { events: ProctorEnvelope[] }).events);

  it('signs, batches every 5 s (urgent signals at once) and verifies with the session key', async () => {
    const env = fakeEnv();
    const c = new ProctorClient({
      env,
      store: new MemoryStore(),
      baseUrl: 'https://api',
      sessionId: 's',
      start,
    });
    await c.begin();
    await c.record('voice_activity', { ms: 300 });
    expect(env.requests).toHaveLength(0);
    await env.advance(5000);
    expect(sent(env).map((e) => e.type)).toEqual(['voice_activity']);
    const req = env.requests[0]!;
    expect(req.init.headers['Authorization']).toBe('Proctor apt_test');
    const e = sent(env)[0]!;
    const { mac, ...unsigned } = e;
    expect(mac).toBe(
      createHmac('sha256', Buffer.from(key)).update(canonicalJson(unsigned)).digest('hex'),
    );
    env.doc.fullscreenElement = null;
    env.doc.dispatch('fullscreenchange');
    await env.advance(10);
    expect(sent(env).map((x) => x.type)).toEqual(['voice_activity', 'fullscreen_exit']);
    c.stop();
  });

  it('keeps events while offline and retries with backoff, in seq order', async () => {
    const env = fakeEnv();
    let online = false;
    env.respond = () => (online ? Promise.resolve(ok()) : Promise.reject(new Error('offline')));
    const c = new ProctorClient({
      env,
      store: new MemoryStore(),
      baseUrl: 'https://api',
      sessionId: 's',
      start,
    });
    await c.begin();
    for (let i = 0; i < 3; i++) await c.record('voice_activity', { i });
    await env.advance(5000);
    await env.advance(1000); // backoff 2 s: no retry yet
    const attempts = env.requests.length;
    online = true;
    await env.advance(5000);
    expect(env.requests.length).toBeGreaterThan(attempts);
    const delivered = env.requests.slice(-1)[0]!;
    const seqs = (
      JSON.parse(delivered.init.body as string) as { events: ProctorEnvelope[] }
    ).events.map((e) => e.seq);
    expect(seqs.slice(0, 3)).toEqual([1, 2, 3]);
    await env.advance(5000);
    expect(sent(env).filter((e) => e.seq === 1).length).toBe(2); // the failed attempt + the delivery, never again
    c.stop();
  });

  it('rotates keys, passes notices on and stops on termination or finalisation', async () => {
    const env = fakeEnv();
    const notices: string[] = [];
    let stopped = '';
    const next = new Uint8Array(32).fill(4);
    env.respond = () =>
      Promise.resolve(
        ok({
          next_key: Buffer.from(next).toString('base64'),
          key_epoch: 2,
          notices: [{ rule: 'paste', severity: 2, action: 'flag' }],
        }),
      );
    const c = new ProctorClient({
      env,
      store: new MemoryStore(),
      baseUrl: 'https://api',
      sessionId: 's',
      start,
      onNotice: (n) => notices.push(`${n.rule}:${n.action}`),
      onStopped: (r) => (stopped = r),
    });
    await c.begin();
    await c.record('heartbeat', {});
    await c.flush();
    await c.record('heartbeat', {});
    await c.flush();
    const [first, second] = sent(env);
    expect([first!.key_epoch, second!.key_epoch]).toEqual([1, 2]);
    expect(notices).toEqual(['paste:flag', 'paste:flag']);
    env.respond = () =>
      Promise.resolve(
        ok({ notices: [{ rule: 'window_violation', severity: 2, action: 'terminate' }] }),
      );
    await c.record('heartbeat', {});
    await c.flush();
    expect(stopped).toBe('TERMINATED');
    await c.record('heartbeat', {}); // ignored after stop
    expect(sent(env)).toHaveLength(3);

    const env2 = fakeEnv();
    env2.respond = () => Promise.resolve({ status: 409, body: { code: 'PROCTORING_FINALIZED' } });
    let reason = '';
    const c2 = new ProctorClient({
      env: env2,
      store: new MemoryStore(),
      baseUrl: 'https://api',
      sessionId: 's',
      start,
      onStopped: (r) => (reason = r),
    });
    await c2.begin();
    await c2.record('heartbeat', {});
    await c2.flush();
    expect(reason).toBe('PROCTORING_FINALIZED');
    const env3 = fakeEnv();
    env3.respond = () => Promise.resolve({ status: 500, body: {} });
    const c3 = new ProctorClient({
      env: env3,
      store: new MemoryStore(),
      baseUrl: 'https://api',
      sessionId: 's',
      start,
    });
    await c3.begin();
    await c3.record('heartbeat', {});
    await c3.flush();
    await c3.flush(); // backing off
    expect(env3.requests).toHaveLength(1);
  });

  it('uploads frames through presigned forms, then announces them with a signed event', async () => {
    const env = fakeEnv();
    const forms: string[] = [];
    let fail = false;
    env.respond = (url) =>
      Promise.resolve(
        url.endsWith('frames:initiateUpload')
          ? {
              status: fail ? 503 : 201,
              body: { frame_id: 'f-1', upload: { url: 'https://s3/up', fields: { key: 'k' } } },
            }
          : ok(),
      );
    const c = new ProctorClient({
      env,
      store: new MemoryStore(),
      baseUrl: 'https://api',
      sessionId: 's',
      start,
      captureJpeg: () => Promise.resolve(new Uint8Array([0xff, 0xd8])),
      uploadForm: (url, fields, bytes, type) => {
        forms.push(`${url}|${fields['key']}|${bytes.length}|${type}`);
        return Promise.resolve();
      },
    });
    await c.begin();
    await c.captureReference('selfie', new Uint8Array(10));
    expect(forms).toEqual(['https://s3/up|k|10|image/jpeg']);
    expect(sent(env).map((e) => [e.type, e.payload['frame_id']])).toEqual([['frame', 'f-1']]);
    fail = true; // storage unreachable when the scheduled capture happens
    await env.advance(30_000);
    expect(c.queuedFrameBytes).toBe(2);
    await env.advance(5_000);
    expect(c.queuedFrameBytes).toBe(2); // kept for later
    fail = false;
    c.observeFaces(2);
    await env.advance(5_000);
    expect(c.queuedFrameBytes).toBe(0);
    expect(sent(env).filter((e) => e.type === 'face_count')[0]!.payload).toEqual({ mp_faces: 2 });
    c.stop();
    // A camera that fails is reported as a lost device.
    const env2 = fakeEnv();
    const c2 = new ProctorClient({
      env: env2,
      store: new MemoryStore(),
      baseUrl: 'https://api',
      sessionId: 's',
      start,
      captureJpeg: () => Promise.reject(new Error('NotReadableError')),
    });
    await c2.begin();
    await c2.captureFrame(false);
    await c2.flush();
    expect(sent(env2).map((e) => e.type)).toEqual(['device_lost']);
  });
});

describe('IndexedDB store', () => {
  /** A minimal IndexedDB: requests resolve on the next tick, like the browser's. */
  function fakeIdb() {
    const data = new Map<string, unknown>();
    const stores = new Set<string>();
    const req = <T>(fn: () => T, fail = false) => {
      const r = {
        result: undefined as T,
        error: undefined as unknown,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
      };
      setImmediate(() => {
        if (fail) {
          r.error = new Error('quota');
          r.onerror?.();
          return;
        }
        r.result = fn();
        r.onsuccess?.();
      });
      return r;
    };
    const inRange = (k: string, range: { lower: string; upper: string }) =>
      k >= range.lower && k <= range.upper;
    const store = {
      put: (v: unknown, k: string) => req(() => void data.set(k, v), k === 'fail'),
      delete: (k: string) => req(() => void data.delete(k)),
      getAll: (range: { lower: string; upper: string }) =>
        req(() =>
          [...data.keys()]
            .sort()
            .filter((k) => inRange(k, range))
            .map((k) => data.get(k)),
        ),
      getAllKeys: (range: { lower: string; upper: string }) =>
        req(() => [...data.keys()].sort().filter((k) => inRange(k, range))),
    };
    const db = {
      objectStoreNames: { contains: (n: string) => stores.has(n) },
      createObjectStore: (n: string) => stores.add(n),
      transaction: () => ({ objectStore: () => store }),
    };
    const factory = {
      // Like the browser: onupgradeneeded (first open) fires before onsuccess.
      open: () => {
        const r = {
          result: db,
          error: undefined as unknown,
          onsuccess: null as (() => void) | null,
          onerror: null as (() => void) | null,
          onupgradeneeded: null as (() => void) | null,
        };
        setImmediate(() => {
          r.onupgradeneeded?.();
          r.onsuccess?.();
        });
        return r;
      },
    };
    return {
      factory,
      range: { bound: (lower: string, upper: string) => ({ lower, upper }) },
      stores,
    };
  }

  it('stores, lists by prefix in key order, and deletes', async () => {
    const { factory, range, stores } = fakeIdb();
    const s = await IndexedDbStore.open(factory as unknown as IdbFactory, range);
    expect(stores.has('q')).toBe(true);
    await s.put('a/2', 2);
    await s.put('a/1', 1);
    await s.put('b/1', 3);
    expect(await s.entries('a/')).toEqual([
      ['a/1', 1],
      ['a/2', 2],
    ]);
    await s.delete(['a/1']);
    expect(await s.entries('a/')).toEqual([['a/2', 2]]);
    await expect(s.put('fail', 0)).rejects.toThrow('quota');
    // The queue works on top of it.
    const q = new OfflineQueue(s, 'sess');
    await q.pushEvent({ seq: 1 } as ProctorEnvelope);
    expect((await q.events(5)).map((e) => e.seq)).toEqual([1]);
  });
});
