import { type BrowserEnv } from './env';

/** Frame sampling (PRD §2.3b): jittered every 20–40 s, plus on-trigger captures. */
export const MIN_INTERVAL_MS = 20_000;
export const MAX_INTERVAL_MS = 40_000;
/** On-trigger captures (MediaPipe sees 0 or ≥ 2 faces) at most this often. */
export const TRIGGER_SPACING_MS = 5_000;

/** A random delay in [20 s, 40 s]: unpredictable, so candidates cannot time around it. */
export function nextDelay(random: () => number): number {
  return Math.round(MIN_INTERVAL_MS + random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS));
}

export type Capture = (triggered: boolean) => void;

/** Schedules captures; `observe(faces)` feeds the in-browser face pre-filter. */
export class FrameSampler {
  private timer: unknown = null;
  private lastTrigger = -Infinity;
  private running = false;

  constructor(
    private readonly env: BrowserEnv,
    private readonly capture: Capture,
  ) {}

  start(): void {
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) this.env.clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = this.env.setTimeout(
      () => {
        this.capture(false);
        this.schedule();
      },
      nextDelay(() => this.env.random()),
    );
  }

  /** MediaPipe (2 FPS, Web Worker) saw this many faces; 0 or ≥ 2 captures a frame now. */
  observe(faces: number): boolean {
    if (!this.running || faces === 1) return false;
    const now = this.env.now();
    if (now - this.lastTrigger < TRIGGER_SPACING_MS) return false;
    this.lastTrigger = now;
    this.capture(true);
    return true;
  }
}

/**
 * The face pre-filter runs MediaPipe in a Web Worker on 320×240 frames: the page posts a frame
 * and receives a face count. This adapter speaks that protocol to any worker-like object.
 */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: unknown[]): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

export class WorkerFaceDetector {
  private nextId = 1;
  private readonly waiting = new Map<number, (faces: number) => void>();

  constructor(private readonly worker: WorkerLike) {
    worker.addEventListener('message', (event) => {
      const msg = event.data as { id?: number; faces?: number };
      if (typeof msg.id !== 'number' || typeof msg.faces !== 'number') return;
      this.waiting.get(msg.id)?.(msg.faces);
      this.waiting.delete(msg.id);
    });
  }

  /** Counts faces in a downscaled frame (an ImageBitmap in the browser). */
  detect(frame: unknown): Promise<number> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.worker.postMessage({ id, frame }, [frame]);
    });
  }
}
