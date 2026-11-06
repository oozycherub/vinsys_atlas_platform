import { Inject, Injectable } from '@nestjs/common';
import { ErasureCompleted, ErasureRequested } from '@atlas/contracts';
import {
  appendOutbox,
  CLOCK,
  type Clock,
  DATABASE,
  type Database,
  type FieldCipher,
  ForbiddenError,
  hasAnyRole,
  isUuid,
  newId,
  NotFoundError,
  type Principal,
  type Tx,
  withTenantTx,
} from '@atlas/platform';
import { type Pii } from '../domain/pii';
import {
  acknowledge,
  assertErasable,
  ERASURE_ACK_WINDOW_MS,
  type ErasureCertificate,
  isOverdue,
  type PrivacyRequest,
  retentionCutoff,
} from '../domain/privacy';
import { tenantOf, translate } from './access';
import { piiAad } from './candidate.service';
import {
  CANDIDATE_REPOSITORY,
  type CandidateRepository,
  DOCUMENT_REPOSITORY,
  type DocumentRepository,
  EVIDENCE_REPOSITORY,
  type EvidenceRepository,
  FIELD_CIPHER,
  OBJECT_STORAGE,
  type ObjectStorage,
  PRIVACY_REPOSITORY,
  type PrivacyRepository,
  PROFILE_SETTINGS,
  type ProfileSettings,
} from './ports';
import { toDocumentView, toEvidenceView, toPrivacyView, toSkillView } from './views';

const exportAad = (requestId: string): string[] => [requestId, 'export'];

/**
 * Data-subject requests (GDPR Art. 15 and 17, PRD §4.2). Access compiles an encrypted export.
 * Erasure deletes the objects, then the rows (cascade), tells every other service through
 * privacy.erasure.requested.v1, and completes with a certificate once each registered consumer
 * has acknowledged (privacy.erasure.acknowledged.v1), at the latest flagged overdue after 7 days.
 */
@Injectable()
export class PrivacyService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CANDIDATE_REPOSITORY) private readonly candidates: CandidateRepository,
    @Inject(EVIDENCE_REPOSITORY) private readonly evidence: EvidenceRepository,
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(PRIVACY_REPOSITORY) private readonly requests: PrivacyRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(PROFILE_SETTINGS) private readonly settings: ProfileSettings,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async request(
    principal: Principal,
    input: { type: 'access' | 'erasure'; candidateId: string },
    tenantHint?: string,
  ) {
    if (!hasAnyRole(principal, ['tenant_admin', 'super_admin'])) {
      throw new ForbiddenError('Privacy requests are handled by tenant admins.');
    }
    const tenantId = tenantOf(principal, tenantHint);
    return input.type === 'access'
      ? this.access(tenantId, input.candidateId, principal.subject)
      : this.erase(tenantId, input.candidateId, principal.subject, 'data_subject');
  }

  async get(principal: Principal, id: string, tenantHint?: string) {
    if (!hasAnyRole(principal, ['tenant_admin', 'super_admin'])) {
      throw new ForbiddenError('Privacy requests are handled by tenant admins.');
    }
    const tenantId = tenantOf(principal, tenantHint);
    const found = await withTenantTx(this.db, tenantId, (tx) =>
      isUuid(id) ? this.requests.find(tx, id) : Promise.resolve(null),
    );
    if (!found) throw new NotFoundError('PRIVACY_REQUEST_NOT_FOUND', 'Privacy request not found.');
    const exportData = found.exportEnc
      ? await this.cipher.decryptJson(tenantId, exportAad(found.request.id), found.exportEnc)
      : undefined;
    return toPrivacyView(found.request, exportData);
  }

  /** Art. 15: everything held about the person, encrypted at rest until fetched. */
  private async access(tenantId: string, candidateId: string, by: string) {
    return withTenantTx(this.db, tenantId, async (tx) => {
      const stored = isUuid(candidateId) ? await this.candidates.find(tx, candidateId) : null;
      if (!stored) throw new NotFoundError('CANDIDATE_NOT_FOUND', 'Candidate not found.');
      const c = stored.candidate;
      const exportData = {
        generated_at: this.clock.now().toISOString(),
        candidate_id: c.id,
        personal_data: await this.cipher.decryptJson<Pii>(tenantId, piiAad(c.id), stored.piiEnc),
        attributes: {
          source: c.source,
          external_ref: c.externalRef,
          current_title: c.currentTitle,
          department: c.department,
          location_country: c.locationCountry,
          total_experience_months: c.totalExperienceMonths,
          marketplace_opt_in: c.marketplaceOptIn,
          consent: c.consent,
          created_at: c.createdAt.toISOString(),
          last_activity_at: c.lastActivityAt.toISOString(),
        },
        profile: c.profile,
        skills: (await this.evidence.currentFor(tx, c.id)).map(toSkillView),
        evidence: (await this.evidence.forCandidate(tx, c.id)).map(toEvidenceView),
        documents: (await this.documents.forCandidate(tx, c.id)).map(toDocumentView),
      };
      const now = this.clock.now();
      const request: PrivacyRequest = {
        id: newId(),
        tenantId,
        candidateId: c.id,
        type: 'access',
        reason: 'data_subject',
        status: 'completed',
        requestedBy: by,
        ackRequiredFrom: [],
        acks: [],
        certificate: null,
        dueAt: null,
        createdAt: now,
        completedAt: now,
      };
      await this.requests.insert(
        tx,
        request,
        await this.cipher.encryptJson(tenantId, exportAad(request.id), exportData),
      );
      return toPrivacyView(request, exportData);
    });
  }

  /** Art. 17. Also used by the retention sweeper (reason "retention"). */
  async erase(
    tenantId: string,
    candidateId: string,
    by: string,
    reason: 'data_subject' | 'retention',
  ) {
    // 1. Objects first: if the database step then fails, a retry finds them already gone.
    const keys = await withTenantTx(this.db, tenantId, (tx) =>
      translate(async () => {
        const stored = isUuid(candidateId) ? await this.candidates.find(tx, candidateId) : null;
        if (!stored) throw new NotFoundError('CANDIDATE_NOT_FOUND', 'Candidate not found.');
        assertErasable(stored.candidate);
        return this.documents.keysForCandidate(tx, candidateId);
      }),
    );
    const objectsDeleted = await this.storage.delete(keys);

    // 2. Rows, request, certificate and the fan-out event in one transaction.
    return withTenantTx(this.db, tenantId, (tx) =>
      translate(async () => {
        const stored = await this.candidates.find(tx, candidateId, { forUpdate: true });
        if (!stored) throw new NotFoundError('CANDIDATE_NOT_FOUND', 'Candidate not found.');
        assertErasable(stored.candidate);
        const rows = await this.candidates.delete(tx, candidateId);
        const now = this.clock.now();
        const id = newId();
        const consumers = [...this.settings.erasureConsumers];
        const done = consumers.length === 0;
        const certificate: ErasureCertificate = {
          request_id: id,
          candidate_id: candidateId,
          reason,
          requested_at: now.toISOString(),
          requested_by: by,
          profile_deleted_at: now.toISOString(),
          rows_deleted: rows,
          objects_deleted: objectsDeleted,
          ack_required_from: consumers,
          acks: [],
          completed_at: done ? now.toISOString() : null,
        };
        const dueAt = new Date(now.getTime() + ERASURE_ACK_WINDOW_MS);
        const request: PrivacyRequest = {
          id,
          tenantId,
          candidateId,
          type: 'erasure',
          reason,
          status: done ? 'completed' : 'awaiting_acks',
          requestedBy: by,
          ackRequiredFrom: consumers,
          acks: [],
          certificate,
          dueAt,
          createdAt: now,
          completedAt: done ? now : null,
        };
        await this.requests.insert(tx, request, null);
        await appendOutbox(
          tx,
          ErasureRequested.build({
            tenantId,
            aggregateId: id,
            payload: {
              tenant_id: tenantId,
              request_id: id,
              candidate_id: candidateId,
              reason,
              ack_required_from: consumers,
              due_at: dueAt.toISOString(),
              occurred_at: now.toISOString(),
            },
          }),
        );
        if (done) await this.emitCompleted(tx, request);
        return toPrivacyView(request, undefined);
      }),
    );
  }

  /** Consumer side of privacy.erasure.acknowledged.v1, inside the consumer's transaction. */
  async acknowledged(tx: Tx, requestId: string, service: string): Promise<void> {
    const found = await this.requests.find(tx, requestId, { forUpdate: true });
    if (!found) return;
    const next = acknowledge(found.request, service, this.clock.now());
    if (next === found.request) return;
    await this.requests.update(tx, next);
    if (next.status === 'completed') await this.emitCompleted(tx, next);
  }

  /** Flags erasures whose acknowledgements did not all arrive within 7 days. */
  async sweepOverdue(principal: Principal, tenantHint?: string): Promise<{ overdue: string[] }> {
    const tenantId = tenantOf(principal, tenantHint);
    return withTenantTx(this.db, tenantId, async (tx) => {
      const now = this.clock.now();
      const late = (await this.requests.overdue(tx, now)).filter((r) => isOverdue(r, now));
      for (const r of late) await this.requests.update(tx, { ...r, status: 'overdue' });
      return { overdue: late.map((r) => r.id) };
    });
  }

  /** Erases candidates inactive past the retention period (employees and legal holds excluded). */
  async sweepRetention(
    principal: Principal,
    limit: number,
    tenantHint?: string,
  ): Promise<{ erased: string[] }> {
    const tenantId = tenantOf(principal, tenantHint);
    const cutoff = retentionCutoff(this.clock.now(), this.settings.retentionInactiveDays);
    const ids = await withTenantTx(this.db, tenantId, (tx) =>
      this.candidates.inactiveSince(tx, cutoff, limit),
    );
    const erased: string[] = [];
    for (const id of ids) {
      await this.erase(tenantId, id, 'retention-sweeper', 'retention');
      erased.push(id);
    }
    return { erased };
  }

  private async emitCompleted(tx: Tx, r: PrivacyRequest): Promise<void> {
    await appendOutbox(
      tx,
      ErasureCompleted.build({
        tenantId: r.tenantId,
        aggregateId: r.id,
        payload: {
          tenant_id: r.tenantId,
          request_id: r.id,
          candidate_id: r.candidateId,
          acks: [...r.acks],
          completed_at: (r.completedAt ?? this.clock.now()).toISOString(),
        },
      }),
    );
  }
}
