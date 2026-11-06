import { Inject, Injectable } from '@nestjs/common';
import { type Logger } from 'pino';
import { CandidateRescored } from '@atlas/contracts';
import {
  appendOutbox,
  CLOCK,
  type Clock,
  DATABASE,
  type Database,
  DomainRuleError,
  NotFoundError,
  type Principal,
  ServiceUnavailableError,
  type Tx,
  withTenantTx,
} from '@atlas/platform';
import { type Band, type CandidateSkill, InvalidWeightsError, type Weights } from '@atlas/scoring';
import { type CandidateFeatures, yearsOf } from '../domain/features';
import { type Calibrated, isCalibrated, isScorable, requirements } from '../domain/requisition';
import { type ScoredCandidate, scoreCandidate, toScored, weightsVersion } from '../domain/score';
import { tenantOf } from './access';
import {
  type CandidateMatchRow,
  type ChunkHit,
  EMBEDDER,
  type Embedder,
  FEATURE_REPOSITORY,
  type FeatureRepository,
  LEXICAL_INDEX,
  type LexicalIndex,
  MATCH_CACHE,
  type MatchCache,
  MATCHING_LOGGER,
  MATCHING_SETTINGS,
  type MatchingSettings,
  REQUISITION_REPOSITORY,
  type RequisitionRepository,
  SCORE_REPOSITORY,
  type ScoreRepository,
  UpstreamError,
  VECTOR_SEARCH,
  type VectorSearch,
  WEIGHTS_SOURCE,
  type WeightsSource,
} from './ports';
import { sha256 } from './requisition.service';

export interface MatchFilters {
  min_score?: number | undefined;
  bands?: Band[] | undefined;
  exclude_candidate_ids?: string[] | undefined;
}

export interface MatchResponse {
  requisition_id: string;
  weights_version: string;
  calibration_version: number;
  computed_at: string;
  cached: boolean;
  total: number;
  results: ScoredCandidate[];
}

interface Ranking {
  weightsVersion: string;
  calibrationVersion: number;
  computedAt: string;
  scored: ScoredCandidate[];
}

/** Re-ranking never looks at more than this many candidates (ANN 500 ∪ BM25 200). */
const MAX_POOL = 700;
const CHUNK_BATCH = 1000;

function toSkills(f: CandidateFeatures | undefined): Map<string, CandidateSkill> {
  return new Map(
    (f?.skills ?? []).map((s) => [
      s.skill_id,
      { proficiency: s.proficiency, validated: s.is_validated },
    ]),
  );
}

@Injectable()
export class MatchService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(REQUISITION_REPOSITORY) private readonly requisitions: RequisitionRepository,
    @Inject(FEATURE_REPOSITORY) private readonly features: FeatureRepository,
    @Inject(SCORE_REPOSITORY) private readonly scores: ScoreRepository,
    @Inject(VECTOR_SEARCH) private readonly vectors: VectorSearch,
    @Inject(EMBEDDER) private readonly embedder: Embedder,
    @Inject(LEXICAL_INDEX) private readonly lexical: LexicalIndex,
    @Inject(WEIGHTS_SOURCE) private readonly weightsSource: WeightsSource,
    @Inject(MATCH_CACHE) private readonly cache: MatchCache,
    @Inject(MATCHING_SETTINGS) private readonly settings: MatchingSettings,
    @Inject(MATCHING_LOGGER) private readonly logger: Logger | null,
  ) {}

  /** `POST /v1/job-requisitions/{id}:match`: two-stage retrieval, re-ranking, explanations. */
  async match(
    principal: Principal,
    requisitionId: string,
    body: { tenant_id?: string | undefined; limit: number; filters: MatchFilters },
  ): Promise<MatchResponse> {
    const tenantId = tenantOf(principal, body.tenant_id);
    const r = await withTenantTx(this.db, tenantId, (tx) =>
      this.requisitions.find(tx, requisitionId),
    );
    if (!r) throw new NotFoundError('REQUISITION_NOT_FOUND', 'No such requisition in this tenant.');
    if (r.status === 'closed')
      throw new DomainRuleError('REQUISITION_CLOSED', 'The requisition is closed.');
    if (!isCalibrated(r)) {
      throw new DomainRuleError(
        'REQUISITION_NOT_CALIBRATED',
        'Calibrate the requisition before matching.',
      );
    }
    const weights = await this.weights(tenantId);
    const version = weightsVersion(weights);
    const key = `${tenantId}:${r.id}:${r.calibrationVersion}:${version}`;
    let ranking = this.cache.get<Ranking>(key);
    const cached = ranking !== undefined;
    if (!ranking) {
      ranking = await this.rank(r, weights);
      if (this.settings.cacheTtlSeconds > 0)
        this.cache.set(key, ranking, this.settings.cacheTtlSeconds);
    }
    const f = body.filters;
    const excluded = new Set(f.exclude_candidate_ids ?? []);
    const filtered = ranking.scored.filter(
      (s) =>
        !excluded.has(s.candidate_id) &&
        (f.min_score === undefined || s.score >= f.min_score) &&
        (!f.bands?.length || f.bands.includes(s.band)),
    );
    return {
      requisition_id: r.id,
      weights_version: ranking.weightsVersion,
      calibration_version: ranking.calibrationVersion,
      computed_at: ranking.computedAt,
      cached,
      total: filtered.length,
      results: filtered.slice(0, body.limit),
    };
  }

  /**
   * Full ranking of one requisition (also candidate rediscovery after calibration):
   * (1) HNSW ANN top-500 chunks ∪ BM25 top-200; (2) the formula on ≤ 700 candidates. The stored
   * scores for the requisition become exactly this set.
   */
  async rank(r: Calibrated, weights?: Weights): Promise<Ranking> {
    const w = weights ?? (await this.weights(r.tenantId));
    const version = weightsVersion(w);
    const calibration = r.calibration;
    const model = await this.upstream(() => this.vectors.activeModel());
    const job = await this.jobEmbedding(r, model);

    const [ann, lex] = await Promise.all([
      this.upstream(() => this.vectors.ann(r.tenantId, job, model, this.settings.annChunks)),
      this.upstream(() =>
        this.lexical.search(r.tenantId, calibration.lexical_query, { k: this.settings.lexicalTop }),
      ),
    ]);
    const pool = [
      ...new Set([...ann.map((h) => h.candidateId), ...lex.map((h) => h.candidateId)]),
    ].slice(0, MAX_POOL);
    const at = this.clock.now();
    if (pool.length === 0) {
      await withTenantTx(this.db, r.tenantId, (tx) =>
        this.scores.replaceForRequisition(tx, r.tenantId, r.id, [], version, at),
      );
      return {
        weightsVersion: version,
        calibrationVersion: r.calibrationVersion,
        computedAt: at.toISOString(),
        scored: [],
      };
    }

    const chunks: ChunkHit[] = [];
    for (let i = 0; i < pool.length; i += CHUNK_BATCH) {
      const ids = pool.slice(i, i + CHUNK_BATCH);
      chunks.push(
        ...(await this.upstream(() => this.vectors.closestChunks(r.tenantId, job, model, ids, 3))),
      );
    }
    // LEX is normalised by the best BM25 in the result set, so every pool member needs its BM25.
    const bm25 = await this.upstream(() =>
      this.lexical.search(r.tenantId, calibration.lexical_query, {
        k: pool.length,
        candidateIds: pool,
      }),
    );
    const bm25By = new Map(bm25.map((h) => [h.candidateId, h.bm25]));
    const maxBm25 = Math.max(0, ...bm25By.values());

    const scored = await withTenantTx(this.db, r.tenantId, async (tx) => {
      const features = await this.features.get(tx, pool);
      const out = pool.map((candidateId) =>
        this.scoreOne(
          r,
          job,
          w,
          candidateId,
          chunks,
          features.get(candidateId),
          bm25By.get(candidateId) ?? 0,
          maxBm25,
        ),
      );
      out.sort((a, b) => b.score - a.score || (a.candidate_id < b.candidate_id ? -1 : 1));
      await this.scores.replaceForRequisition(tx, r.tenantId, r.id, out, version, at);
      await this.requisitions.setLexicalMax(tx, r.id, maxBm25);
      return out;
    });
    this.logger?.info(
      {
        tenant_id: r.tenantId,
        requisition_id: r.id,
        pool: pool.length,
        ann: ann.length,
        lexical: lex.length,
      },
      'requisition ranked',
    );
    return {
      weightsVersion: version,
      calibrationVersion: r.calibrationVersion,
      computedAt: at.toISOString(),
      scored,
    };
  }

  /** Re-ranks a requisition from the work queue and drops its cached results. */
  async rescoreRequisition(tenantId: string, requisitionId: string): Promise<void> {
    const r = await withTenantTx(this.db, tenantId, (tx) =>
      this.requisitions.find(tx, requisitionId),
    );
    if (!r || !isScorable(r)) return;
    this.cache.evictPrefix(`${tenantId}:${r.id}:`);
    await this.rank(r);
  }

  /**
   * Incremental re-scoring of one candidate against every open, calibrated requisition (after
   * a parsed résumé or new skill evidence); announces the new scores.
   */
  async rescoreCandidate(tenantId: string, candidateId: string): Promise<number> {
    const weights = await this.weights(tenantId);
    const version = weightsVersion(weights);
    const model = await this.upstream(() => this.vectors.activeModel());
    const { reqs, features } = await withTenantTx(this.db, tenantId, async (tx) => ({
      reqs: await this.requisitions.scorable(tx),
      features: (await this.features.get(tx, [candidateId])).get(candidateId),
    }));
    if (!features || reqs.length === 0) return 0;
    const results: { r: Calibrated; scored: ScoredCandidate }[] = [];
    for (const r of reqs) {
      const job = await this.jobEmbedding(r, model);
      const chunks = await this.upstream(() =>
        this.vectors.closestChunks(tenantId, job, model, [candidateId], 3),
      );
      const [hit] = await this.upstream(() =>
        this.lexical.search(tenantId, r.calibration.lexical_query, {
          k: 1,
          candidateIds: [candidateId],
        }),
      );
      const bm25 = hit?.bm25 ?? 0;
      const storedMax = await withTenantTx(this.db, tenantId, (tx) =>
        this.requisitions.lexicalMax(tx, r.id),
      );
      results.push({
        r,
        scored: this.scoreOne(
          r,
          job,
          weights,
          candidateId,
          chunks,
          features,
          bm25,
          Math.max(storedMax, bm25),
        ),
      });
    }
    const at = this.clock.now();
    await withTenantTx(this.db, tenantId, async (tx) => {
      for (const { r, scored } of results)
        await this.scores.upsert(tx, tenantId, r.id, scored, version, at);
      await appendOutbox(
        tx,
        CandidateRescored.build({
          tenantId,
          aggregateId: candidateId,
          payload: {
            tenant_id: tenantId,
            candidate_id: candidateId,
            weights_version: version,
            scores: results.map(({ r, scored }) => ({
              requisition_id: r.id,
              score: scored.score,
              band: scored.band,
            })),
            occurred_at: at.toISOString(),
          },
        }),
      );
    });
    for (const { r } of results) this.cache.evictPrefix(`${tenantId}:${r.id}:`);
    return results.length;
  }

  async candidateMatches(
    principal: Principal,
    candidateId: string,
    query: { tenant_id?: string | undefined; limit: number },
  ): Promise<{ candidate_id: string; items: CandidateMatchRow[] }> {
    const tenantId = tenantOf(principal, query.tenant_id);
    const items = await withTenantTx(this.db, tenantId, (tx: Tx) =>
      this.scores.forCandidate(tx, candidateId, query.limit),
    );
    return { candidate_id: candidateId, items };
  }

  private scoreOne(
    r: Calibrated,
    job: number[],
    weights: Weights,
    candidateId: string,
    chunks: ChunkHit[],
    features: CandidateFeatures | undefined,
    bm25: number,
    maxBm25: number,
  ): ScoredCandidate {
    const own = chunks.filter((c) => c.candidateId === candidateId && c.vector);
    const result = scoreCandidate(
      {
        chunks: own.flatMap((c) => (c.vector ? [c.vector] : [])),
        jobEmbedding: job,
        requirements: requirements(r.calibration),
        skills: toSkills(features),
        requiredYears: r.minExperienceYears,
        candidateYears: features ? yearsOf(features) : null,
        bm25,
        maxBm25,
      },
      weights,
    );
    return toScored(
      candidateId,
      result,
      features?.evidence ?? {},
      own.sort((a, b) => b.score - a.score).map((c) => c.chunkType),
    );
  }

  /** ē_j for the active model; re-embedded once if the model changed since calibration. */
  private async jobEmbedding(r: Calibrated, model: string): Promise<number[]> {
    const stored = await withTenantTx(this.db, r.tenantId, (tx) =>
      this.requisitions.embedding(tx, r.id, model),
    );
    if (stored) return stored;
    const text = r.calibration.embedded_text;
    const vector = await this.upstream(() => this.embedder.embed(r.tenantId, text, model));
    await withTenantTx(this.db, r.tenantId, (tx) =>
      this.requisitions.saveEmbedding(tx, r, model, sha256(text), vector),
    );
    return vector;
  }

  private async weights(tenantId: string): Promise<Weights> {
    try {
      return await this.weightsSource.weights(tenantId);
    } catch (error) {
      if (error instanceof InvalidWeightsError) {
        // tenant-svc enforces the sum; a bad value here means its data is corrupt.
        throw new DomainRuleError('INVALID_WEIGHTS', error.message);
      }
      if (error instanceof UpstreamError)
        throw new ServiceUnavailableError('DEPENDENCY_UNAVAILABLE', error.message);
      throw error;
    }
  }

  private async upstream<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof UpstreamError)
        throw new ServiceUnavailableError('DEPENDENCY_UNAVAILABLE', error.message);
      throw error;
    }
  }
}
