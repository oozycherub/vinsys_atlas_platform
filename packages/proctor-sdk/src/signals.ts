import { type BrowserEnv, type Listener } from './env';
import { type ProctorEventType } from './envelope';

export type Emit = (type: ProctorEventType, payload: Record<string, unknown>) => void;

/** Heartbeat cadence (PRD §2.3b). */
export const HEARTBEAT_MS = 10_000;

interface ClipboardEventLike {
  clipboardData?: { getData(type: string): string } | null;
  target?: { closest?(selector: string): { getAttribute(n: string): string | null } | null } | null;
}

/**
 * Browser signals (PRD §2.3b table): tab or app switches with their duration, fullscreen exits,
 * clipboard activity (a hash and a length, never the text), multiple displays, automation, and
 * a heartbeat. Returns a function that detaches every listener.
 */
export function attachSignals(
  env: BrowserEnv,
  emit: Emit,
  hash: (text: string) => Promise<string>,
): () => void {
  const off: (() => void)[] = [];
  const on = (
    target: BrowserEnv['document'] | BrowserEnv['window'],
    type: string,
    fn: Listener,
  ) => {
    target.addEventListener(type, fn);
    off.push(() => target.removeEventListener(type, fn));
  };

  // Leaving the test: the page hidden (tab switch) or the window blurred (another app). One
  // absence is reported once, when the candidate comes back, with its duration.
  let awaySince: number | null = null;
  let via = '';
  const leave = (how: string) => {
    if (awaySince === null) {
      awaySince = env.now();
      via = how;
    }
  };
  const back = () => {
    if (awaySince === null) return;
    emit('tab_hidden', { duration_ms: Math.round(env.now() - awaySince), via });
    awaySince = null;
  };
  on(env.document, 'visibilitychange', () => {
    if (env.document.visibilityState === 'hidden') leave('visibility');
    else back();
  });
  on(env.window, 'blur', () => leave('blur'));
  on(env.window, 'focus', () => {
    if (env.document.visibilityState !== 'hidden') back();
  });

  on(env.document, 'fullscreenchange', () => {
    if (!env.document.fullscreenElement) emit('fullscreen_exit', {});
  });

  const question = (e: ClipboardEventLike) =>
    e.target?.closest?.('[data-question-id]')?.getAttribute('data-question-id') ?? null;
  on(env.document, 'paste', (event) => {
    const e = event as ClipboardEventLike;
    const text = e.clipboardData?.getData('text/plain') ?? '';
    const target = question(e);
    void hash(text).then((sha256) =>
      emit('paste', { chars: text.length, sha256, ...(target ? { target_question: target } : {}) }),
    );
  });
  on(env.document, 'copy', () => emit('copy', {}));
  on(env.document, 'cut', () => emit('cut', {}));
  on(env.document, 'contextmenu', () => emit('context_menu', {}));

  let extended = false;
  const checkDisplays = () => {
    if (env.window.screen?.isExtended && !extended) {
      extended = true;
      emit('multi_monitor', {});
    }
  };
  checkDisplays();
  on(env.window, 'resize', checkDisplays);

  if (env.navigator.webdriver) emit('automation_suspected', { webdriver: true });

  const beat = env.setInterval(() => emit('heartbeat', {}), HEARTBEAT_MS);
  off.push(() => env.clearInterval(beat));

  return () => off.splice(0).forEach((f) => f());
}
