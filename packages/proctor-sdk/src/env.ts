/**
 * The browser surface the SDK uses, as a port: the real globals in a browser (`browserEnv()`),
 * fakes in tests. Keeping it small keeps the SDK auditable — this is all it can touch.
 */

export type Listener = (event: unknown) => void;

export interface Listenable {
  addEventListener(type: string, listener: Listener, options?: unknown): void;
  removeEventListener(type: string, listener: Listener, options?: unknown): void;
}

export interface DocumentLike extends Listenable {
  visibilityState: string;
  fullscreenElement: unknown;
}

export interface WindowLike extends Listenable {
  screen?: { isExtended?: boolean };
}

export interface ResponseLike {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}

export interface RequestInitLike {
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  keepalive?: boolean;
}

export interface SubtleLike {
  importKey(
    format: 'raw',
    keyData: Uint8Array,
    algorithm: { name: 'HMAC'; hash: 'SHA-256' },
    extractable: boolean,
    usages: string[],
  ): Promise<unknown>;
  sign(algorithm: 'HMAC', key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer>;
}

export interface BrowserEnv {
  document: DocumentLike;
  window: WindowLike;
  navigator: { webdriver?: boolean };
  /** performance.timeOrigin + performance.now(), in ms (the client clock). */
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  random(): number;
  fetch(url: string, init: RequestInitLike): Promise<ResponseLike>;
  subtle: SubtleLike;
}

/** The real browser environment. */
export function browserEnv(): BrowserEnv {
  const g = globalThis as unknown as {
    document: DocumentLike;
    window: WindowLike;
    navigator: { webdriver?: boolean };
    performance: { timeOrigin: number; now(): number };
    fetch(url: string, init: RequestInitLike): Promise<ResponseLike>;
    crypto: { subtle: SubtleLike };
  };
  return {
    document: g.document,
    window: g.window,
    navigator: g.navigator,
    now: () => g.performance.timeOrigin + g.performance.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    random: () => Math.random(),
    fetch: (url, init) => g.fetch(url, init),
    subtle: g.crypto.subtle,
  };
}
