import { Inject, Injectable } from '@nestjs/common';
import {
  AssessmentSessionEvaluated,
  ErasureAcknowledged,
  FileQuarantined,
  ResumeParsed,
  ResumeParseFailed,
  TenantPurged,
} from '@atlas/contracts';
import {
  CLOCK,
  type Clock,
  type ConsumedEvent,
  type EventHandler,
  setTenantContext,
  type TenantKeyCache,
  type Tx,
} from '@atlas/platform';
import { type Logger } from 'pino';
import { applyParsedProfile } from '../domain/candidate';
import { ProfileDomainError } from '../domain/errors';
import { assertNoPii } from '../domain/pii';
import { tenantPrefix } from '../domain/documents';
import { EvidenceService } from './evidence.service';
import {
  CANDIDATE_REPOSITORY,
  type CandidateRepository,
  DOCUMENT_REPOSITORY,
  type DocumentRepository,
  OBJECT_STORAGE,
  type ObjectStorage,
  PROFILE_LOGGER,
  PURGE_REPOSITORY,
  type PurgeRepository,
} from './ports';
import { PrivacyService } from './privacy.service';

export const PROFILE_CONSUMER = 'profile-svc.events';
export const KEY_CACHE = Symbol('KEY_CACHE');

type Payload<T extends { schema: { _output: unknown } }> = T['schema']['_output'];

/** Events profile-svc consumes (docs/prompts/04-profile-svc.md §5). */
@Injectable()
export class ProfileEventHandlers {
  constructor(
    @Inject(CANDIDATE_REPOSITORY) private readonly candidates: CandidateRepository,
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(PURGE_REPOSITORY) private readonly purge: PurgeRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(KEY_CACHE) private readonly keyCache: Pick<TenantKeyCache, 'evict'> | null,
    @Inject(PROFILE_LOGGER) private readonly logger: Logger | null,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly evidence: EvidenceService,
    private readonly privacy: PrivacyService,
  ) {}

  handlers(): Record<string, EventHandler> {
    return {
      [ResumeParsed.topic]: (tx, e) => this.resumeParsed(tx, e),
      [ResumeParseFailed.topic]: (tx, e) => this.resumeParseFailed(tx, e),
      [FileQuarantined.topic]: (tx, e) => this.fileQuarantined(tx, e),
      [AssessmentSessionEvaluated.topic]: (tx, e) => this.assessmentEvaluated(tx, e),
      [ErasureAcknowledged.topic]: async (tx, e) => {
        const p = e.payload as Payload<typeof ErasureAcknowledged>;
        await setTenantContext(tx, p.tenant_id);
        await this.privacy.acknowledged(tx, p.request_id, p.service);
        return undefined;
      },
      [TenantPurged.topic]: (tx, e) => this.tenantPurged(tx, e),
    };
  }

  /** Parsed résumé: store the redacted snapshot, enrich the profile, add résumé evidence. */
  private async resumeParsed(tx: Tx, e: ConsumedEvent): Promise<undefined> {
    const p = e.payload as Payload<typeof ResumeParsed>;
    await setTenantContext(tx, p.tenant_id);
    const doc = await this.documents.find(tx, p.document_id, { forUpdate: true });
    const stored = await this.candidates.find(tx, p.candidate_id, { forUpdate: true });
    if (!doc || !stored) return undefined; // erased meanwhile
    try {
      assertNoPii(p.profile);
    } catch (error) {
      if (!(error instanceof ProfileDomainError)) throw error;
      // A parser bug must not put PII into the queryable profile, nor retry forever: fail the
      // document (visible to admins) and keep nothing from this result.
      await this.documents.setStatus(tx, doc.id, 'failed', {
        errorCode: 'pii_in_profile',
        flags: ['pii_in_profile'],
      });
      this.logger?.error(
        { tenant_id: p.tenant_id, document_id: doc.id },
        'parsed profile contained PII; discarded',
      );
      return undefined;
    }
    const now = this.clock.now();
    await this.documents.applyParsed(tx, doc.id, {
      parserVersion: p.parser_version,
      language: p.language,
      pageCount: p.page_count,
      flags: p.flags,
      parsedJson: p.profile,
      parsedAt: now,
    });
    const next = applyParsedProfile(
      stored.candidate,
      {
        profile: p.profile,
        currentTitle: p.current_title,
        totalExperienceMonths: p.total_experience_months,
      },
      now,
    );
    await this.candidates.update(tx, next, stored.candidate.version);
    await this.evidence.recordAll(
      tx,
      p.tenant_id,
      p.candidate_id,
      p.skills.map((s) => ({
        skillId: s.skill_id,
        source: 'resume_inference' as const,
        proficiency: s.proficiency,
        confidence: s.confidence,
        sourceRef: p.document_id,
        reason: null,
        observedAt: now,
        validUntil: null,
      })),
      `parsing-svc:${p.parser_version}`,
    );
    return undefined;
  }

  /**
   * Parse failed (parsing-svc). A document that already has a profile keeps it: a failed
   * re-parse must not hide a good earlier result.
   */
  private async resumeParseFailed(tx: Tx, e: ConsumedEvent): Promise<undefined> {
    const p = e.payload as Payload<typeof ResumeParseFailed>;
    await setTenantContext(tx, p.tenant_id);
    const doc = await this.documents.find(tx, p.document_id, { forUpdate: true });
    if (!doc || doc.status === 'parsed' || doc.status === 'quarantined') return undefined;
    await this.documents.setStatus(tx, doc.id, p.retryable ? 'failed_retryable' : 'failed', {
      errorCode: p.error_code,
    });
    return undefined;
  }

  /** The security gate moved the object to quarantine; the document can never be parsed. */
  private async fileQuarantined(tx: Tx, e: ConsumedEvent): Promise<undefined> {
    const p = e.payload as Payload<typeof FileQuarantined>;
    await setTenantContext(tx, p.tenant_id);
    const doc = await this.documents.find(tx, p.document_id, { forUpdate: true });
    if (!doc) return undefined;
    await this.documents.setStatus(tx, doc.id, 'quarantined', {
      errorCode: 'MALICIOUS_FILE',
      flags: [...new Set([...doc.flags, `quarantined:${p.reason}`])],
    });
    this.logger?.warn(
      { tenant_id: p.tenant_id, document_id: doc.id, reason: p.reason },
      'document quarantined by parsing-svc',
    );
    return undefined;
  }

  private async assessmentEvaluated(tx: Tx, e: ConsumedEvent): Promise<undefined> {
    const p = e.payload as Payload<typeof AssessmentSessionEvaluated>;
    await setTenantContext(tx, p.tenant_id);
    if (!(await this.candidates.find(tx, p.candidate_id))) return undefined;
    await this.evidence.recordAll(
      tx,
      p.tenant_id,
      p.candidate_id,
      p.skills.map((s) => ({
        skillId: s.skill_id,
        source: 'assessment' as const,
        proficiency: s.score,
        confidence: s.confidence,
        sourceRef: p.session_id,
        reason: null,
        observedAt: new Date(p.evaluated_at),
        validUntil: p.valid_until ? new Date(p.valid_until) : null,
      })),
      'assessment-svc',
    );
    return undefined;
  }

  /** Purge: every row (explicit tenant filter), every object under t/{tenant}/, cached keys. */
  private async tenantPurged(tx: Tx, e: ConsumedEvent) {
    const tenantId = (e.payload as { tenant_id: string }).tenant_id;
    await setTenantContext(tx, tenantId);
    const removed = await this.purge.purgeTenant(tx);
    this.logger?.info({ tenant_id: tenantId, removed }, 'tenant profiles purged');
    return async () => {
      const objects = await this.storage.deletePrefix(tenantPrefix(tenantId));
      this.keyCache?.evict(tenantId);
      this.logger?.info({ tenant_id: tenantId, objects }, 'tenant objects purged');
    };
  }
}
