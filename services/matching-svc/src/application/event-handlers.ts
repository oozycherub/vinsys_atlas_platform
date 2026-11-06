import { Inject, Injectable } from '@nestjs/common';
import { type Logger } from 'pino';
import {
  CandidateSkillsUpdated,
  ErasureAcknowledged,
  ErasureRequested,
  JobProfileUpdated,
  ResumeParsed,
  TenantPurged,
  TenantSettingsUpdated,
} from '@atlas/contracts';
import {
  appendOutbox,
  CLOCK,
  type Clock,
  type ConsumedEvent,
  type EventHandler,
  setTenantContext,
  type Tx,
} from '@atlas/platform';
import { evidenceSnippets, profileText } from '../domain/features';
import {
  FEATURE_REPOSITORY,
  type FeatureRepository,
  LEXICAL_INDEX,
  type LexicalIndex,
  MATCH_CACHE,
  type MatchCache,
  MATCHING_LOGGER,
  REQUISITION_REPOSITORY,
  type RequisitionRepository,
  SCORE_REPOSITORY,
  type ScoreRepository,
  WEIGHTS_SOURCE,
  type WeightsSource,
  WORK_QUEUE,
  type WorkQueue,
} from './ports';

export const MATCHING_CONSUMER = 'matching-svc.events';
export const SERVICE_NAME = 'matching-svc';

type Payload<T extends { schema: { _output: unknown } }> = T['schema']['_output'];

/**
 * Events matching-svc consumes (Component Prompt 07 §5). Handlers only update the read model and
 * queue work in the consumer's transaction; the re-scoring itself (HTTP calls to parsing-svc
 * and llm-gateway) runs in the worker, so a slow dependency never holds a transaction open.
 */
@Injectable()
export class MatchingEventHandlers {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(FEATURE_REPOSITORY) private readonly features: FeatureRepository,
    @Inject(SCORE_REPOSITORY) private readonly scores: ScoreRepository,
    @Inject(REQUISITION_REPOSITORY) private readonly requisitions: RequisitionRepository,
    @Inject(WORK_QUEUE) private readonly work: WorkQueue,
    @Inject(LEXICAL_INDEX) private readonly lexical: LexicalIndex,
    @Inject(WEIGHTS_SOURCE) private readonly weights: WeightsSource,
    @Inject(MATCH_CACHE) private readonly cache: MatchCache,
    @Inject(MATCHING_LOGGER) private readonly logger: Logger | null,
  ) {}

  handlers(): Record<string, EventHandler> {
    return {
      [ResumeParsed.topic]: (tx, e) => this.resumeParsed(tx, e),
      [CandidateSkillsUpdated.topic]: (tx, e) => this.skillsUpdated(tx, e),
      [JobProfileUpdated.topic]: (tx, e) => this.jobProfileUpdated(tx, e),
      [TenantSettingsUpdated.topic]: (tx, e) => this.settingsUpdated(tx, e),
      [ErasureRequested.topic]: (tx, e) => this.erasure(tx, e),
      [TenantPurged.topic]: (tx, e) => this.purged(tx, e),
    };
  }

  private async resumeParsed(tx: Tx, e: ConsumedEvent) {
    const p = e.payload as Payload<typeof ResumeParsed>;
    await setTenantContext(tx, p.tenant_id);
    const features = {
      tenantId: p.tenant_id,
      candidateId: p.candidate_id,
      evidence: evidenceSnippets(p.profile),
      totalExperienceMonths: p.total_experience_months,
      currentTitle: p.current_title,
      profileText: profileText(p.profile),
    };
    await this.features.upsertProfile(tx, features);
    await this.work.enqueue(tx, {
      tenantId: p.tenant_id,
      kind: 'candidate',
      subjectId: p.candidate_id,
      reason: 'resume_parsed',
    });
    // CDC into the lexical index (OpenSearch); at-most-once, re-sent on the next parse.
    const full = (await this.features.get(tx, [p.candidate_id])).get(p.candidate_id);
    return full ? () => this.lexical.upsert(full) : undefined;
  }

  private async skillsUpdated(tx: Tx, e: ConsumedEvent): Promise<undefined> {
    const p = e.payload as Payload<typeof CandidateSkillsUpdated>;
    await setTenantContext(tx, p.tenant_id);
    await this.features.upsertSkills(
      tx,
      p.tenant_id,
      p.candidate_id,
      p.skills.map((s) => ({
        skill_id: s.skill_id,
        proficiency: s.proficiency,
        is_validated: s.is_validated,
      })),
    );
    await this.work.enqueue(tx, {
      tenantId: p.tenant_id,
      kind: 'candidate',
      subjectId: p.candidate_id,
      reason: 'skills_updated',
    });
    return undefined;
  }

  /** A linked job profile changed: its requisitions are re-calibrated and re-ranked. */
  private async jobProfileUpdated(tx: Tx, e: ConsumedEvent): Promise<undefined> {
    const p = e.payload as Payload<typeof JobProfileUpdated>;
    await setTenantContext(tx, p.tenant_id);
    for (const r of await this.requisitions.byJobProfile(tx, p.job_profile_id)) {
      if (r.status === 'closed') continue;
      if (
        r.calibration?.source === 'job_profile' &&
        (r.calibration.job_profile_version ?? 0) >= p.version
      )
        continue;
      await this.work.enqueue(tx, {
        tenantId: p.tenant_id,
        kind: 'requisition',
        subjectId: r.id,
        reason: 'job_profile_updated',
      });
    }
    return undefined;
  }

  /** New matching weights: every open requisition is re-ranked under the new weights_version. */
  private async settingsUpdated(tx: Tx, e: ConsumedEvent): Promise<undefined> {
    const p = e.payload as Payload<typeof TenantSettingsUpdated>;
    if (!p.changed_keys.includes('matching')) return undefined;
    await setTenantContext(tx, p.tenant_id);
    this.weights.evict(p.tenant_id);
    this.cache.evictPrefix(`${p.tenant_id}:`);
    for (const r of await this.requisitions.scorable(tx)) {
      await this.work.enqueue(tx, {
        tenantId: p.tenant_id,
        kind: 'requisition',
        subjectId: r.id,
        reason: 'weights_changed',
      });
    }
    return undefined;
  }

  private async erasure(tx: Tx, e: ConsumedEvent) {
    const p = e.payload as Payload<typeof ErasureRequested>;
    await setTenantContext(tx, p.tenant_id);
    const removed = {
      scores: await this.scores.deleteCandidate(tx, p.candidate_id),
      features: await this.features.delete(tx, p.candidate_id),
      work: await this.work.deleteSubject(tx, p.candidate_id),
    };
    if (p.ack_required_from.includes(SERVICE_NAME)) {
      await appendOutbox(
        tx,
        ErasureAcknowledged.build({
          tenantId: p.tenant_id,
          aggregateId: p.request_id,
          payload: {
            tenant_id: p.tenant_id,
            request_id: p.request_id,
            service: SERVICE_NAME,
            occurred_at: this.clock.now().toISOString(),
          },
        }),
      );
    }
    this.logger?.info(
      { tenant_id: p.tenant_id, request_id: p.request_id, removed },
      'candidate erased',
    );
    return async () => {
      this.cache.evictPrefix(`${p.tenant_id}:`);
      await this.lexical.remove(p.tenant_id, p.candidate_id);
    };
  }

  private async purged(tx: Tx, e: ConsumedEvent) {
    const tenantId = (e.payload as { tenant_id: string }).tenant_id;
    await setTenantContext(tx, tenantId);
    for (const table of [
      'match_scores',
      'requisition_embeddings',
      'job_requisitions',
      'candidate_features',
      'match_work',
    ]) {
      await tx.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    }
    return async () => {
      this.cache.evictPrefix(`${tenantId}:`);
      this.weights.evict(tenantId);
      await this.lexical.dropTenant(tenantId);
    };
  }
}
