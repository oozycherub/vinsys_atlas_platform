import { Inject, Injectable } from '@nestjs/common';
import { CandidateCreated, type CandidateSource } from '@atlas/contracts';
import {
  appendOutbox,
  CLOCK,
  type Clock,
  ConflictError,
  DATABASE,
  type Database,
  type FieldCipher,
  ForbiddenError,
  hashRequest,
  isUuid,
  newId,
  NotFoundError,
  type Principal,
  runIdempotent,
  setTenantContext,
  type Tx,
  ValidationError,
  withTenantTx,
} from '@atlas/platform';
import {
  assertVersion,
  type Candidate,
  type CandidateAttributes,
  createCandidate,
  patchCandidate,
} from '../domain/candidate';
import { mergePii, normalizeEmail, normalizePii, type Pii } from '../domain/pii';
import { canReadPii, canSee, tenantOf, translate } from './access';
import {
  CANDIDATE_REPOSITORY,
  type CandidateRepository,
  FIELD_CIPHER,
  type PiiColumns,
} from './ports';
import { type CandidateView, toCandidateView } from './views';

export interface PiiInput {
  full_name: string;
  email?: string | null | undefined;
  phone?: string | null | undefined;
  address?: string | null | undefined;
  dob?: string | null | undefined;
}

/** A partial PII update: omitted fields keep their stored value. */
export type PiiPatch = { [K in keyof PiiInput]?: PiiInput[K] | undefined };

const UNIQUE_VIOLATION = '23505';
export const piiAad = (candidateId: string): string[] => [candidateId, 'pii'];

/**
 * Candidate and employee profiles. PII is encrypted with the tenant DEK before it reaches the
 * database; email and phone get per-tenant HMAC blind indexes for exact-match lookup.
 */
@Injectable()
export class CandidateService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CANDIDATE_REPOSITORY) private readonly candidates: CandidateRepository,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Idempotent create. The response never contains decrypted PII, because idempotency records
   * store the response body in plaintext; the caller already has what it sent.
   */
  async create(
    principal: Principal,
    input: {
      tenantId?: string;
      source: CandidateSource;
      pii: PiiInput;
      attributes: CandidateAttributes;
    },
    idempotencyKey: string,
  ): Promise<{ status: number; body: CandidateView; replayed: boolean }> {
    const tenantId = tenantOf(principal, input.tenantId);
    const id = newId();
    const pii = await translate(() => Promise.resolve(normalizePii(input.pii)));
    const columns = await this.piiColumns(tenantId, id, pii);
    return runIdempotent(
      this.db,
      {
        scope: `profile-svc:${tenantId}:${principal.subject}`,
        key: idempotencyKey,
        requestHash: hashRequest('POST', '/v1/candidates', input),
      },
      (tx) =>
        translate(async () => {
          await setTenantContext(tx, tenantId);
          await this.assertEmailFree(tx, columns.emailBidx);
          const candidate = createCandidate({
            id,
            tenantId,
            source: input.source,
            attributes: input.attributes,
            now: this.clock.now(),
          });
          try {
            await this.candidates.insert(tx, candidate, columns);
          } catch (error) {
            if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
              await this.assertEmailFree(tx, columns.emailBidx);
              throw new ConflictError(
                'CANDIDATE_CONFLICT',
                'A candidate with this external_ref or user exists.',
              );
            }
            throw error;
          }
          await appendOutbox(
            tx,
            CandidateCreated.build({
              tenantId,
              aggregateId: id,
              payload: {
                tenant_id: tenantId,
                candidate_id: id,
                source: input.source,
                occurred_at: candidate.createdAt.toISOString(),
              },
            }),
          );
          return { status: 201, body: toCandidateView(candidate, null) };
        }),
    );
  }

  async get(principal: Principal, id: string, tenantHint?: string): Promise<CandidateView> {
    const tenantId = tenantOf(principal, tenantHint);
    return withTenantTx(this.db, tenantId, async (tx) => {
      const stored = await this.load(tx, principal, id);
      return this.view(principal, stored.candidate, stored.piiEnc);
    });
  }

  /** Exact email match through the blind index. Needs pii:read: it reveals that a person applied. */
  async findByEmail(
    principal: Principal,
    email: string,
    tenantHint?: string,
  ): Promise<CandidateView[]> {
    const tenantId = tenantOf(principal, tenantHint);
    if (!canReadPii(principal, { userId: null })) {
      throw new ForbiddenError('Looking candidates up by email requires pii:read.');
    }
    const normalized = await translate(() => Promise.resolve(normalizeEmail(email)));
    const bidx = await this.cipher.blindIndex(tenantId, 'email', normalized);
    return withTenantTx(this.db, tenantId, async (tx) => {
      const id = await this.candidates.findIdByEmailIndex(tx, bidx);
      const stored = id ? await this.candidates.find(tx, id) : null;
      return stored ? [await this.view(principal, stored.candidate, stored.piiEnc)] : [];
    });
  }

  async list(
    principal: Principal,
    query: { limit: number; cursor?: string },
    tenantHint?: string,
  ): Promise<{ items: CandidateView[]; next_cursor: string | null }> {
    const tenantId = tenantOf(principal, tenantHint);
    if (!canSee(principal, { userId: null }))
      throw new ForbiddenError('You can only see your own profile.');
    let after: { at: Date; id: string } | undefined;
    if (query.cursor) {
      try {
        const [at, cid] = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as [
          string,
          string,
        ];
        const date = new Date(at);
        if (Number.isNaN(date.getTime()) || !isUuid(cid)) throw new Error('bad');
        after = { at: date, id: cid };
      } catch {
        throw new ValidationError('The cursor is invalid.', [
          { path: 'query.cursor', message: 'Malformed cursor' },
        ]);
      }
    }
    // Lists never decrypt PII (one DEK operation per row would also miss the latency target).
    const rows = await withTenantTx(this.db, tenantId, (tx) =>
      this.candidates.list(tx, { limit: query.limit + 1, ...(after ? { after } : {}) }),
    );
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((c) => toCandidateView(c, null)),
      next_cursor:
        rows.length > query.limit && last
          ? Buffer.from(JSON.stringify([last.lastActivityAt.toISOString(), last.id])).toString(
              'base64url',
            )
          : null,
    };
  }

  async patch(
    principal: Principal,
    id: string,
    input: { pii?: PiiPatch; attributes: CandidateAttributes },
    ifMatch: number,
    tenantHint?: string,
  ): Promise<CandidateView> {
    const tenantId = tenantOf(principal, tenantHint);
    return withTenantTx(this.db, tenantId, (tx) =>
      translate(async () => {
        const stored = await this.load(tx, principal, id, true);
        assertVersion(stored.candidate, ifMatch);
        if (input.pii && !canReadPii(principal, stored.candidate)) {
          throw new ForbiddenError('Changing personal data requires pii:read.');
        }
        if (input.attributes.legalHold !== undefined && !principal.roles.includes('tenant_admin')) {
          throw new ForbiddenError('Only tenant admins set legal holds.');
        }
        let columns: PiiColumns | undefined;
        let pii: Pii | null = null;
        if (input.pii) {
          const current = await this.cipher.decryptJson<Pii>(tenantId, piiAad(id), stored.piiEnc);
          const changes = Object.fromEntries(
            Object.entries(input.pii).filter(([, v]) => v !== undefined),
          ) as Partial<Pii>;
          pii = mergePii(current, changes);
          columns = await this.piiColumns(tenantId, id, pii);
          if (pii.email !== current.email) await this.assertEmailFree(tx, columns.emailBidx, id);
        }
        const next = patchCandidate(stored.candidate, input.attributes, this.clock.now());
        if (!(await this.candidates.update(tx, next, stored.candidate.version, columns))) {
          throw new ConflictError('VERSION_MISMATCH', 'The candidate changed concurrently.');
        }
        return this.view(principal, next, columns?.piiEnc ?? stored.piiEnc, pii);
      }),
    );
  }

  /** Encrypts PII and computes blind indexes (outside any transaction when possible). */
  async piiColumns(tenantId: string, candidateId: string, pii: Pii): Promise<PiiColumns> {
    return {
      piiEnc: await this.cipher.encryptJson(tenantId, piiAad(candidateId), pii),
      emailBidx: pii.email ? await this.cipher.blindIndex(tenantId, 'email', pii.email) : null,
      phoneBidx: pii.phone ? await this.cipher.blindIndex(tenantId, 'phone', pii.phone) : null,
    };
  }

  async load(tx: Tx, principal: Principal, id: string, forUpdate = false) {
    const stored = isUuid(id) ? await this.candidates.find(tx, id, { forUpdate }) : null;
    // Not visible and not found answer the same, so candidate ids cannot be probed.
    if (!stored || !canSee(principal, stored.candidate)) {
      throw new NotFoundError('CANDIDATE_NOT_FOUND', 'Candidate not found.');
    }
    return stored;
  }

  private async view(principal: Principal, c: Candidate, piiEnc: Buffer, known: Pii | null = null) {
    if (!canReadPii(principal, c)) return toCandidateView(c, null);
    return toCandidateView(
      c,
      known ?? (await this.cipher.decryptJson<Pii>(c.tenantId, piiAad(c.id), piiEnc)),
    );
  }

  private async assertEmailFree(tx: Tx, emailBidx: Buffer | null, self?: string): Promise<void> {
    if (!emailBidx) return;
    const existing = await this.candidates.findIdByEmailIndex(tx, emailBidx);
    if (existing && existing !== self) {
      throw new ConflictError(
        'CANDIDATE_EMAIL_TAKEN',
        'A candidate with this email already exists.',
        {
          candidate_id: existing,
        },
      );
    }
  }
}
