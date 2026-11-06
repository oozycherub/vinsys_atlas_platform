import { type Tx } from '@atlas/platform';
import { type Weights } from '@atlas/scoring';
import { type CandidateFeatures, type CandidateSkillFeature } from '../domain/features';
import {
  type Calibrated,
  type Calibration,
  type Requisition,
  type RequisitionStatus,
} from '../domain/requisition';
import { type ScoredCandidate } from '../domain/score';

export const REQUISITION_REPOSITORY = Symbol('REQUISITION_REPOSITORY');
export const FEATURE_REPOSITORY = Symbol('FEATURE_REPOSITORY');
export const SCORE_REPOSITORY = Symbol('SCORE_REPOSITORY');
export const WORK_QUEUE = Symbol('WORK_QUEUE');
export const VECTOR_SEARCH = Symbol('VECTOR_SEARCH');
export const EMBEDDER = Symbol('EMBEDDER');
export const TAXONOMY = Symbol('TAXONOMY');
export const WEIGHTS_SOURCE = Symbol('WEIGHTS_SOURCE');
export const LEXICAL_INDEX = Symbol('LEXICAL_INDEX');
export const MATCH_CACHE = Symbol('MATCH_CACHE');
export const MATCHING_LOGGER = Symbol('MATCHING_LOGGER');
export const MATCHING_SETTINGS = Symbol('MATCHING_SETTINGS');

export interface MatchingSettings {
  /** Result cache lifetime per (requisition, calibration, weights_version); 0 disables it. */
  cacheTtlSeconds: number;
  annChunks: number;
  lexicalTop: number;
}

export const DEFAULT_MATCHING_SETTINGS: MatchingSettings = {
  cacheTtlSeconds: 600,
  annChunks: 500,
  lexicalTop: 200,
};

/** A dependency is down (taxonomy, parsing-svc, llm-gateway, tenant-svc). Retry later. */
export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export interface RequisitionRepository {
  insert(tx: Tx, r: Requisition): Promise<void>;
  find(tx: Tx, id: string, options?: { forUpdate?: boolean }): Promise<Requisition | null>;
  list(
    tx: Tx,
    query: { limit: number; status?: RequisitionStatus; after?: { createdAt: Date; id: string } },
  ): Promise<Requisition[]>;
  /** Compare-and-set on version; false when someone else changed it. */
  update(tx: Tx, r: Requisition, expectedVersion: number): Promise<boolean>;
  saveEmbedding(
    tx: Tx,
    r: Requisition,
    model: string,
    sha256: string,
    vector: number[],
  ): Promise<void>;
  embedding(tx: Tx, id: string, model: string): Promise<number[] | null>;
  scorable(tx: Tx): Promise<Calibrated[]>;
  byJobProfile(tx: Tx, jobProfileId: string): Promise<Requisition[]>;
  setLexicalMax(tx: Tx, id: string, max: number): Promise<void>;
  lexicalMax(tx: Tx, id: string): Promise<number>;
}

export interface FeatureRepository {
  upsertProfile(tx: Tx, f: Omit<CandidateFeatures, 'skills'>): Promise<void>;
  upsertSkills(
    tx: Tx,
    tenantId: string,
    candidateId: string,
    skills: CandidateSkillFeature[],
  ): Promise<void>;
  get(tx: Tx, candidateIds: string[]): Promise<Map<string, CandidateFeatures>>;
  delete(tx: Tx, candidateId: string): Promise<number>;
}

export interface CandidateMatchRow {
  requisition_id: string;
  title: string;
  status: RequisitionStatus;
  score: number;
  band: string;
  components: unknown;
  explanation: unknown;
  weights_version: string;
  computed_at: string;
}

export interface ScoreRepository {
  /** Replaces the requisition's scores with exactly these (full re-ranking). */
  replaceForRequisition(
    tx: Tx,
    tenantId: string,
    requisitionId: string,
    scored: ScoredCandidate[],
    weightsVersion: string,
    at: Date,
  ): Promise<void>;
  upsert(
    tx: Tx,
    tenantId: string,
    requisitionId: string,
    scored: ScoredCandidate,
    weightsVersion: string,
    at: Date,
  ): Promise<void>;
  forCandidate(tx: Tx, candidateId: string, limit: number): Promise<CandidateMatchRow[]>;
  deleteCandidate(tx: Tx, candidateId: string): Promise<number>;
}

export interface WorkItem {
  tenantId: string;
  kind: 'candidate' | 'requisition';
  subjectId: string;
  reason: string;
  attempts: number;
}

export interface WorkQueue {
  enqueue(tx: Tx, item: Omit<WorkItem, 'attempts'>): Promise<void>;
  /** System transaction: removes and returns up to `limit` items (oldest first). */
  claim(tx: Tx, limit: number): Promise<WorkItem[]>;
  /** Puts a failed item back (coalescing with newer work for the same subject). */
  retry(tx: Tx, item: WorkItem): Promise<void>;
  deleteSubject(tx: Tx, subjectId: string): Promise<number>;
}

export interface ChunkHit {
  candidateId: string;
  chunkType: string;
  score: number;
  vector: number[] | null;
}

/** parsing-svc's resume_embeddings index (HNSW ANN, tenant-scoped by RLS there). */
export interface VectorSearch {
  activeModel(): Promise<string>;
  ann(tenantId: string, vector: number[], model: string, k: number): Promise<ChunkHit[]>;
  /** Each named candidate's `perCandidate` closest chunks, with vectors (for SEM). */
  closestChunks(
    tenantId: string,
    vector: number[],
    model: string,
    candidateIds: string[],
    perCandidate: number,
  ): Promise<ChunkHit[]>;
}

export interface Embedder {
  embed(tenantId: string, text: string, model: string): Promise<number[]>;
}

export interface JobProfileSnapshot {
  version: number;
  title: string;
  skills: { skill_id: string; weight: number; target_proficiency: number; must_have: boolean }[];
}

export interface SkillSnapshot {
  name: string;
  related: { skill_id: string; rho: number }[];
}

export interface Taxonomy {
  jobProfile(tenantId: string, jobProfileId: string): Promise<JobProfileSnapshot | null>;
  skill(tenantId: string, skillId: string): Promise<SkillSnapshot | null>;
}

export interface WeightsSource {
  weights(tenantId: string): Promise<Weights>;
  evict(tenantId: string): void;
}

export interface LexicalHit {
  candidateId: string;
  bm25: number;
}

/** BM25 over candidate profile text: OpenSearch `t-{tenant}-profiles` or Postgres FTS. */
export interface LexicalIndex {
  search(
    tenantId: string,
    query: string,
    options: { k: number; candidateIds?: string[] },
  ): Promise<LexicalHit[]>;
  /** CDC: keep the index in step with the read model. */
  upsert(features: CandidateFeatures): Promise<void>;
  remove(tenantId: string, candidateId: string): Promise<void>;
  dropTenant(tenantId: string): Promise<void>;
}

export interface MatchCache {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttlSeconds: number): void;
  evictPrefix(prefix: string): void;
}

export type { Calibration };
