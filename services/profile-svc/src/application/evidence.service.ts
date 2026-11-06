import { Inject, Injectable } from '@nestjs/common';
import { CandidateSkillsUpdated, type SkillEvidenceSource } from '@atlas/contracts';
import {
  appendOutbox,
  CLOCK,
  type Clock,
  DATABASE,
  type Database,
  newId,
  NotFoundError,
  type Principal,
  ServiceUnavailableError,
  type Tx,
  withTenantTx,
} from '@atlas/platform';
import { assertEvidence, type EvidenceActor, type NewEvidence } from '../domain/evidence';
import { fuse } from '../domain/fusion';
import { evidenceActor, tenantOf, translate } from './access';
import { CandidateService } from './candidate.service';
import {
  type CurrentSkill,
  EVIDENCE_REPOSITORY,
  type EvidenceRepository,
  PROFILE_SETTINGS,
  type ProfileSettings,
  SKILL_CATALOG,
  type SkillCatalog,
} from './ports';
import { toEvidenceView, toSkillView } from './views';

export interface EvidenceInput {
  skillId: string;
  source: SkillEvidenceSource;
  proficiency: number;
  confidence: number;
  sourceRef?: string | null;
  reason?: string | null;
  observedAt?: Date;
  validUntil?: Date | null;
}

/**
 * The skill evidence ledger and the fused current proficiency (PRD §2.5(ii)). Every new record
 * recomputes only the affected (candidate, skill) pairs, in the same transaction, and emits
 * profile.candidate.skills_updated.v1 with the new values.
 */
@Injectable()
export class EvidenceService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(EVIDENCE_REPOSITORY) private readonly evidence: EvidenceRepository,
    @Inject(SKILL_CATALOG) private readonly catalog: SkillCatalog,
    @Inject(PROFILE_SETTINGS) private readonly settings: ProfileSettings,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly candidates: CandidateService,
  ) {}

  async record(
    principal: Principal,
    candidateId: string,
    inputs: readonly EvidenceInput[],
    tenantHint?: string,
  ) {
    const tenantId = tenantOf(principal, tenantHint);
    // Skills come from taxonomy-svc: unknown or hidden ids are refused, deprecated ones move to
    // their successor. Resolved before the transaction (it is an HTTP call).
    let resolved: Map<string, string | null>;
    try {
      resolved = await this.catalog.resolve(tenantId, [...new Set(inputs.map((i) => i.skillId))]);
    } catch {
      throw new ServiceUnavailableError(
        'TAXONOMY_UNAVAILABLE',
        'The skill catalogue is unavailable; retry shortly.',
      );
    }
    return withTenantTx(this.db, tenantId, (tx) =>
      translate(async () => {
        const { candidate } = await this.candidates.load(tx, principal, candidateId, true);
        const actor = evidenceActor(principal, candidate);
        const now = this.clock.now();
        const records: NewEvidence[] = inputs.map((i) => {
          const skillId = resolved.get(i.skillId);
          if (!skillId)
            throw new NotFoundError('SKILL_NOT_FOUND', `Skill ${i.skillId} is not available.`);
          return assertEvidence(
            {
              skillId,
              source: i.source,
              proficiency: i.proficiency,
              confidence: i.confidence,
              sourceRef: i.sourceRef ?? null,
              reason: i.reason ?? null,
              observedAt: i.observedAt ?? now,
              validUntil: i.validUntil ?? null,
            },
            actor,
            now,
          );
        });
        const updated = await this.recordAll(tx, tenantId, candidateId, records, principal.subject);
        return { skills: updated.map(toSkillView) };
      }),
    );
  }

  /**
   * Inserts evidence (skipping exact redeliveries), recomputes the touched skills and emits the
   * event. Shared by the HTTP path and the event consumers (assessments, parsed résumés).
   */
  async recordAll(
    tx: Tx,
    tenantId: string,
    candidateId: string,
    records: readonly NewEvidence[],
    recordedBy: string,
  ): Promise<CurrentSkill[]> {
    const touched = new Set<string>();
    for (const r of records) {
      const inserted = await this.evidence.insert(tx, tenantId, candidateId, {
        id: newId(),
        skillId: r.skillId,
        source: r.source,
        proficiency: r.proficiency,
        confidence: r.confidence,
        observedAt: r.observedAt,
        validUntil: r.validUntil,
        sourceRef: r.sourceRef,
        reason: r.reason,
        recordedBy,
      });
      if (inserted) touched.add(r.skillId);
    }
    const updated = await this.recompute(tx, tenantId, candidateId, [...touched]);
    if (updated.length > 0) {
      await appendOutbox(
        tx,
        CandidateSkillsUpdated.build({
          tenantId,
          aggregateId: candidateId,
          payload: {
            tenant_id: tenantId,
            candidate_id: candidateId,
            skills: updated.map((s) => ({
              skill_id: s.skillId,
              proficiency: s.proficiency,
              is_validated: s.isValidated,
              calibration_needed: s.calibrationNeeded,
            })),
            occurred_at: this.clock.now().toISOString(),
          },
        }),
      );
    }
    return updated;
  }

  /** Incremental fusion: one (candidate, skill) at a time from its full evidence history. */
  async recompute(
    tx: Tx,
    tenantId: string,
    candidateId: string,
    skillIds: readonly string[],
  ): Promise<CurrentSkill[]> {
    const now = this.clock.now();
    const out: CurrentSkill[] = [];
    for (const skillId of skillIds) {
      const fused = fuse(
        await this.evidence.forSkill(tx, candidateId, skillId),
        now,
        this.settings.fusionPolicy,
      );
      if (!fused) {
        await this.evidence.deleteCurrent(tx, candidateId, skillId);
        continue;
      }
      const current: CurrentSkill = { ...fused, skillId, computedAt: now };
      await this.evidence.upsertCurrent(tx, tenantId, candidateId, current);
      out.push(current);
    }
    return out;
  }

  async skills(
    principal: Principal,
    candidateId: string,
    includeEvidence: boolean,
    tenantHint?: string,
  ) {
    const tenantId = tenantOf(principal, tenantHint);
    return withTenantTx(this.db, tenantId, async (tx) => {
      await this.candidates.load(tx, principal, candidateId);
      const current = await this.evidence.currentFor(tx, candidateId);
      return {
        candidate_id: candidateId,
        skills: current.map(toSkillView),
        ...(includeEvidence
          ? { evidence: (await this.evidence.forCandidate(tx, candidateId)).map(toEvidenceView) }
          : {}),
      };
    });
  }
}

export type { EvidenceActor };
