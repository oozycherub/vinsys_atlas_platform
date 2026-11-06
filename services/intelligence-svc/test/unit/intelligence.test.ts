/** Domain rules of intelligence-svc (Component Prompt 12 §6), including the shared golden file. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadIntelligenceSvcConfig } from '../../src/config';
import { availability, exclusiveEnd, monthsBetween, peakLoad } from '../../src/domain/availability';
import {
  enumeratePaths,
  pathType,
  recommendLearning,
  type Transition,
} from '../../src/domain/career';
import { parseCsv, parseDemandRows, parseSkills, records } from '../../src/domain/demand';
import { matchEmployee, MARKETPLACE_WEIGHTS } from '../../src/domain/marketplace';
import { assertMove, canDecide, OpportunityRuleError } from '../../src/domain/opportunity';
import { gapBand, readiness, type SkillRequirement } from '../../src/domain/readiness';

interface GoldenCase {
  name: string;
  requirements: SkillRequirement[];
  skills: Record<string, number>;
  role_gap_pct: number;
  readiness: number;
  band: string;
  gaps: Record<string, number>;
}

const golden = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'packages',
      'contracts',
      'fixtures',
      'readiness-golden.json',
    ),
    'utf8',
  ),
) as { cases: GoldenCase[] };

describe('readiness (PRD §2.5(iii))', () => {
  it.each(golden.cases.map((c) => [c.name, c] as const))(
    'matches the shared golden file: %s',
    (_, c) => {
      const r = readiness(c.requirements, new Map(Object.entries(c.skills)));
      expect(r.roleGapPct).toBeCloseTo(c.role_gap_pct, 6);
      expect(r.readiness).toBeCloseTo(c.readiness, 6);
      expect(r.band).toBe(c.band);
      expect(Object.fromEntries(r.gaps.map((g) => [g.skill_id, g.gap]))).toEqual(c.gaps);
    },
  );

  it('bands at the PRD boundaries', () => {
    expect([gapBand(0.51), gapBand(0.5), gapBand(0.2), gapBand(0.19)]).toEqual([
      'high',
      'medium',
      'medium',
      'low',
    ]);
  });
});

describe('availability A(e, o) (PRD §2.5(iv))', () => {
  const window = { start: '2026-12-01', end: '2027-02-28' };
  it('peaks at a start date over half-open ranges', () => {
    const allocations = [
      { percent: 60, start: '2026-11-01', end: '2027-01-01' },
      { percent: 30, start: '2026-12-15', end: null },
      { percent: 50, start: '2027-03-01', end: null }, // after the window
    ];
    expect(peakLoad(allocations, window)).toBe(90);
    expect(peakLoad([{ percent: 40, start: '2026-01-01', end: '2026-12-01' }], window)).toBe(0); // ends as it starts
    expect(exclusiveEnd({ start: 'x', end: '2027-02-28' })).toBe('2027-03-01');
    expect(exclusiveEnd({ start: 'x', end: null })).toBeNull();
    expect(
      peakLoad([{ percent: 40, start: '2027-01-01', end: null }], {
        start: '2026-12-01',
        end: null,
      }),
    ).toBe(40);
  });

  it('applies the hard, soft and consent factors', () => {
    const base = {
      allocations: [{ percent: 60, start: '2026-11-01', end: null }],
      window,
      requiredPercent: 40,
      tenureInRoleMonths: 24,
      minTenureMonths: 12,
      optedIn: true,
      opportunityType: 'gig' as const,
    };
    expect(availability(base)).toEqual({ factor: 1, peakLoad: 60, reasons: [] });
    expect(availability({ ...base, requiredPercent: 41 }).factor).toBe(0); // 101%
    expect(availability({ ...base, tenureInRoleMonths: 6 })).toMatchObject({
      factor: 0.7,
      reasons: ['short_tenure'],
    });
    expect(availability({ ...base, optedIn: false }).factor).toBe(0);
    expect(availability({ ...base, optedIn: false, opportunityType: 'project' }).factor).toBe(1);
    expect(availability({ ...base, tenureInRoleMonths: null }).factor).toBe(1);
    expect([
      monthsBetween('2026-01-31', '2026-02-28'),
      monthsBetween('2025-11-06', '2026-11-06'),
      monthsBetween('2027-01-01', '2026-01-01'),
    ]).toEqual([0, 12, 0]);
  });
});

describe('career paths (PRD §2.5(v))', () => {
  const t = (from: string, to: string, type: Transition['type']): Transition => ({
    from,
    to,
    type,
    typicalMonths: 18,
  });
  const graph = [
    t('a', 'b', 'vertical'),
    t('b', 'c', 'vertical'),
    t('a', 'd', 'horizontal'),
    t('d', 'e', 'vertical'),
    t('c', 'a', 'vertical'),
    t('e', 'f', 'vertical'),
    t('f', 'g', 'vertical'),
  ];

  it('enumerates up to depth 3 without cycles, shortest path per target', () => {
    const paths = enumeratePaths('a', graph);
    expect(paths.map((p) => p.map((s) => s.profileId).join('>'))).toEqual([
      'b',
      'd',
      'b>c',
      'd>e',
      'd>e>f',
    ]);
    expect(pathType(paths[0] ?? [])).toBe('vertical');
    expect(pathType(paths[1] ?? [])).toBe('horizontal');
    expect(pathType(paths[3] ?? [])).toBe('diagonal');
  });

  it('recommends learning by weighted gap covered per hour', () => {
    const gaps = [
      { skill_id: 'x', weight: 1, required: 4, proficiency: 2, gap: 2 },
      { skill_id: 'y', weight: 0.5, required: 3, proficiency: 1, gap: 2 },
      { skill_id: 'z', weight: 1, required: 3, proficiency: 3, gap: 0 },
    ];
    const items = [
      { item_id: 'both', title: 'Both', skill_ids: ['x', 'y'], duration_hours: 20 },
      { item_id: 'x', title: 'X', skill_ids: ['x'], duration_hours: 4 },
      { item_id: 'w', title: 'W', skill_ids: ['w'], duration_hours: 1 },
    ];
    expect(recommendLearning(gaps, items)).toEqual({
      items: [items[1], items[0]],
      hours: 24,
      uncovered: [],
    });
    expect(recommendLearning(gaps, [items[1] as (typeof items)[number]]).uncovered).toEqual(['y']);
    expect(recommendLearning(gaps, items, 1).items).toHaveLength(1);
  });
});

describe('demand sheets', () => {
  const s1 = '0192f0c1-0000-7000-8000-0000000000a1';
  it('parses RFC 4180 CSV', () => {
    expect(parseCsv('\uFEFFa,b\r\n"x, y","say ""hi"""\n\n1,2')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['1', '2'],
    ]);
    expect(
      records([
        ['Title', 'HEADCOUNT'],
        ['A', '2', 'extra'],
      ]),
    ).toEqual([{ title: 'A', headcount: '2' }]);
    expect(records([])).toEqual([]);
  });

  it('validates rows and reports each error with its row', () => {
    const rows = records(
      parseCsv(
        [
          'title,account_id,external_ref,job_profile_id,skills,headcount,allocation_pct,start_date,end_date,location',
          `Analyst,acme,R1,,${s1}:1:4:must,2,50,2027-01-04,2027-06-30,Dubai`,
          `,acme,R2,,${s1}:1:4,1,,2027-01-04,,`,
          `Quant,acme,R3,,${s1}:1.5:4,1,,2027-01-04,,`,
          `Quant,acme,R4,,,1,,2027-01-04,,`,
          `Quant,acme,R5,,${s1}:1:4,0,,2027-01-04,,`,
          `Quant,acme,R6,,${s1}:1:4,1,120,2027-01-04,,`,
          `Quant,acme,R7,,${s1}:1:4,1,,2027-02-30,,`,
          `Quant,acme,R8,,${s1}:1:4,1,,2027-01-04,2026-01-01,`,
          `Quant,acme,R1,,${s1}:1:4,1,,2027-01-04,,`,
          `Lead,acme,,not-a-uuid,,1,,2027-01-04,,`,
          `Lead,,,${s1},,1,,2027-01-04,,`,
        ].join('\n'),
      ),
    );
    const { demands, errors } = parseDemandRows(rows);
    expect(demands.map((d) => d.title)).toEqual(['Analyst', 'Lead']);
    expect(demands[0]).toMatchObject({
      skills: [{ skill_id: s1, weight: 1, target_proficiency: 4, must_have: true }],
      headcount: 2,
      allocation_pct: 50,
      end_date: '2027-06-30',
      location: 'Dubai',
    });
    expect(errors.map((e) => e.row)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(errors.map((e) => e.message)).toEqual([
      expect.stringContaining('title'),
      expect.stringContaining('weight'),
      expect.stringContaining('skills or job_profile_id'),
      expect.stringContaining('headcount'),
      expect.stringContaining('allocation_pct'),
      expect.stringContaining('start_date'),
      expect.stringContaining('end_date'),
      expect.stringContaining('appears twice'),
      expect.stringContaining('not a UUID'),
    ]);
    expect(() => parseSkills('nope:1:1')).toThrow('not a skill id');
    expect(() => parseSkills(`${s1}:1:9`)).toThrow('0-5');
    expect(parseDemandRows(new Array(5001).fill({ title: 'x' })).errors[0]?.message).toContain(
      'At most',
    );
  });
});

describe('marketplace score (PRD §2.5(iv))', () => {
  const a = 'skill-a';
  const b = 'skill-b';
  const now = new Date('2026-11-06T00:00:00Z');
  const base = {
    requirements: [
      { skill_id: a, weight: 1, target_proficiency: 4, must_have: true },
      { skill_id: b, weight: 1, target_proficiency: 2, must_have: false },
    ],
    related: new Map<string, { skillId: string; rho: number }[]>(),
    skills: new Map([
      [a, { proficiency: 4, validated: true }],
      [b, { proficiency: 4, validated: false }],
    ]),
    semantic: null,
    availability: {
      allocations: [],
      window: { start: '2026-12-01', end: null },
      requiredPercent: 50,
      tenureInRoleMonths: 24,
      minTenureMonths: 12,
      optedIn: true,
      opportunityType: 'gig' as const,
    },
    requisitionScore: null,
    sourceSyncedAt: now,
    now,
  };

  it('is Score · A, with unvalidated skills at 50% and no SEM without embeddings', () => {
    const m = matchEmployee(base);
    // COV = (1 + min(1, 4·0.5/2)) / 2 = 1; EXP = 1; SEM unavailable → 0.85·1 + 0.15·1.
    expect(m.score).toBeCloseTo(1, 4);
    expect(m.scoreInternal).toBeCloseTo(1, 4);
    expect(m.explanation.semantic).toBe('unavailable');
    expect(m.lowConfidence).toBe(false);
    const halfValidated = matchEmployee({
      ...base,
      skills: new Map([[a, { proficiency: 4, validated: false }]]),
    });
    expect(halfValidated.lowConfidence).toBe(true);
    // a counts 2 of 4 (unvalidated) → must-have gate holds at exactly half; b missing.
    expect(halfValidated.score).toBeCloseTo(0.85 * 0.25 + 0.15, 4);
    const busy = matchEmployee({
      ...base,
      availability: {
        ...base.availability,
        allocations: [{ percent: 60, start: '2026-11-01', end: null }],
      },
    });
    expect([busy.availability, busy.scoreInternal, busy.explanation.availability]).toEqual([
      0,
      0,
      ['overbooked'],
    ]);
  });

  it('uses SEM with embeddings, related skills, requisition scores and staleness', () => {
    const job = [1, 0, 0];
    const withSem = matchEmployee({ ...base, semantic: { chunks: [[1, 0, 0]], job } });
    expect(withSem.explanation.semantic).toBe('used');
    expect(MARKETPLACE_WEIGHTS.lex).toBe(0);
    const related = matchEmployee({
      ...base,
      skills: new Map([['c', { proficiency: 5, validated: true }]]),
      related: new Map([[a, [{ skillId: 'c', rho: 0.8 }]]]),
    });
    expect(related.explanation.via_related).toEqual([{ skill_id: a, via: 'c' }]);
    const linked = matchEmployee({ ...base, requisitionScore: 0.62 });
    expect([linked.score, linked.explanation.source]).toEqual([0.62, 'requisition']);
    const stale = matchEmployee({
      ...base,
      sourceSyncedAt: new Date(now.getTime() - 25 * 3_600_000),
    });
    expect(stale.stale).toBe(true);
  });
});

describe('opportunity rules', () => {
  it('moves through its lifecycle only forwards', () => {
    expect(() => assertMove('draft', 'open')).not.toThrow();
    expect(() => assertMove('open', 'draft')).toThrow(OpportunityRuleError);
    expect(() => assertMove('closed', 'open')).toThrow('cannot go from closed to open');
  });

  it('lets the right party decide', () => {
    expect(canDecide('application', 'accept', 'owner')).toBe(true);
    expect(canDecide('application', 'accept', 'employee')).toBe(false);
    expect(canDecide('invitation', 'accept', 'employee')).toBe(true);
    expect(canDecide('invitation', 'decline', 'owner')).toBe(false);
    expect(canDecide('application', 'withdraw', 'employee')).toBe(true);
    expect(canDecide('invitation', 'withdraw', 'owner')).toBe(true);
    expect(canDecide('invitation', 'withdraw', 'employee')).toBe(false);
  });
});

describe('config', () => {
  const env = {
    ATLAS_DATABASE_URL: 'postgres://u:p@localhost/db',
    ATLAS_AUTH_ISSUER: 'https://id.atlas.test',
    ATLAS_AUTH_AUDIENCE: 'atlas-api',
    ATLAS_AUTH_SHARED_SECRET: 's'.repeat(32),
    ATLAS_IDENTITY_TOKEN_URL: 'http://id/token',
    ATLAS_INTELLIGENCE_CLIENT_ID: 'intelligence-svc',
    ATLAS_INTELLIGENCE_CLIENT_SECRET: 'x',
    ATLAS_TAXONOMY_SVC_URL: 'http://taxonomy',
    ATLAS_PARSING_SVC_URL: 'http://parsing',
    ATLAS_LLM_GATEWAY_URL: 'http://gateway',
  };

  it('loads and refuses unsafe production settings', () => {
    expect(loadIntelligenceSvcConfig(env).ATLAS_INTELLIGENCE_PORT).toBe(8092);
    expect(() =>
      loadIntelligenceSvcConfig({ ...env, ATLAS_AUTH_SHARED_SECRET: undefined }),
    ).toThrow();
    expect(() =>
      loadIntelligenceSvcConfig({ ...env, ATLAS_INTELLIGENCE_EVENT_SOURCE: 'kafka' }),
    ).toThrow();
    expect(() => loadIntelligenceSvcConfig({ ...env, NODE_ENV: 'production' })).toThrow();
  });
});
