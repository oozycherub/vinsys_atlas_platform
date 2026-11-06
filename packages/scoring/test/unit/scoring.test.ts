import { describe, expect, it } from 'vitest';
import {
  assertWeights,
  assessSkill,
  band,
  candidateEmbedding,
  combine,
  cosine,
  coverage,
  DEFAULT_WEIGHTS,
  experience,
  InvalidWeightsError,
  lexical,
  mustHaveGate,
  type CandidateSkill,
  type Requirement,
  scoreCandidate,
  sem,
  semFromCosine,
} from '../../src';

const skills = (entries: [string, number, boolean?][]): Map<string, CandidateSkill> =>
  new Map(entries.map(([id, p, v]) => [id, { proficiency: p, validated: v ?? false }]));
const req = (skillId: string, target: number, extra: Partial<Requirement> = {}): Requirement => ({
  skillId,
  weight: 1,
  target,
  mustHave: false,
  related: [],
  ...extra,
});

describe('golden values for every component (PRD §2.1(b))', () => {
  it('SEM rescales cosine between 0.30 and 0.85', () => {
    expect(semFromCosine(0.3)).toBe(0);
    expect(semFromCosine(0.85)).toBe(1);
    expect(semFromCosine(0.575)).toBeCloseTo(0.5, 12);
    expect(semFromCosine(0.1)).toBe(0);
    expect(semFromCosine(0.99)).toBe(1);
  });

  it('SEM averages the 3 chunks most similar to the job, normalised', () => {
    const job = [1, 0, 0];
    const chunks = [
      [1, 0, 0],
      [0.8, 0.6, 0],
      [0.6, 0, 0.8],
      [0, 1, 0], // least similar: excluded with k = 3
    ];
    const ec = candidateEmbedding(chunks, job)!;
    const expected = [(1 + 0.8 + 0.6) / 3, 0.6 / 3, 0.8 / 3];
    const n = Math.hypot(...expected);
    expect(ec.map((x) => Number(x.toFixed(9)))).toEqual(
      expected.map((x) => Number((x / n).toFixed(9))),
    );
    const result = sem(chunks, job);
    expect(result.cosine).toBeCloseTo(2.4 / 3 / n, 12);
    expect(result.value).toBe(1); // cosine 0.93 is above the 0.85 ceiling
    const middling = sem([[0.6, 0.8]], [1, 0]);
    expect(middling.value).toBeCloseTo((0.6 - 0.3) / 0.55, 12);
    expect(sem([], job)).toEqual({ cosine: 0, value: 0 });
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(() => cosine([1], [1, 2])).toThrow(/lengths differ/);
  });

  it('COV gives partial credit for related skills, with rho capped at 0.8', () => {
    const r = req('kafka', 4, { related: [{ skillId: 'pulsar', rho: 0.95 }] });
    const viaRelated = assessSkill(r, skills([['pulsar', 5]]));
    expect(viaRelated.effective).toBeCloseTo(0.8 * 5, 12); // ρ 0.95 → 0.8
    expect(viaRelated.via).toEqual({ skillId: 'pulsar', rho: 0.8, proficiency: 5 });
    expect(viaRelated.ratio).toBe(1);

    const own = assessSkill(
      r,
      skills([
        ['kafka', 3],
        ['pulsar', 3],
      ]),
    );
    expect(own.effective).toBe(3); // own 3 beats 0.8 · 3
    expect(own.via).toBeNull();
    expect(own.ratio).toBeCloseTo(0.75, 12);

    const assessed = [
      assessSkill(req('a', 4, { weight: 1 }), skills([['a', 2]])), // 0.5
      assessSkill(req('b', 2, { weight: 3 }), skills([['b', 5]])), // capped at 1
      assessSkill(req('c', 3, { weight: 1 }), skills([])), // 0
    ];
    expect(coverage(assessed)).toBeCloseTo((1 * 0.5 + 3 * 1 + 1 * 0) / 5, 12);
    expect(coverage([])).toBe(1);
    expect(assessSkill(req('z', 0), skills([])).ratio).toBe(1);
  });

  it('EXP is a Gaussian on missing years with sigma 2, and never penalises surplus', () => {
    expect(experience(5, 5)).toBe(1);
    expect(experience(5, 9)).toBe(1);
    expect(experience(5, 3)).toBeCloseTo(Math.exp(-4 / 8), 12);
    expect(experience(6, 0)).toBeCloseTo(Math.exp(-36 / 8), 12);
    expect(experience(4, null)).toBeCloseTo(Math.exp(-16 / 8), 12);
    expect(experience(null, 1)).toBe(1);
  });

  it('LEX divides by the best BM25 in the result set', () => {
    expect(lexical(3, 12)).toBe(0.25);
    expect(lexical(12, 12)).toBe(1);
    expect(lexical(5, 0)).toBe(0);
  });

  it('bands', () => {
    expect([0.75, 0.7499, 0.6, 0.5999, 0.45, 0.4499].map(band)).toEqual([
      'strong',
      'good',
      'good',
      'partial',
      'partial',
      'weak',
    ]);
  });
});

describe('must-have soft gate', () => {
  const must = (target: number) => req('m', target, { mustHave: true });

  it('halves the score for each must-have below half its target', () => {
    expect(mustHaveGate([assessSkill(must(4), skills([['m', 2]]))])).toBe(1); // exactly half
    expect(mustHaveGate([assessSkill(must(4), skills([['m', 1.99]]))])).toBe(0.5);
    const twoMissing = [
      assessSkill(must(4), skills([])),
      assessSkill({ ...must(4), skillId: 'n' }, skills([])),
    ];
    expect(mustHaveGate(twoMissing)).toBe(0.25);
    expect(mustHaveGate([assessSkill(req('nice', 5), skills([]))])).toBe(1); // only must-haves gate
  });

  it('counts related credit toward the gate', () => {
    const r = req('k8s', 4, { mustHave: true, related: [{ skillId: 'nomad', rho: 0.6 }] });
    expect(assessSkill(r, skills([['nomad', 4]])).meetsGate).toBe(true); // 2.4 ≥ 2
  });

  it('applies to the whole score', () => {
    const base = { sem: 1, semCosine: 1, cov: 1, exp: 1, lex: 1, gate: 1 };
    expect(combine(base, DEFAULT_WEIGHTS)).toBeCloseTo(1, 12);
    expect(combine({ ...base, gate: 0.5 }, DEFAULT_WEIGHTS)).toBeCloseTo(0.5, 12);
  });
});

describe('weights', () => {
  it('rejects weights that do not sum to 1, or are negative', () => {
    expect(assertWeights(DEFAULT_WEIGHTS)).toBe(DEFAULT_WEIGHTS);
    expect(() => assertWeights({ sem: 0.4, cov: 0.4, exp: 0.15, lex: 0.1 })).toThrow(
      InvalidWeightsError,
    );
    expect(() => assertWeights({ sem: 1.2, cov: -0.2, exp: 0, lex: 0 })).toThrow(/non-negative/);
    expect(() => assertWeights({ sem: Number.NaN, cov: 1, exp: 0, lex: 0 })).toThrow(
      InvalidWeightsError,
    );
    expect(() =>
      combine(
        { sem: 1, semCosine: 1, cov: 1, exp: 1, lex: 1, gate: 1 },
        { sem: 0.5, cov: 0.5, exp: 0.5, lex: 0 },
      ),
    ).toThrow(InvalidWeightsError);
  });

  it('weighs the components as configured', () => {
    const c = { sem: 0.5, semCosine: 0.575, cov: 0.8, exp: 1, lex: 0.25, gate: 1 };
    expect(combine(c, DEFAULT_WEIGHTS)).toBeCloseTo(
      0.4 * 0.5 + 0.35 * 0.8 + 0.15 * 1 + 0.1 * 0.25,
      12,
    );
    expect(combine(c, { sem: 0, cov: 1, exp: 0, lex: 0 })).toBeCloseTo(0.8, 12);
  });
});

describe('scoreCandidate', () => {
  it('combines every component end to end', () => {
    const result = scoreCandidate(
      {
        chunks: [[1, 0]],
        jobEmbedding: [0.8, 0.6],
        requirements: [req('py', 4, { mustHave: true }), req('sql', 2)],
        skills: skills([
          ['py', 3, true],
          ['sql', 1],
        ]),
        requiredYears: 5,
        candidateYears: 3,
        bm25: 2,
        maxBm25: 4,
      },
      DEFAULT_WEIGHTS,
    );
    const sem = (0.8 - 0.3) / 0.55;
    const cov = (0.75 + 0.5) / 2;
    const exp = Math.exp(-0.5);
    expect(result.components).toMatchObject({
      sem: expect.closeTo(sem, 12),
      cov,
      exp: expect.closeTo(exp, 12),
      lex: 0.5,
      gate: 1,
    });
    expect(result.score).toBeCloseTo(0.4 * sem + 0.35 * cov + 0.15 * exp + 0.1 * 0.5, 12);
    expect(result.band).toBe(band(result.score));
  });

  it('marketplace options: unvalidated skills at 50% and availability', () => {
    const input = {
      chunks: [],
      jobEmbedding: [1, 0],
      requirements: [req('py', 4)],
      skills: skills([['py', 4, false]]),
      requiredYears: null,
      candidateYears: null,
      bm25: 0,
      maxBm25: 0,
    };
    const hiring = scoreCandidate(input, DEFAULT_WEIGHTS);
    const marketplace = scoreCandidate(input, DEFAULT_WEIGHTS, {
      unvalidatedFactor: 0.5,
      availability: 0.5,
    });
    expect(hiring.components.cov).toBe(1);
    expect(marketplace.components.cov).toBe(0.5);
    expect(marketplace.score).toBeCloseTo((0.35 * 0.5 + 0.15) * 0.5, 12);
  });
});
