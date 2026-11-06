import { describe, expect, it } from 'vitest';
import { TaxonomyDomainError } from '../../src/domain/errors';
import { type ImportRow, planImport } from '../../src/domain/import-plan';
import {
  archiveJobProfile,
  createJobProfile,
  patchJobProfile,
  publishJobProfile,
  setJobProfileSkills,
} from '../../src/domain/job-profile';
import { decideAnn, pickAliasMatch } from '../../src/domain/normalize';
import { assertPath, parentPath, parentType, slugLabel } from '../../src/domain/paths';
import {
  assertVersion,
  assertWritable,
  buildOverride,
  createSkill,
  deprecateSkill,
  embeddingInputChanged,
  embeddingText,
  patchSkill,
  type Skill,
} from '../../src/domain/skill';
import { cleanAliases, searchKeys, termKey } from '../../src/domain/terms';

const NOW = new Date('2026-11-05T10:00:00Z');
const T = '0192f0c4-0000-7000-8000-000000000001';

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TaxonomyDomainError);
    return (error as TaxonomyDomainError).code;
  }
  return 'none';
}

function node(
  path: string,
  nodeType: Skill['nodeType'],
  parent: Skill | null,
  tenantId: string | null = null,
): Skill {
  return createSkill({
    id: `id-${path}`,
    tenantId,
    nodeType,
    path,
    name: path.split('.').pop()!,
    parent,
    taxonomyVersion: 1,
    now: NOW,
  });
}

const domain = node('tech', 'domain', null);
const sub = node('tech.sw', 'subdomain', domain);
const cluster = node('tech.sw.data', 'cluster', sub);
const kafka = node('tech.sw.data.kafka', 'skill', cluster);

describe('terms', () => {
  it('normalises keys but keeps meaningful punctuation', () => {
    expect(termKey('  Apache   KAFKA! ')).toBe('apache kafka');
    expect(termKey('C++')).toBe('c++');
    expect(termKey('C#')).toBe('c#');
    expect(termKey('.NET')).toBe('.net');
    expect(termKey('Node.js')).toBe('node.js');
    expect(termKey('Python.')).toBe('python');
    expect(termKey('ＪＳ')).toBe('js'); // full-width (NFKC)
    expect(searchKeys('JavaScript', ['JS', 'js', 'ECMAScript'])).toEqual([
      'ecmascript',
      'javascript',
      'js',
    ]);
    expect(cleanAliases([' JS ', 'js', '', 'Java  Script'])).toEqual(['JS', 'Java Script']);
  });
});

describe('paths', () => {
  it('fixes depth by node type and validates labels', () => {
    expect(assertPath('a.b.c.d', 'skill')).toHaveLength(4);
    expect(code(() => assertPath('a.b', 'skill'))).toBe('PATH_DEPTH_MISMATCH');
    expect(code(() => assertPath('A.b', 'subdomain'))).toBe('INVALID_PATH');
    expect(parentPath('a.b.c')).toBe('a.b');
    expect(parentPath('a')).toBeNull();
    expect(parentType('skill')).toBe('cluster');
    expect(parentType('domain')).toBeNull();
    expect(slugLabel('C++ / C# Programming')).toBe('cplusplus_csharp_programming');
  });
});

describe('skills', () => {
  it('requires the right parent, in the right scope', () => {
    expect(code(() => node('tech.sw.data.x', 'skill', null))).toBe('PARENT_NOT_FOUND');
    expect(code(() => node('tech.sw.data.x', 'skill', sub))).toBe('INVALID_PARENT');
    expect(code(() => node('other.sw.data.x', 'skill', cluster))).toBe('INVALID_PARENT');
    const tenantCluster = node('tech.sw.mine', 'cluster', sub, T);
    expect(code(() => node('tech.sw.mine.x', 'skill', tenantCluster, null))).toBe(
      'GLOBAL_UNDER_TENANT',
    );
    expect(node('tech.sw.mine.x', 'skill', tenantCluster, T).tenantId).toBe(T);
    const deprecated = deprecateSkill(cluster, null, 2, NOW);
    expect(code(() => node('tech.sw.data.y', 'skill', deprecated))).toBe('PARENT_DEPRECATED');
    expect(
      code(() =>
        createSkill({
          id: 'x',
          tenantId: null,
          nodeType: 'domain',
          path: 'x',
          name: ' ',
          parent: null,
          taxonomyVersion: 1,
          now: NOW,
        }),
      ),
    ).toBe('INVALID_NAME');
  });

  it('patches, tracks embedding input and versions', () => {
    const next = patchSkill(kafka, { name: 'Apache Kafka', aliases: ['AK'] }, 2, NOW);
    expect(next).toMatchObject({ name: 'Apache Kafka', version: 2, taxonomyVersion: 2 });
    expect(next.searchKeys).toEqual(['ak', 'apache kafka']);
    expect(embeddingInputChanged(kafka, next)).toBe(true);
    expect(embeddingInputChanged(kafka, patchSkill(kafka, { aliases: ['x'] }, 2, NOW))).toBe(false);
    expect(embeddingText({ name: 'Kafka', description: 'Streams' })).toBe('Kafka: Streams');
    expect(embeddingText({ name: 'Kafka', description: null })).toBe('Kafka');
    expect(code(() => assertVersion(next, 1))).toBe('VERSION_MISMATCH');
  });

  it('deprecates towards a valid successor only', () => {
    const rabbit = node('tech.sw.data.rabbit', 'skill', cluster);
    expect(code(() => deprecateSkill(kafka, kafka, 2, NOW))).toBe('INVALID_SUCCESSOR');
    expect(code(() => deprecateSkill(kafka, cluster, 2, NOW))).toBe('INVALID_SUCCESSOR');
    expect(code(() => deprecateSkill(kafka, deprecateSkill(rabbit, null, 2, NOW), 2, NOW))).toBe(
      'INVALID_SUCCESSOR',
    );
    expect(
      code(() => deprecateSkill(kafka, node('tech.sw.data.t', 'skill', cluster, T), 2, NOW)),
    ).toBe('INVALID_SUCCESSOR');
    const done = deprecateSkill(kafka, rabbit, 2, NOW);
    expect(done).toMatchObject({ replacedBy: rabbit.id, deprecatedAt: NOW });
    expect(code(() => deprecateSkill(done, null, 3, NOW))).toBe('SKILL_DEPRECATED');
    expect(code(() => patchSkill(done, { name: 'x' }, 3, NOW))).toBe('SKILL_DEPRECATED');
  });

  it('separates global and tenant write access, and overlays only global skills', () => {
    expect(code(() => assertWritable(kafka, T))).toBe('GLOBAL_SKILL_READ_ONLY');
    expect(code(() => assertWritable(node('tech.sw.data.t', 'skill', cluster, T), null))).toBe(
      'NOT_YOUR_SKILL',
    );
    expect(code(() => assertWritable(kafka, null))).toBe('none');
    const o = buildOverride(
      T,
      kafka,
      { hidden: false, adopted: true, displayName: ' Streams ', aliases: ['KS'] },
      0,
    );
    expect(o).toMatchObject({ displayName: 'Streams', version: 1, searchKeys: ['ks', 'streams'] });
    expect(
      buildOverride(T, kafka, { hidden: true, adopted: false, displayName: null, aliases: [] }, 1)
        .searchKeys,
    ).toEqual([]);
    expect(
      code(() =>
        buildOverride(T, kafka, { hidden: true, adopted: true, displayName: null, aliases: [] }, 0),
      ),
    ).toBe('INVALID_OVERRIDE');
    expect(
      code(() =>
        buildOverride(
          T,
          node('tech.sw.data.t', 'skill', cluster, T),
          { hidden: true, adopted: false, displayName: null, aliases: [] },
          0,
        ),
      ),
    ).toBe('OVERRIDE_ON_TENANT_SKILL');
  });
});

describe('normalisation rules', () => {
  it('applies the 0.82 / 0.70 thresholds', () => {
    expect(decideAnn(0.82)).toEqual({ kind: 'accept', confidence: 0.82 });
    expect(decideAnn(0.8199)).toMatchObject({ kind: 'suggest' });
    expect(decideAnn(0.7)).toMatchObject({ kind: 'suggest' });
    expect(decideAnn(0.6999)).toMatchObject({ kind: 'reject' });
    expect(decideAnn(-0.2).confidence).toBe(0);
  });

  it('prefers tenant skills and refuses ambiguous aliases', () => {
    const g1 = { id: 'g1', tenantId: null };
    const g2 = { id: 'g2', tenantId: null };
    const t1 = { id: 't1', tenantId: T };
    expect(pickAliasMatch([])).toBeNull();
    expect(pickAliasMatch([g1, g1])).toBe(g1);
    expect(pickAliasMatch([g1, t1])).toBe(t1);
    expect(pickAliasMatch([g1, g2])).toBeNull();
  });
});

describe('job profiles', () => {
  const base = createJobProfile({
    id: 'p',
    tenantId: T,
    jobRoleId: null,
    title: ' Engineer ',
    description: '',
    now: NOW,
  });
  const skill = { skillId: 's1', weight: 0.5, targetProficiency: 3.5, mustHave: false };

  it('validates weights, targets and duplicates', () => {
    expect(base).toMatchObject({ title: 'Engineer', description: null, status: 'draft' });
    expect(code(() => setJobProfileSkills(base, [{ ...skill, weight: 1.2 }], NOW))).toBe(
      'INVALID_WEIGHT',
    );
    expect(code(() => setJobProfileSkills(base, [{ ...skill, targetProficiency: 5.5 }], NOW))).toBe(
      'INVALID_TARGET_PROFICIENCY',
    );
    expect(code(() => setJobProfileSkills(base, [skill, skill], NOW))).toBe('DUPLICATE_SKILL');
    const many = Array.from({ length: 201 }, (_, i) => ({ ...skill, skillId: `s${i}` }));
    expect(code(() => setJobProfileSkills(base, many, NOW))).toBe('TOO_MANY_SKILLS');
    expect(
      code(() =>
        createJobProfile({
          id: 'p',
          tenantId: T,
          jobRoleId: null,
          title: '',
          description: null,
          now: NOW,
        }),
      ),
    ).toBe('INVALID_TITLE');
  });

  it('publishes with skills, keeps at least one, and freezes when archived', () => {
    expect(code(() => publishJobProfile(base, NOW))).toBe('SKILLS_REQUIRED');
    const published = publishJobProfile(setJobProfileSkills(base, [skill], NOW), NOW);
    expect(published).toMatchObject({ status: 'published', version: 3, publishedAt: NOW });
    expect(code(() => setJobProfileSkills(published, [], NOW))).toBe('SKILLS_REQUIRED');
    expect(patchJobProfile(published, { title: 'Lead' }, NOW).title).toBe('Lead');
    const archived = archiveJobProfile(published, NOW);
    expect(code(() => patchJobProfile(archived, { title: 'x' }, NOW))).toBe('JOB_PROFILE_ARCHIVED');
  });
});

describe('import planning', () => {
  const row = (line: number, values: Record<string, string>): ImportRow => ({ line, values });
  const existing = new Map<string, Skill>([
    [domain.path, domain],
    [sub.path, sub],
    [cluster.path, cluster],
    [kafka.path, kafka],
  ]);

  it('creates branches parents-first, diffs updates and reports every error', () => {
    const { entries, summary } = planImport(
      [
        row(2, { path: 'tech.sw.ml.torch', node_type: 'skill', name: 'PyTorch' }),
        row(3, { path: 'tech.sw.ml', node_type: 'cluster', name: 'ML' }),
        row(4, {
          path: 'tech.sw.data.kafka',
          node_type: 'skill',
          name: 'kafka',
          classification: 'tool',
        }),
        row(5, { path: 'tech.sw.data.kafka', node_type: 'skill', name: 'kafka' }),
        row(6, { path: 'bad path', node_type: 'skill', name: 'x' }),
        row(7, { path: 'tech.sw.data.z', node_type: 'gizmo', name: '', classification: 'nope' }),
      ],
      null,
      existing,
    );
    expect(summary).toEqual({ create: 2, update: 1, unchanged: 0, error: 3 });
    expect(entries.map((e) => e.action)).toEqual([
      'create',
      'create',
      'update',
      'error',
      'error',
      'error',
    ]);
    const update = entries[2];
    expect(update?.action === 'update' && update.changed).toEqual(['classification']);
    const bad = entries[5];
    expect(bad?.action === 'error' && bad.errors).toEqual([
      'node_type must be one of domain, subdomain, cluster, skill',
      'name must be 1–200 characters',
      'classification must be one of technical, functional, soft, tool, ai, emerging, unclassified',
    ]);
  });

  it('protects global nodes from tenant imports and reports unchanged rows', () => {
    const tenant = planImport(
      [row(2, { path: 'tech.sw.data.kafka', node_type: 'skill', name: 'kafka' })],
      T,
      existing,
    );
    expect(tenant.summary.error).toBe(1);
    const same = planImport(
      [row(2, { path: 'tech.sw.data', node_type: 'cluster', name: 'data' })],
      null,
      existing,
    );
    expect(same.entries[0]).toMatchObject({ action: 'unchanged' });
    const wrongType = planImport(
      [row(2, { path: 'tech.sw.data.kafka', node_type: 'cluster', name: 'k' })],
      null,
      existing,
    );
    expect(wrongType.summary.error).toBe(1);
    expect(code(() => planImport([], null, existing))).toBe('IMPORT_EMPTY');
  });
});
