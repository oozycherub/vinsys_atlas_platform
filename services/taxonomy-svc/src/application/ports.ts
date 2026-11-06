import { type SkillClassification, type SkillNodeType } from '@atlas/contracts';
import { type Tx } from '@atlas/platform';
import { type ImportSummary, type PlanEntry } from '../domain/import-plan';
import { type JobProfile } from '../domain/job-profile';
import { type Skill, type SkillOverride } from '../domain/skill';

/**
 * Every repository method runs inside a transaction owned by the application layer. `view` is
 * the tenant whose view of the taxonomy is wanted (null = global only). Queries filter on it
 * explicitly as well as relying on RLS, because curator transactions run with app.system = 'on'.
 */
export type View = string | null;

/** A skill as one tenant sees it: global skills carry that tenant's overlay. */
export interface VisibleSkill extends Skill {
  readonly override: SkillOverride | null;
}

export interface SkillListFilter {
  view: View;
  path?: string;
  q?: string;
  classification?: SkillClassification;
  nodeType?: SkillNodeType;
  includeDeprecated: boolean;
  limit: number;
  after?: { path: string; id: string };
}

export interface Embedding {
  vector: readonly number[];
  model: string;
}

export interface SkillRepository {
  /** Visible in `view`, hidden skills excluded unless `includeHidden`. */
  findById(
    tx: Tx,
    view: View,
    id: string,
    options?: { includeHidden?: boolean; forUpdate?: boolean },
  ): Promise<VisibleSkill | null>;
  findByPaths(tx: Tx, view: View, paths: readonly string[]): Promise<Skill[]>;
  insert(tx: Tx, skill: Skill, embedding: Embedding | null): Promise<void>;
  /** Compare-and-set on `version`. `embedding` undefined keeps the stored one. */
  update(
    tx: Tx,
    skill: Skill,
    expectedVersion: number,
    embedding?: Embedding | null,
  ): Promise<boolean>;
  list(tx: Tx, filter: SkillListFilter): Promise<VisibleSkill[]>;
  /** Ancestors of a path, root first. */
  ancestors(tx: Tx, view: View, path: string): Promise<Skill[]>;
  /** Skills (any status) whose name, alias or tenant override alias equals one of `keys`. */
  aliasCandidates(
    tx: Tx,
    view: View,
    keys: readonly string[],
  ): Promise<{ key: string; skill: Skill }[]>;
  /** Nearest active, non-hidden leaf skill embedded with `model`. */
  nearest(
    tx: Tx,
    view: View,
    vector: readonly number[],
    model: string,
  ): Promise<{ skill: Skill; cosine: number } | null>;
  /** Active skills of a scope whose embedding is missing or from another model. */
  needingEmbedding(
    tx: Tx,
    scopeTenantId: string | null,
    model: string,
    limit: number,
  ): Promise<Skill[]>;
  setEmbedding(tx: Tx, skillId: string, embedding: Embedding): Promise<void>;
  /** Changes when anything in the scope changes; imports compare it at commit. */
  fingerprint(tx: Tx, scopeTenantId: string | null): Promise<string>;
  countAtVersion(tx: Tx, scopeTenantId: string | null, version: number): Promise<number>;
}

export interface SkillEdge {
  tenantId: string | null;
  src: string;
  dst: string;
  edgeType: 'RELATED_TO' | 'PREREQUISITE_OF' | 'REPLACES';
  weight: number;
}

export interface RelatedSkill {
  skill: Skill;
  edgeType: SkillEdge['edgeType'];
  direction: 'out' | 'in' | 'both';
  weight: number;
}

export interface EdgeRepository {
  insert(tx: Tx, edge: SkillEdge): Promise<boolean>;
  delete(
    tx: Tx,
    scopeTenantId: string | null,
    src: string,
    dst: string,
    edgeType: SkillEdge['edgeType'],
  ): Promise<boolean>;
  /** Serialises prerequisite inserts so two concurrent edges cannot close a cycle. */
  lockPrerequisites(tx: Tx): Promise<void>;
  /** True if `from` already reaches `to` through PREREQUISITE_OF edges visible in `view`. */
  reaches(tx: Tx, view: View, from: string, to: string): Promise<boolean>;
  related(tx: Tx, view: View, skillId: string): Promise<RelatedSkill[]>;
}

export interface OverrideRepository {
  find(tx: Tx, skillId: string): Promise<SkillOverride | null>;
  upsert(tx: Tx, override: SkillOverride, expectedVersion: number | null): Promise<boolean>;
  delete(tx: Tx, skillId: string): Promise<boolean>;
}

export interface Suggestion {
  term: string;
  bestSkillId: string | null;
  bestScore: number | null;
  occurrences: number;
  lastSeenAt: Date;
}

export interface SuggestionRepository {
  record(tx: Tx, tenantId: string, term: string, bestSkillId: string, score: number): Promise<void>;
  list(tx: Tx, limit: number): Promise<Suggestion[]>;
}

export interface VersionRepository {
  publishedVersion(tx: Tx, scopeTenantId: string | null): Promise<number>;
  publish(
    tx: Tx,
    scopeTenantId: string | null,
    version: number,
    by: string,
    at: Date,
  ): Promise<void>;
}

export interface ImportBatch {
  id: string;
  tenantId: string | null;
  status: 'dry_run' | 'committed' | 'failed';
  fileName: string;
  rowCount: number;
  summary: ImportSummary;
  plan: PlanEntry[];
  baseFingerprint: string;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  committedAt: Date | null;
}

export interface ImportRepository {
  insert(tx: Tx, batch: ImportBatch): Promise<void>;
  find(tx: Tx, id: string, options?: { forUpdate?: boolean }): Promise<ImportBatch | null>;
  markCommitted(tx: Tx, id: string, at: Date): Promise<void>;
}

export interface JobFamily {
  id: string;
  tenantId: string;
  name: string;
  createdAt: Date;
}

export interface JobRole {
  id: string;
  tenantId: string;
  jobFamilyId: string;
  name: string;
  level: string | null;
  createdAt: Date;
}

export interface JobRepository {
  insertFamily(tx: Tx, family: JobFamily): Promise<boolean>;
  listFamilies(tx: Tx): Promise<JobFamily[]>;
  findFamily(tx: Tx, id: string): Promise<JobFamily | null>;
  insertRole(tx: Tx, role: JobRole): Promise<boolean>;
  listRoles(tx: Tx, familyId?: string): Promise<JobRole[]>;
  findRole(tx: Tx, id: string): Promise<JobRole | null>;
  insertProfile(tx: Tx, profile: JobProfile): Promise<void>;
  findProfile(tx: Tx, id: string, options?: { forUpdate?: boolean }): Promise<JobProfile | null>;
  listProfiles(
    tx: Tx,
    filter: {
      status?: JobProfile['status'];
      limit: number;
      after?: { createdAt: Date; id: string };
    },
  ): Promise<JobProfile[]>;
  /** Compare-and-set on version; replaces the skill list when `withSkills`. */
  updateProfile(
    tx: Tx,
    profile: JobProfile,
    expectedVersion: number,
    withSkills: boolean,
  ): Promise<boolean>;
}

/** Removes every row a tenant owns in this service (tenant purge). */
export interface PurgeRepository {
  purgeTenant(tx: Tx): Promise<Record<string, number>>;
}

/** Text embeddings (bge-m3, 1024 dimensions). Gateway in production, a deterministic stub in dev. */
export interface EmbeddingPort {
  readonly model: string;
  embed(texts: readonly string[]): Promise<number[][]>;
}

export const EMBEDDING_DIMENSIONS = 1024;

export const SKILL_REPOSITORY = Symbol('SKILL_REPOSITORY');
export const EDGE_REPOSITORY = Symbol('EDGE_REPOSITORY');
export const OVERRIDE_REPOSITORY = Symbol('OVERRIDE_REPOSITORY');
export const SUGGESTION_REPOSITORY = Symbol('SUGGESTION_REPOSITORY');
export const VERSION_REPOSITORY = Symbol('VERSION_REPOSITORY');
export const IMPORT_REPOSITORY = Symbol('IMPORT_REPOSITORY');
export const JOB_REPOSITORY = Symbol('JOB_REPOSITORY');
export const PURGE_REPOSITORY = Symbol('PURGE_REPOSITORY');
export const EMBEDDING_PORT = Symbol('EMBEDDING_PORT');
