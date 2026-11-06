# @atlas/proctor-sdk (brick 10)

The browser side of proctoring (PRD §2.3b). The test runner (brick 14) loads it after the pre-check and after `POST /v1/sessions/{sid}:startProctoring`, which returns `proctor_token`, `session_key`, `key_epoch`, `next_seq` and `prev_hash`.

```ts
const client = new ProctorClient({
  env: browserEnv(),
  store: await IndexedDbStore.open(indexedDB, IDBKeyRange),
  baseUrl,
  sessionId,
  start,
  captureJpeg, // webcam → JPEG 640×480 q0.7
  uploadForm, // presigned POST via FormData
  onNotice,
  onStopped, // warnings; lock the UI on termination
});
await client.begin();
await client.captureReference('selfie', bytes);
worker.onFaces((n) => client.observeFaces(n)); // MediaPipe in a Web Worker (WorkerFaceDetector)
```

## What it does

- **Signals:**
  - leaving the test (`visibilitychange`, `blur`/`focus`), reported once with its duration;
  - fullscreen exits;
  - clipboard: `paste` sends a length and a sha256, **never the text**;
  - multiple displays (`screen.isExtended`), `navigator.webdriver`;
  - a heartbeat every 10 s.
- **Signed, chained envelopes.**
  - Each event is signed with HMAC-SHA256 over canonical JSON (keys sorted by UTF-16 code units, `JSON.stringify` primitives) and chained by `prev_hash`.
  - Signing is serialised, so `seq` and the chain stay in order.
  - Keys rotate when the server sends `next_key`.
- **Batching.** Events are sent every 5 s, or at once for signals that can end the session (window and display changes). When offline they stay queued and are retried with backoff (1 s to 30 s), in `seq` order.
- **Offline queue.** IndexedDB, or memory. **Events are never dropped**: losing one would look like suppressing it. Frames are capped at 50 MB, and the oldest are dropped first, never references.
- **Frames.**
  - Captured at jittered 20–40 s intervals, plus on-trigger captures when MediaPipe sees 0 or ≥ 2 faces (at most one every 5 s).
  - Uploaded through presigned POSTs, then announced with a signed `frame` event.
  - A failing camera is reported as `device_lost`.

The browser surface is a port (`BrowserEnv`), so the SDK is testable without a DOM and everything it can touch is listed in one place.

## Tests

`npx vitest run packages/proctor-sdk` (12 tests, 97% coverage) covers:

- the **shared envelope vectors**, reproduced byte for byte (the Go server checks the same file);
- chain order under concurrent calls, and key rotation;
- queue caps and restore;
- sampling bounds and triggers;
- every browser signal, and that pasted text never appears;
- batching, offline retry, notices, termination and finalisation stops;
- frame uploads;
- the IndexedDB adapter.

The MediaPipe worker script itself, which loads `@mediapipe/tasks-vision`, ships with the web app (brick 14). Here only its message protocol is defined and tested.
