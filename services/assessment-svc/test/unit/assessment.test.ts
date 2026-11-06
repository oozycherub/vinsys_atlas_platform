import { describe, expect, it } from 'vitest';
import { translate } from '../../src/application/access';
import { ServiceRejectedError, UpstreamError } from '../../src/application/ports';
import { HttpSandboxGateway } from '../../src/infrastructure/sandbox-gateway';
import {
  definitionSchema,
  parseAnswer,
  parsePayload,
  reportConfigSchema,
  settingsSchema,
} from '../../src/application/schemas';
import { loadAssessmentSvcConfig } from '../../src/config';
import {
  AssessmentRuleError,
  buildPlan,
  performanceBand,
  pinDefinition,
  planItems,
} from '../../src/domain/assessment';
import { autoScore, candidateView, type Question, QuestionError } from '../../src/domain/questions';
import {
  assertTransition,
  canTransition,
  consensus,
  effectiveDeadline,
  evaluate,
  isExpired,
  remainingSeconds,
  resume,
  type StoredResponse,
} from '../../src/domain/session';
import {
  HttpProfileDirectory,
  MemoryProfileDirectory,
} from '../../src/infrastructure/profile-directory';

const q = (over: Partial<Question>): Question => ({
  tenantId: 't',
  id: over.id ?? crypto.randomUUID(),
  version: 1,
  bankId: null,
  type: 'mcq',
  prompt: 'P',
  payload: {},
  marks: 2,
  negativeMarks: 0,
  difficulty: 'medium',
  skillIds: [],
  status: 'active',
  createdBy: 'u',
  createdAt: new Date(),
  ...over,
});

const mcq = q({
  type: 'mcq',
  payload: {
    options: [
      { id: 'a', text: 'A', correct: false },
      { id: 'b', text: 'B', correct: true },
    ],
  },
  negativeMarks: 0.5,
});

describe('auto-scoring', () => {
  it('MCQ and true/false with negative marking; blank answers never go negative', () => {
    expect(autoScore(mcq, 2, { option_id: 'b' })).toEqual({ score: 2, correct: true, needs: null });
    expect(autoScore(mcq, 2, { option_id: 'a' })).toEqual({
      score: -0.5,
      correct: false,
      needs: null,
    });
    expect(autoScore(mcq, 2, null)).toEqual({ score: 0, correct: false, needs: null });
    const tf = q({ type: 'true_false', payload: { correct: false } });
    expect(autoScore(tf, 1, { value: false }).score).toBe(1);
    expect(autoScore(tf, 1, { value: true }).score).toBe(-0);
  });

  it('multiple answer: exact, partial credit and no-partial', () => {
    const options = [
      { id: 'a', text: 'A', correct: true },
      { id: 'b', text: 'B', correct: true },
      { id: 'c', text: 'C', correct: false },
    ];
    const partial = q({ type: 'multiple_answer', payload: { options, partial_credit: true } });
    expect(autoScore(partial, 4, { option_ids: ['a', 'b'] })).toEqual({
      score: 4,
      correct: true,
      needs: null,
    });
    expect(autoScore(partial, 4, { option_ids: ['a'] }).score).toBe(2);
    expect(autoScore(partial, 4, { option_ids: ['a', 'c'] }).score).toBe(0);
    expect(autoScore(partial, 4, { option_ids: ['c'] }).score).toBe(0); // never below zero
    expect(autoScore(partial, 4, { option_ids: [] }).score).toBe(0);
    const strict = q({
      type: 'multiple_answer',
      payload: { options, partial_credit: false },
      negativeMarks: 1,
    });
    expect(autoScore(strict, 4, { option_ids: ['a'] }).score).toBe(-1);
  });

  it('fill in the blank: normalised, optionally case-sensitive', () => {
    const fb = q({
      type: 'fill_blank',
      payload: { accepted: ['New  York'], case_sensitive: false },
    });
    expect(autoScore(fb, 1, { text: ' new york ' }).correct).toBe(true);
    expect(autoScore(fb, 1, { text: '' }).score).toBe(0);
    const cs = q({ type: 'fill_blank', payload: { accepted: ['NaN'], case_sensitive: true } });
    expect(autoScore(cs, 1, { text: 'nan' }).correct).toBe(false);
  });

  it('descriptive answers go to review and coding answers to the judge', () => {
    expect(
      autoScore(q({ type: 'descriptive', payload: { rubric: '' } }), 5, { text: 'x' }),
    ).toEqual({ score: null, correct: null, needs: 'review' });
    expect(
      autoScore(q({ type: 'descriptive', payload: { rubric: '' } }), 5, null).needs,
    ).toBeNull();
    expect(
      autoScore(q({ type: 'coding', payload: {} }), 5, { language: 'py', code: 'x' }).needs,
    ).toBe('judge');
    expect(autoScore(q({ type: 'coding', payload: {} }), 5, null).score).toBe(0);
  });
});

describe('candidate view never carries the answer key', () => {
  it('builds every type from an allow-list', () => {
    const hidden = [
      'correct',
      'accepted',
      'tests',
      'rubric',
      'expected',
      'case_sensitive',
      'partial_credit',
    ];
    const types: Question[] = [
      mcq,
      q({
        type: 'multiple_answer',
        payload: { options: [{ id: 'a', text: 'A', correct: true }], partial_credit: true },
      }),
      q({ type: 'true_false', payload: { correct: true } }),
      q({ type: 'fill_blank', payload: { accepted: ['secret'], case_sensitive: true } }),
      q({ type: 'descriptive', payload: { rubric: 'secret rubric' } }),
      q({
        type: 'coding',
        payload: {
          languages: ['go'],
          starter_code: {},
          tests: [{ input: '1', expected: 'secret', hidden: true }],
        },
      }),
    ];
    for (const question of types) {
      const text = JSON.stringify(candidateView(question, 1, 1, 2, null));
      for (const key of hidden) expect(text, `${question.type}: ${key}`).not.toContain(`"${key}"`);
      expect(text).not.toContain('secret');
    }
  });
});

describe('schemas', () => {
  it('validates payloads and answers per type', () => {
    expect(() =>
      parsePayload('mcq', {
        options: [
          { id: 'a', text: 'A', correct: true },
          { id: 'b', text: 'B', correct: true },
        ],
      }),
    ).toThrow(QuestionError);
    expect(() => parsePayload('true_false', { correct: 'yes' })).toThrow(/correct/);
    expect(parsePayload('fill_blank', { accepted: ['x'] })).toEqual({
      accepted: ['x'],
      case_sensitive: false,
    });
    expect(() => parseAnswer('mcq', { option_ids: ['a'] })).toThrow(QuestionError);
    expect(parseAnswer('mcq', null)).toBeNull();
    expect(definitionSchema.safeParse({ sections: [{ title: 'x' }] }).success).toBe(false); // empty section
    expect(
      definitionSchema.safeParse({
        sections: Array.from({ length: 21 }, () => ({
          title: 's',
          questions: [{ question_id: crypto.randomUUID() }],
        })),
      }).success,
    ).toBe(false);
    const sixBanks = Array.from({ length: 6 }, () => ({ bank_id: crypto.randomUUID(), count: 1 }));
    expect(
      definitionSchema.safeParse({ sections: [{ title: 's', banks: sixBanks }] }).success,
    ).toBe(false);
    expect(settingsSchema.parse({})).toEqual({
      max_attempts: 1,
      retake_cooldown_days: 0,
      pause_allowance_seconds: 300,
      shuffle_questions: false,
      proctoring: { enabled: false, id_verification: false, rules: null },
    });
    expect(reportConfigSchema.safeParse({ bands: [{ name: 'A', min_percent: 50 }] }).success).toBe(
      false,
    ); // needs a 0 % band
  });
});

describe('plans and publishing', () => {
  const bank = Array.from({ length: 5 }, (_, i) =>
    q({
      id: `00000000-0000-4000-8000-00000000000${i}`,
      bankId: 'b',
      type: 'true_false',
      difficulty: i < 2 ? 'easy' : 'hard',
    }),
  );
  const fixed = q({ id: '10000000-0000-4000-8000-000000000000', marks: 3 });
  const definition = {
    sections: [
      {
        title: 'A',
        questions: [{ question_id: fixed.id, version: 1, marks: 4 }],
        banks: [{ bank_id: 'b', count: 2, difficulty: 'hard' as const }],
      },
      { title: 'B', questions: [], banks: [{ bank_id: 'b', count: 2 }] },
    ],
  };
  const settings = {
    max_attempts: 1,
    retake_cooldown_days: 0,
    pause_allowance_seconds: 0,
    shuffle_questions: false,
  };
  const questions = new Map([[`${fixed.id}@1`, fixed]]);
  const banks = new Map([['b', bank]]);

  it('draws distinct bank questions, deterministically per session', () => {
    const plan = buildPlan({ definition, settings }, 'session-1', questions, banks);
    const ids = planItems(plan).map((p) => p.item.question_id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    expect(plan.sections[0]!.items[0]).toEqual({ question_id: fixed.id, version: 1, marks: 4 });
    expect(
      plan.sections[0]!.items.slice(1).every(
        (i) => bank.find((b) => b.id === i.question_id)?.difficulty === 'hard',
      ),
    ).toBe(true);
    expect(buildPlan({ definition, settings }, 'session-1', questions, banks)).toEqual(plan);
    const shuffled = buildPlan(
      { definition, settings: { ...settings, shuffle_questions: true } },
      'session-1',
      questions,
      banks,
    );
    // Shuffling consumes the generator differently, so the draws may differ; the shape may not.
    const shuffledIds = planItems(shuffled).map((p) => p.item.question_id);
    expect(new Set(shuffledIds).size).toBe(5);
    expect(shuffled.sections.map((s) => s.items.length)).toEqual([3, 2]);
    expect(shuffledIds).toContain(fixed.id);
    expect(() => buildPlan({ definition, settings }, 's', new Map(), banks)).toThrow(
      AssessmentRuleError,
    );
  });

  it('pins versions and checks bank sizes at publish', () => {
    const pinned = pinDefinition(
      { sections: [{ title: 'A', questions: [{ question_id: fixed.id }], banks: [] }] },
      new Map([[fixed.id, { ...fixed, version: 7 }]]),
      banks,
    );
    expect(pinned.sections[0]!.questions[0]).toEqual({ question_id: fixed.id, version: 7 });
    expect(() =>
      pinDefinition(
        {
          sections: [
            { title: 'A', questions: [], banks: [{ bank_id: 'b', count: 3, difficulty: 'easy' }] },
          ],
        },
        new Map(),
        banks,
      ),
    ).toThrow(/BANK|bank/);
    expect(() =>
      pinDefinition(
        { sections: [{ title: 'A', questions: [{ question_id: 'nope' }], banks: [] }] },
        new Map(),
        banks,
      ),
    ).toThrow(/does not exist/);
  });

  it('bands by the highest threshold reached', () => {
    const config = {
      bands: [
        { name: 'Low', min_percent: 0 },
        { name: 'High', min_percent: 70 },
      ],
      skill_validity_months: 12,
    };
    expect(performanceBand(70, config)).toBe('High');
    expect(performanceBand(69.99, config)).toBe('Low');
  });
});

describe('sessions', () => {
  const T0 = new Date('2026-01-01T00:00:00Z');
  const at = (s: number) => new Date(T0.getTime() + s * 1000);

  it('allows only the defined transitions', () => {
    expect(canTransition('invited', 'started')).toBe(true);
    expect(canTransition('paused', 'in_progress')).toBe(true);
    expect(canTransition('submitted', 'in_progress')).toBe(false);
    expect(canTransition('evaluated', 'submitted')).toBe(false);
    expect(() => assertTransition('expired', 'submitted')).toThrow(/cannot become/);
  });

  it('freezes the clock while paused, but only for the allowance', () => {
    const live = {
      status: 'in_progress' as const,
      deadlineAt: at(600),
      pausedAt: null,
      pausedSeconds: 0,
    };
    expect(remainingSeconds(live, at(100))).toBe(500);
    expect(isExpired(live, at(600), 300)).toBe(true);
    const paused = {
      status: 'paused' as const,
      deadlineAt: at(600),
      pausedAt: at(100),
      pausedSeconds: 200,
    };
    expect(remainingSeconds(paused, at(500))).toBe(500);
    expect(effectiveDeadline(paused, 300)).toEqual(at(700)); // 100 s of allowance left
    expect(isExpired(paused, at(699), 300)).toBe(false);
    expect(isExpired(paused, at(700), 300)).toBe(true);
    expect(resume(paused, at(150), 300)).toEqual({ deadlineAt: at(650), credited: 50 });
    expect(resume(paused, at(400), 300)).toEqual({ deadlineAt: at(700), credited: 100 });
    expect(() => resume(live, at(1), 300)).toThrow(/not paused/);
    expect(effectiveDeadline({ ...live, deadlineAt: null }, 1)).toBeNull();
  });

  it('evaluates totals, holds for review and the judge, and scores skills on 0–5', () => {
    const a = q({
      ...mcq,
      id: 'aaaaaaaa-0000-4000-8000-000000000000',
      skillIds: ['s1'],
      negativeMarks: 1,
    });
    const essay = q({
      id: 'bbbbbbbb-0000-4000-8000-000000000000',
      type: 'descriptive',
      payload: { rubric: '' },
      skillIds: ['s1', 's2'],
    });
    const code = q({
      id: 'cccccccc-0000-4000-8000-000000000000',
      type: 'coding',
      payload: {},
      skillIds: ['s2'],
    });
    const plan = {
      sections: [
        {
          title: 'S',
          items: [a, essay, code].map((x) => ({ question_id: x.id, version: 1, marks: 2 })),
        },
      ],
    };
    const questions = new Map([a, essay, code].map((x) => [`${x.id}@1`, { ...x, id: x.id }]));
    const r = (id: string, over: Partial<StoredResponse>): [string, StoredResponse] => [
      id,
      { questionId: id, answer: null, autoScore: null, manualScore: null, state: 'saved', ...over },
    ];
    const pending = evaluate(
      plan,
      questions,
      new Map([
        r(a.id, { answer: { option_id: 'a' } }),
        r(essay.id, { answer: { text: 'x' } }),
        r(code.id, { answer: { language: 'go', code: 'x' } }),
      ]),
    );
    expect(pending).toMatchObject({ pending: true, needsReview: true });
    expect(pending.questions.map((x) => x.pending)).toEqual([null, 'review', 'judge']);

    const done = evaluate(
      plan,
      questions,
      new Map([
        r(a.id, { answer: { option_id: 'a' } }), // −1
        r(essay.id, { answer: { text: 'x' }, manualScore: 1.5 }),
        r(code.id, { answer: { language: 'go', code: 'x' }, autoScore: 2 }),
      ]),
    );
    expect(done).toMatchObject({ pending: false, raw: 2.5, max: 6, percent: 41.67 });
    expect(done.skills).toEqual([
      { skill_id: 's1', score: 1.88, confidence: 0.6, items: 2 }, // (0 + 1.5) / 4 · 5
      { skill_id: 's2', score: 4.38, confidence: 0.6, items: 2 }, // (1.5 + 2) / 4 · 5
    ]);
    expect(consensus([6, 9])).toBe(7.5);
    expect(consensus([])).toBeNull();
  });
});

describe('profile directory', () => {
  it('finds by email, else creates with an idempotency key', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let existing: string | null = null;
    const f = (async (url: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      if ((init.method ?? 'GET') === 'GET') {
        return new Response(
          JSON.stringify({ items: existing ? [{ candidate_id: existing }] : [] }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ candidate_id: 'new-id' }), { status: 201 });
    }) as typeof fetch;
    const dir = new HttpProfileDirectory({
      baseUrl: 'http://profile/',
      token: async () => 't',
      fetch: f,
    });
    expect(
      await dir.findOrCreate('ten', { fullName: 'A B', email: ' A@B.example ' }, 'key-1'),
    ).toBe('new-id');
    expect(calls[0]!.url).toBe('http://profile/v1/candidates?tenant_id=ten&email=a%40b.example');
    expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({
      source: 'external_applicant',
      pii: { email: 'a@b.example' },
    });
    expect((calls[1]!.init.headers as Record<string, string>)['Idempotency-Key']).toBe('key-1');
    existing = 'old-id';
    expect(await dir.findOrCreate('ten', { fullName: 'A B', email: 'a@b.example' }, 'key-2')).toBe(
      'old-id',
    );

    const down = new HttpProfileDirectory({
      baseUrl: 'http://p',
      token: async () => 't',
      fetch: (async () => new Response('', { status: 503 })) as typeof fetch,
    });
    await expect(
      down.findOrCreate('t', { fullName: 'x', email: 'x@y.z' }, 'k'),
    ).rejects.toBeInstanceOf(UpstreamError);
    const memory = new MemoryProfileDirectory();
    expect(await memory.findOrCreate('t', { fullName: 'x', email: 'X@y.z' })).toBe(
      await memory.findOrCreate('t', { fullName: 'y', email: 'x@y.z' }),
    );
  });
});

describe('config', () => {
  const env = {
    ATLAS_DATABASE_URL: 'postgres://atlas_app:pw@localhost:6432/atlas',
    ATLAS_AUTH_ISSUER: 'https://id.atlas.test',
    ATLAS_AUTH_AUDIENCE: 'atlas-api',
    ATLAS_AUTH_JWKS_URL: 'https://id.atlas.test/jwks',
    ATLAS_IDENTITY_TOKEN_URL: 'https://id.atlas.test/token',
    ATLAS_ASSESSMENT_CLIENT_ID: 'svc_assessment',
    ATLAS_ASSESSMENT_CLIENT_SECRET: 's',
    ATLAS_PROFILE_SVC_URL: 'http://profile',
    ATLAS_SANDBOX_SVC_URL: 'http://sandbox',
    ATLAS_PROCTORING_SVC_URL: 'http://proctoring',
    ATLAS_INTERVIEW_SVC_URL: 'http://interview',
  };
  it('refuses unsafe production settings', () => {
    expect(loadAssessmentSvcConfig(env).ATLAS_ASSESSMENT_PORT).toBe(8088);
    expect(() => loadAssessmentSvcConfig({ ...env, NODE_ENV: 'production' })).toThrow(
      /ATLAS_REDIS_URL/,
    );
  });
});

describe('sandbox-svc client', () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(JSON.stringify(body), { status, headers }));
    }) as unknown as typeof fetch;
  const gateway = (f: typeof fetch) =>
    new HttpSandboxGateway({
      baseUrl: 'http://sandbox/',
      token: () => Promise.resolve('tok'),
      fetch: f,
    });
  const exec = {
    language: 'python',
    source: 'x',
    question_version: 1,
    assessment_id: 'a',
    candidate_id: 'c',
  };

  it('calls the internal API with the service token and the tenant', async () => {
    const g = gateway(respond(202, { submission_id: 's1' }));
    await expect(g.submit('t1', 'sess', 'q', exec, 'key-123456')).resolves.toEqual({
      submission_id: 's1',
    });
    const last = calls.at(-1);
    expect(last?.url).toBe('http://sandbox/v1/sessions/sess/questions/q/submissions?tenant_id=t1');
    expect(last?.init.headers).toMatchObject({
      Authorization: 'Bearer tok',
      'Idempotency-Key': 'key-123456',
    });
    await gateway(respond(200, { status: 'verified' })).registerBundle('t1', 'q', 2, {
      languages: ['python'],
      tests: [],
      reference_solution: { language: 'python', source: 'x' },
    });
    expect(calls.at(-1)?.url).toBe('http://sandbox/v1/test-case-bundles/q/versions/2?tenant_id=t1');
    expect(calls.at(-1)?.init.method).toBe('PUT');
    await gateway(respond(200, {})).getRun('t1', 'r', 4);
    expect(calls.at(-1)?.url).toBe('http://sandbox/v1/runs/r?tenant_id=t1&wait=4');
    await gateway(respond(200, {})).getSubmission('t1', 's');
    await gateway(respond(202, { run_id: 'r' })).run('t1', 'sess', 'q', exec);
  });

  it('passes 4xx problems on and treats 5xx and network errors as the dependency failing', async () => {
    const throttled = gateway(
      respond(429, { code: 'RUN_THROTTLED', detail: 'slow down' }, { 'Retry-After': '3' }),
    );
    const err = await throttled.run('t', 's', 'q', exec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceRejectedError);
    expect(err).toMatchObject({ status: 429, code: 'RUN_THROTTLED', retryAfter: 3 });
    await expect(translate(() => throttled.run('t', 's', 'q', exec))).rejects.toMatchObject({
      status: 429,
      code: 'RUN_THROTTLED',
    });
    for (const [status, code, mapped] of [
      [404, 'RUN_NOT_FOUND', 404],
      [409, 'SESSION_NOT_ACTIVE', 409],
      [422, 'LANGUAGE_DISABLED', 422],
      [400, 'VALIDATION_FAILED', 422],
      [403, 'FORBIDDEN', 503],
    ] as const) {
      await expect(
        translate(() => gateway(respond(status, { code })).run('t', 's', 'q', exec)),
      ).rejects.toMatchObject({ status: mapped });
    }
    await expect(gateway(respond(503, {})).run('t', 's', 'q', exec)).rejects.toBeInstanceOf(
      UpstreamError,
    );
    await expect(gateway(respond(401, {})).run('t', 's', 'q', exec)).rejects.toBeInstanceOf(
      UpstreamError,
    );
    const down = (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
    await expect(gateway(down).getRun('t', 'r', 0)).rejects.toBeInstanceOf(UpstreamError);
    const opaque = await gateway(respond(422, 'not json'))
      .run('t', 's', 'q', exec)
      .catch((e: unknown) => e);
    expect(opaque).toMatchObject({ code: 'SERVICE_REJECTED' });
  });
});
