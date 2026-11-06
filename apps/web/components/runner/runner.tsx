'use client';

import { browserEnv, IndexedDbStore, ProctorClient, type ProctorStart } from '@atlas/proctor-sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/components/providers';
import { Button, ErrorNote, Field, Loading } from '@/components/ui';
import { api } from '@/lib/api';
import { AnswerQueue, flush, type PendingAnswer, type SaveOutcome } from '@/lib/offline-queue';
import {
  OfflineError,
  RunnerApi,
  type RunnerQuestionView,
  type RunnerSessionView,
} from '@/lib/runner-api';
import { type TimerSync } from '@/lib/timer';
import { CodeEditor } from './code-editor';
import { InterviewRoom } from './interview-room';
import { Precheck } from './precheck';
import { Timer } from './timer';

type Stage = 'loading' | 'redeem' | 'precheck' | 'ready' | 'running' | 'done';
interface Creds {
  session_id: string;
  session_token: string;
}

const CLOSED = new Set([
  'SESSION_EXPIRED',
  'SESSION_CLOSED',
  'SESSION_NOT_ACTIVE',
  'SESSION_TERMINATED',
  'SESSION_SUBMITTED',
]);
const credsKey = (invite: string) => `atlas.runner.${invite}`;

function syncOf(s: { remaining_seconds: number | null; server_time?: string }): TimerSync | null {
  return s.remaining_seconds === null
    ? null
    : {
        remainingSeconds: s.remaining_seconds,
        serverTime: s.server_time ?? new Date().toISOString(),
        receivedAt: Date.now(),
      };
}

/**
 * The candidate test runner (Component Prompt 14 §2, §7). Answers are written to IndexedDB first
 * and sent in order; a network drop only delays them. The deadline belongs to the server.
 */
export function Runner({ inviteToken }: { inviteToken: string }) {
  const t = useT();
  const [stage, setStage] = useState<Stage>('loading');
  const [error, setError] = useState<unknown>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [session, setSession] = useState<RunnerSessionView | null>(null);
  const [sync, setSync] = useState<TimerSync | null>(null);
  const [questions, setQuestions] = useState<RunnerQuestionView[]>([]);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [current, setCurrent] = useState(0);
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  const [submitWhenOnline, setSubmitWhenOnline] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const revs = useRef<Record<string, number>>({});
  const queue = useRef<AnswerQueue | null>(null);
  const runner = useRef<RunnerApi | null>(null);
  const proctor = useRef<ProctorClient | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Resume or redeem ---------------------------------------------------------------------
  useEffect(() => {
    queue.current = new AnswerQueue();
    const saved = sessionStorage.getItem(credsKey(inviteToken));
    if (saved) {
      const c = JSON.parse(saved) as Creds;
      runner.current = new RunnerApi(c.session_id, c.session_token);
      setStage('precheck');
    } else setStage('redeem');
    setOnline(navigator.onLine);
  }, [inviteToken]);

  const redeem = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await api.assessment.POST('/v1/invite-links/{token}:redeem', {
        params: { path: { token: inviteToken } },
        body: { full_name: name, email },
      });
      if (!r.response.ok)
        throw new Error(
          (r.error as { detail?: string; title?: string })?.detail ??
            (r.error as { title?: string })?.title ??
            'This link cannot be used.',
        );
      const c = r.data as Creds;
      sessionStorage.setItem(credsKey(inviteToken), JSON.stringify(c));
      runner.current = new RunnerApi(c.session_id, c.session_token);
      setStage('precheck');
    } catch (err) {
      setError(err);
    }
  };

  // --- Proctoring (when the assessment uses it) ---------------------------------------------
  const afterPrecheck = async (stream: MediaStream | null) => {
    const r = runner.current;
    if (!r) return;
    try {
      const out = await r.startProctoring();
      if (out.status === 200 || out.status === 201) {
        const store = await IndexedDbStore.open(indexedDB as never, IDBKeyRange as never);
        const capture = stream ? jpegGrabber(stream) : undefined;
        proctor.current = new ProctorClient({
          env: browserEnv(),
          store,
          baseUrl: window.location.origin,
          sessionId: r.sessionId,
          start: out.body as unknown as ProctorStart,
          ...(capture ? { captureJpeg: capture } : {}),
          onStopped: () => setStage('done'),
        });
        await proctor.current.begin();
      }
    } catch {
      /* not proctored, or proctoring unavailable: the server decides whether that is allowed */
    }
    setStage('ready');
  };

  // --- Running ------------------------------------------------------------------------------
  const loadQuestions = useCallback(async (s: RunnerSessionView) => {
    const r = runner.current;
    if (!r) return;
    const qs: RunnerQuestionView[] = [];
    for (let n = 1; n <= s.question_count; n++) {
      const q = await r.question(n);
      if (q.status !== 200) throw new Error('Could not load the questions.');
      qs.push(q.body);
      revs.current[q.body.question_id] = q.body.client_rev;
    }
    const local: Record<string, unknown> = Object.fromEntries(
      qs.map((q) => [q.question_id, q.response]),
    );
    // Answers typed while offline (or before a reload) win over the server's older copy.
    for (const p of await (queue.current as AnswerQueue).pending(r.sessionId))
      local[p.questionId] = p.answer;
    setQuestions(qs);
    setAnswers(local);
  }, []);

  const begin = async () => {
    const r = runner.current;
    if (!r) return;
    setError(null);
    try {
      let s = await r.session();
      if (
        s.body.status === 'invited' ||
        s.body.status === 'not_started' ||
        s.body.started_at === null
      )
        s = await r.start();
      if (s.status >= 400)
        throw new Error(
          (s.body as unknown as { detail?: string }).detail ?? 'The assessment cannot be started.',
        );
      setSession(s.body);
      setSync(syncOf(s.body));
      await loadQuestions(s.body);
      setStage('running');
    } catch (err) {
      setError(err instanceof OfflineError ? new Error(t('runner.offline')) : err);
    }
  };

  const saveOne = useCallback(
    async (p: PendingAnswer): Promise<SaveOutcome> => {
      const r = runner.current as RunnerApi;
      try {
        const rev = revs.current[p.questionId] ?? 0;
        const out = await r.save(p.questionId, rev + 1, p.answer);
        if (out.status === 200) {
          revs.current[p.questionId] = out.body.client_rev;
          setSync({
            remainingSeconds: out.body.remaining_seconds,
            serverTime: new Date().toISOString(),
            receivedAt: Date.now(),
          });
          return 'saved';
        }
        if (out.status >= 500 || out.status === 429) return 'offline';
        if (CLOSED.has(out.body.code ?? '')) return 'closed';
        // Revision moved (another tab, or a lost acknowledgement): take the server's and retry.
        const fresh = await r.question(
          questions.findIndex((q) => q.question_id === p.questionId) + 1,
        );
        if (fresh.status === 200) revs.current[p.questionId] = fresh.body.client_rev;
        return 'conflict';
      } catch {
        return 'offline';
      }
    },
    [questions],
  );

  const flushNow = useCallback(async () => {
    const r = runner.current;
    if (!r || !queue.current) return 0;
    const out = await flush(queue.current, r.sessionId, saveOne);
    setPending(out.remaining);
    return out.remaining;
  }, [saveOne]);

  const answer = (q: RunnerQuestionView, value: unknown) => {
    setAnswers((a) => ({ ...a, [q.question_id]: value }));
    void (queue.current as AnswerQueue)
      .put({
        sessionId: (runner.current as RunnerApi).sessionId,
        questionId: q.question_id,
        answer: value,
        queuedAt: Date.now(),
      })
      .then(() => setPending((n) => Math.max(n, 1)));
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void flushNow(), 600);
  };

  const submit = useCallback(async () => {
    const r = runner.current;
    if (!r) return;
    setError(null);
    const left = await flushNow();
    if (left > 0 || !navigator.onLine) {
      setSubmitWhenOnline(true);
      return;
    }
    try {
      const out = await r.submit();
      if (out.status >= 400 && !CLOSED.has((out.body as unknown as { code?: string }).code ?? ''))
        throw new Error('The assessment could not be submitted. Please try again.');
      sessionStorage.removeItem(credsKey(inviteToken));
      proctor.current?.stop();
      setStage('done');
    } catch (err) {
      if (err instanceof OfflineError) setSubmitWhenOnline(true);
      else setError(err);
    }
  }, [flushNow, inviteToken]);

  // Network status: keep working offline; flush (and submit, if asked) when back.
  useEffect(() => {
    const up = () => {
      setOnline(true);
      void flushNow().then((left) => {
        if (left === 0 && submitWhenOnline) void submit();
      });
    };
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    const retry = setInterval(() => {
      if (navigator.onLine) void flushNow();
    }, 5000);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
      clearInterval(retry);
    };
  }, [flushNow, submit, submitWhenOnline]);

  // Heartbeats keep the server's view of the session (and the clock) current.
  useEffect(() => {
    if (stage !== 'running') return;
    const id = setInterval(() => {
      void runner.current
        ?.heartbeat()
        .then((h) => {
          if (h.status === 200) setSync(syncOf(h.body));
        })
        .catch(() => undefined);
    }, 30_000);
    return () => clearInterval(id);
  }, [stage]);

  const onExpire = useCallback(() => void submit(), [submit]);

  // --- Rendering ----------------------------------------------------------------------------
  if (stage === 'loading') return <Loading />;
  if (stage === 'done')
    return (
      <p role="status" className="rounded-lg bg-green-50 p-6 text-green-900">
        {t('runner.done')}
      </p>
    );
  if (stage === 'redeem')
    return (
      <form onSubmit={redeem} className="max-w-md rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="mb-4 text-xl font-semibold">Your details</h2>
        <Field
          id="full-name"
          label="Full name"
          autoComplete="name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Field
          id="cand-email"
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        {error ? <ErrorNote error={error} /> : null}
        <Button type="submit" disabled={!name || !email}>
          Continue
        </Button>
      </form>
    );
  if (stage === 'precheck') return <Precheck onReady={(s) => void afterPrecheck(s)} />;
  if (stage === 'ready')
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-6">
        <p className="mb-4">When you start, the timer begins and cannot be paused.</p>
        {error ? <ErrorNote error={error} /> : null}
        <Button onClick={() => void begin()}>{t('runner.start')}</Button>
      </div>
    );

  const q = questions[current];
  const value = q ? answers[q.question_id] : undefined;
  const lang = q?.coding?.languages[0] ?? 'python';
  return (
    <div>
      <div className="sticky top-0 z-10 mb-4 flex flex-wrap items-center gap-4 border-b border-slate-200 bg-slate-50 py-3">
        <h2 className="text-lg font-semibold">{session?.title}</h2>
        {sync ? <Timer sync={sync} onExpire={onExpire} /> : null}
        <span
          role="status"
          aria-live="polite"
          className="ms-auto text-sm text-muted"
          data-testid="save-status"
        >
          {!online ? t('runner.offline') : pending > 0 ? t('runner.saving') : t('runner.saved')}
        </span>
      </div>
      {q ? (
        <section
          aria-labelledby="q-title"
          className="rounded-lg border border-slate-200 bg-white p-6"
        >
          <h3 id="q-title" className="mb-2 font-semibold">
            Question {current + 1} of {questions.length} · {q.marks} marks
          </h3>
          <p className="mb-4 whitespace-pre-wrap">{q.prompt}</p>
          {q.type === 'mcq' || q.type === 'true_false' ? (
            <fieldset>
              <legend className="sr-only">Choose one answer</legend>
              {(q.type === 'true_false'
                ? [
                    { id: 'true', text: 'True' },
                    { id: 'false', text: 'False' },
                  ]
                : (q.options ?? [])
              ).map((o) => {
                const checked =
                  q.type === 'true_false'
                    ? (value as { value?: boolean } | undefined)?.value === (o.id === 'true')
                    : (value as { option_id?: string } | undefined)?.option_id === o.id;
                return (
                  <div key={o.id} className="mb-2 flex items-center gap-2">
                    <input
                      type="radio"
                      id={`opt-${o.id}`}
                      name={`q-${q.question_id}`}
                      checked={checked}
                      onChange={() =>
                        answer(
                          q,
                          q.type === 'true_false'
                            ? { value: o.id === 'true' }
                            : { option_id: o.id },
                        )
                      }
                    />
                    <label htmlFor={`opt-${o.id}`}>{o.text}</label>
                  </div>
                );
              })}
            </fieldset>
          ) : null}
          {q.type === 'multiple_answer' ? (
            <fieldset>
              <legend className="sr-only">Choose all that apply</legend>
              {(q.options ?? []).map((o) => {
                const chosen = new Set(
                  (value as { option_ids?: string[] } | undefined)?.option_ids ?? [],
                );
                return (
                  <div key={o.id} className="mb-2 flex items-center gap-2">
                    <input
                      type="checkbox"
                      id={`opt-${o.id}`}
                      checked={chosen.has(o.id)}
                      onChange={(e) => {
                        if (e.target.checked) chosen.add(o.id);
                        else chosen.delete(o.id);
                        answer(q, { option_ids: [...chosen] });
                      }}
                    />
                    <label htmlFor={`opt-${o.id}`}>{o.text}</label>
                  </div>
                );
              })}
            </fieldset>
          ) : null}
          {q.type === 'fill_blank' ? (
            <Field
              id={`fb-${q.question_id}`}
              label="Your answer"
              value={(value as { text?: string } | undefined)?.text ?? ''}
              onChange={(e) => answer(q, { text: e.target.value })}
            />
          ) : null}
          {q.type === 'descriptive' ? (
            <div>
              <label htmlFor={`d-${q.question_id}`} className="mb-1 block text-sm font-medium">
                Your answer
              </label>
              <textarea
                id={`d-${q.question_id}`}
                rows={10}
                className="w-full rounded-md border border-slate-400 p-3"
                value={(value as { text?: string } | undefined)?.text ?? ''}
                onChange={(e) => answer(q, { text: e.target.value })}
              />
            </div>
          ) : null}
          {q.type === 'coding' ? (
            <div>
              <CodeEditor
                label={`Code for question ${current + 1}`}
                language={lang}
                value={
                  (value as { code?: string } | undefined)?.code ??
                  q.coding?.starter_code[lang] ??
                  ''
                }
                onChange={(code) => answer(q, { language: lang, code })}
              />
              <div className="mt-3 flex items-center gap-3">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setOutput('Running…');
                    void (runner.current as RunnerApi)
                      .run(
                        q.question_id,
                        lang,
                        (value as { code?: string } | undefined)?.code ?? '',
                        '',
                      )
                      .then((r) =>
                        setOutput(
                          r.status < 300
                            ? `${r.body.stdout ?? ''}${r.body.stderr ? `\n${r.body.stderr}` : ''}` ||
                                `(${r.body.status})`
                            : 'Could not run your code.',
                        ),
                      )
                      .catch(() => setOutput(t('runner.offline')));
                  }}
                >
                  Run
                </Button>
              </div>
              {/* Program output is untrusted: rendered as text, never as HTML. */}
              {output !== null ? (
                <pre
                  aria-label="Program output"
                  className="mt-3 max-h-48 overflow-auto rounded bg-slate-900 p-3 text-sm text-slate-100"
                >
                  {output}
                </pre>
              ) : null}
            </div>
          ) : null}
          {q.type === 'ai_interview'
            ? (() => {
                const iv = (q.response ?? {}) as {
                  interview_session_id?: string;
                  interview_token?: string;
                };
                return iv.interview_session_id && iv.interview_token ? (
                  <InterviewRoom sessionId={iv.interview_session_id} token={iv.interview_token} />
                ) : (
                  <p role="status">The interview will open here when it is ready.</p>
                );
              })()
            : null}
        </section>
      ) : null}
      <nav aria-label="Questions" className="mt-4 flex items-center gap-3">
        <Button
          variant="secondary"
          onClick={() => setCurrent((c) => Math.max(0, c - 1))}
          disabled={current === 0}
        >
          Previous
        </Button>
        <Button
          variant="secondary"
          onClick={() => setCurrent((c) => Math.min(questions.length - 1, c + 1))}
          disabled={current >= questions.length - 1}
        >
          Next
        </Button>
        <Button className="ms-auto" onClick={() => void submit()}>
          {t('runner.submit')}
        </Button>
      </nav>
      {submitWhenOnline ? (
        <p role="status" className="mt-3 rounded bg-amber-50 p-3 text-sm">
          You are offline. Your answers are safe on this device; the assessment will be submitted as
          soon as you reconnect.
        </p>
      ) : null}
      {error ? <ErrorNote error={error} /> : null}
    </div>
  );
}

/** Grabs a 640×480 JPEG (q=0.7) from the camera stream for the proctoring sampler. */
function jpegGrabber(stream: MediaStream): () => Promise<Uint8Array> {
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = stream;
  void video.play();
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  return () =>
    new Promise((resolve, reject) => {
      canvas.getContext('2d')?.drawImage(video, 0, 0, 640, 480);
      canvas.toBlob(
        (b) =>
          b
            ? void b.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)))
            : reject(new Error('no frame')),
        'image/jpeg',
        0.7,
      );
    });
}
