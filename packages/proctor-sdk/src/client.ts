import { type BrowserEnv } from './env';
import { fromBase64, type ProctorEventType, sha256Hex, Signer } from './envelope';
import { type KeyValueStore, OfflineQueue, type QueuedFrame } from './queue';
import { FrameSampler } from './sampler';
import { attachSignals } from './signals';

/** What assessment-svc's `:startProctoring` returned (proctoring-svc's StartResult). */
export interface ProctorStart {
  proctor_token: string;
  session_key: string;
  key_epoch: number;
  next_seq: number;
  prev_hash: string;
}

/** Something the server wants the candidate (or the UI) to know. */
export interface Notice {
  rule: string;
  severity: number;
  action: 'flag' | 'review' | 'terminate';
}

export interface ProctorClientOptions {
  env: BrowserEnv;
  store: KeyValueStore;
  /** proctoring-svc base URL (through the API gateway). */
  baseUrl: string;
  sessionId: string;
  start: ProctorStart;
  /** Grabs a JPEG (640×480, q=0.7) from the webcam stream. */
  captureJpeg?: () => Promise<Uint8Array>;
  /** POSTs a presigned form (FormData in the browser). Resolves on a 2xx. */
  uploadForm?: (
    url: string,
    fields: Record<string, string>,
    bytes: Uint8Array,
    contentType: string,
  ) => Promise<void>;
  onNotice?: (n: Notice) => void;
  /** The session ended for proctoring reasons or proctoring was finalised: lock the UI. */
  onStopped?: (reason: string) => void;
}

/** Batching (PRD §2.3b): every 5 s, or at once for signals that can end the session. */
export const BATCH_MS = 5_000;
export const BATCH_SIZE = 200;
const URGENT = new Set<ProctorEventType>([
  'tab_hidden',
  'fullscreen_exit',
  'multi_monitor',
  'automation_suspected',
  'device_lost',
]);

interface IngestReply {
  accepted: number;
  duplicates: number;
  rejected: number;
  last_seq: number;
  key_epoch: number;
  next_key?: string;
  notices: Notice[];
}

/** The proctoring client: signals → signed events → offline queue → batched upload. */
export class ProctorClient {
  private readonly signer: Signer;
  private readonly queue: OfflineQueue;
  private readonly sampler: FrameSampler;
  private detach: (() => void) | null = null;
  private loop: unknown = null;
  private flushing: Promise<void> | null = null;
  private failures = 0;
  private retryAt = 0;
  private stopped = false;
  /** Events not yet in the queue (signing is async); flush waits for them. */
  private signing: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: ProctorClientOptions) {
    this.signer = new Signer(o.env.subtle, o.sessionId, {
      key: fromBase64(o.start.session_key),
      epoch: o.start.key_epoch,
      nextSeq: o.start.next_seq,
      prevHash: o.start.prev_hash,
    });
    this.queue = new OfflineQueue(o.store, o.sessionId);
    this.sampler = new FrameSampler(o.env, (triggered) => void this.captureFrame(triggered));
  }

  /** Starts listening, sampling and uploading. */
  async begin(): Promise<void> {
    await this.queue.restore();
    this.detach = attachSignals(
      this.o.env,
      (type, payload) => void this.record(type, payload),
      (text) => sha256Hex(this.o.env.subtle, text),
    );
    if (this.o.captureJpeg) this.sampler.start();
    this.loop = this.o.env.setInterval(() => void this.flush(), BATCH_MS);
  }

  /** Records one event (also used for face_count, voice_activity and device_lost). */
  record(type: ProctorEventType, payload: Record<string, unknown>): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const done = this.signer
      .sign(type, payload, this.o.env.now())
      .then((e) => this.queue.pushEvent(e))
      .then(() => {
        if (URGENT.has(type)) void this.flush();
      });
    this.signing = this.signing.then(() => done).catch(() => undefined);
    return done;
  }

  /** Feeds the MediaPipe pre-filter's face count (on-trigger captures). */
  observeFaces(faces: number): void {
    if (this.sampler.observe(faces)) void this.record('face_count', { mp_faces: faces });
  }

  /** Sends queued events in seq order; keeps them on failure (offline) and retries with backoff. */
  flush(): Promise<void> {
    this.flushing ??= this.flushNow().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async flushNow(): Promise<void> {
    if (this.stopped || this.o.env.now() < this.retryAt) return;
    await this.signing;
    await this.uploadFrames();
    for (;;) {
      const batch = await this.queue.events(BATCH_SIZE);
      if (batch.length === 0) return;
      let res;
      try {
        res = await this.o.env.fetch(
          `${this.o.baseUrl}/v1/proctoring/sessions/${this.o.sessionId}/events`,
          {
            method: 'POST',
            headers: {
              Authorization: `Proctor ${this.o.start.proctor_token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ sent_at: this.o.env.now(), events: batch }),
            keepalive: true,
          },
        );
      } catch {
        return this.backoff();
      }
      if (res.status === 401 || res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { code?: string };
        return this.halt(body.code ?? `HTTP_${res.status}`);
      }
      if (!res.ok) return this.backoff();
      this.failures = 0;
      const reply = (await res.json()) as IngestReply;
      // Accepted, duplicate and rejected events are all settled: none must be resent.
      await this.queue.ackEvents(batch.map((e) => e.seq));
      if (reply.next_key) this.signer.rotate(reply.key_epoch, fromBase64(reply.next_key));
      for (const n of reply.notices ?? []) {
        this.o.onNotice?.(n);
        if (n.action === 'terminate') return this.halt('TERMINATED');
      }
    }
  }

  private backoff(): void {
    this.failures += 1;
    this.retryAt = this.o.env.now() + Math.min(30_000, 1000 * 2 ** Math.min(this.failures, 5));
  }

  private halt(reason: string): void {
    this.stop();
    this.o.onStopped?.(reason);
  }

  /** Captures a frame (scheduled or triggered) into the offline queue. */
  async captureFrame(triggered: boolean): Promise<void> {
    if (!this.o.captureJpeg || this.stopped) return;
    try {
      const bytes = await this.o.captureJpeg();
      await this.queue.pushFrame({
        kind: 'frame',
        contentType: 'image/jpeg',
        bytes,
        capturedAt: this.o.env.now(),
        triggered,
      });
    } catch {
      void this.record('device_lost', { duration_ms: 0, device: 'camera' });
    }
  }

  /** Queues a reference image from the pre-check (selfie, ID document). */
  async captureReference(kind: 'selfie' | 'id_document', bytes: Uint8Array): Promise<void> {
    await this.queue.pushFrame({
      kind,
      contentType: 'image/jpeg',
      bytes,
      capturedAt: this.o.env.now(),
      triggered: false,
    });
    await this.flush();
  }

  private async uploadFrames(): Promise<void> {
    const uploadForm = this.o.uploadForm;
    if (!uploadForm) return;
    for (const [key, frame] of await this.queue.frames(10)) {
      if (!(await this.uploadOne(frame, uploadForm))) return;
      await this.queue.ackFrame(key, frame);
    }
  }

  private async uploadOne(
    frame: QueuedFrame,
    uploadForm: NonNullable<ProctorClientOptions['uploadForm']>,
  ): Promise<boolean> {
    try {
      const res = await this.o.env.fetch(
        `${this.o.baseUrl}/v1/proctoring/sessions/${this.o.sessionId}/frames:initiateUpload`,
        {
          method: 'POST',
          headers: {
            Authorization: `Proctor ${this.o.start.proctor_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            kind: frame.kind,
            content_type: frame.contentType,
            triggered: frame.triggered,
          }),
        },
      );
      if (!res.ok) return false;
      const { frame_id, upload } = (await res.json()) as {
        frame_id: string;
        upload: { url: string; fields: Record<string, string> };
      };
      await uploadForm(upload.url, upload.fields, frame.bytes, frame.contentType);
      // The signed event is what makes the upload count: cv-inference starts on it.
      await this.record('frame', { frame_id });
      return true;
    } catch {
      return false;
    }
  }

  /** Stops listening and sampling; queued data stays for the next start. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.detach?.();
    this.sampler.stop();
    if (this.loop !== null) this.o.env.clearInterval(this.loop);
  }

  get queuedFrameBytes(): number {
    return this.queue.bytes;
  }
}
