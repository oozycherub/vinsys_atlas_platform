/**
 * @atlas/proctor-sdk (brick 10, PRD §2.3b; the test runner UI integrates it in brick 14).
 * Signals → HMAC hash-chained envelopes → offline queue → batched upload; webcam frames sampled
 * every 20–40 s plus MediaPipe-triggered captures.
 */
export * from './client';
export * from './env';
export * from './envelope';
export * from './queue';
export * from './sampler';
export * from './signals';
