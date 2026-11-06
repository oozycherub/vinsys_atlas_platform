import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { RequisitionCalibrated } from '@atlas/contracts';
import {
  appendOutbox,
  CLOCK,
  type Clock,
  DATABASE,
  type Database,
  DomainRuleError,
  hashRequest,
  newId,
  NotFoundError,
  PreconditionFailedError,
  type Principal,
  runIdempotent,
  ServiceUnavailableError,
  setTenantContext,
  type Tx,
  withTenantTx,
} from '@atlas/platform';
import { MAX_RELATED_RHO } from '@atlas/scoring';
import {
  applyPatch,
  type Calibration,
  type CalibrationSkill,
  embeddedText,
  lexicalQuery,
  type Requisition,
  type RequisitionPatch,
  type RequisitionStatus,
} from '../domain/requisition';
import { tenantOf } from './access';
import {
  EMBEDDER,
  type Embedder,
  REQUISITION_REPOSITORY,
  type RequisitionRepository,
  TAXONOMY,
  type Taxonomy,
  UpstreamError,
  VECTOR_SEARCH,
  type VectorSearch,
  WORK_QUEUE,
  type WorkQueue,
} from './ports';
import { type RequisitionView, toRequisitionView } from './views';

export interface CreateRequisitionInput {
  tenant_id?: string | undefined;
  title: string;
  description: string;
  openings: number;
  location: string | null;
  hiring_manager_id: string | null;
  job_profile_id: string | null;
  min_experience_years: number | null;
  keywords: string[];
}

export interface ManualSkill {
  skill_id: string;
  weight: number;
  target: number;
  must_have: boolean;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

const encodeCursor = (r: Requisition): string =>
  Buffer.from(JSON.stringify([r.createdAt.toISOString(), r.id])).toString('base64url');

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as [string, string];
    const createdAt = new Date(at);
    if (Number.isNaN(createdAt.getTime()) || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('bad');
    return { createdAt, id };
  } catch {
    throw new DomainRuleError('INVALID_CURSOR', 'The cursor is not valid.');
  }
}

async function upstream<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof UpstreamError)
      throw new ServiceUnavailableError('DEPENDENCY_UNAVAILABLE', error.message);
    throw error;
  }
}

@Injectable()
export class RequisitionService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(REQUISITION_REPOSITORY) private readonly requisitions: RequisitionRepository,
    @Inject(TAXONOMY) private readonly taxonomy: Taxonomy,
    @Inject(VECTOR_SEARCH) private readonly vectors: VectorSearch,
    @Inject(EMBEDDER) private readonly embedder: Embedder,
    @Inject(WORK_QUEUE) private readonly work: WorkQueue,
  ) {}

  async create(
    principal: Principal,
    input: CreateRequisitionInput,
    idempotencyKey: string,
  ): Promise<{ status: number; body: RequisitionView; replayed: boolean }> {
    const tenantId = tenantOf(principal, input.tenant_id);
    const id = newId();
    return runIdempotent(
      this.db,
      {
        scope: `matching-svc:${tenantId}:${principal.subject}`,
        key: idempotencyKey,
        requestHash: hashRequest('POST', '/v1/job-requisitions', input),
      },
      async (tx) => {
        await setTenantContext(tx, tenantId);
        const now = this.clock.now();
        const r: Requisition = {
          tenantId,
          id,
          title: input.title,
          description: input.description,
          openings: input.openings,
          location: input.location,
          hiringManagerId: input.hiring_manager_id,
          jobProfileId: input.job_profile_id,
          minExperienceYears: input.min_experience_years,
          keywords: input.keywords,
          status: 'open',
          calibrationStatus: 'uncalibrated',
          calibration: null,
          calibrationVersion: 0,
          calibratedAt: null,
          version: 1,
          createdBy: principal.subject,
          createdAt: now,
          updatedAt: now,
        };
        await this.requisitions.insert(tx, r);
        return { status: 201, body: toRequisitionView(r) };
      },
    );
  }

  async get(principal: Principal, id: string, tenant?: string): Promise<RequisitionView> {
    const tenantId = tenantOf(principal, tenant);
    return withTenantTx(this.db, tenantId, async (tx) =>
      toRequisitionView(await this.load(tx, id)),
    );
  }

  async list(
    principal: Principal,
    query: {
      tenant_id?: string | undefined;
      limit: number;
      cursor?: string | undefined;
      status?: RequisitionStatus | undefined;
    },
  ): Promise<Page<RequisitionView>> {
    const tenantId = tenantOf(principal, query.tenant_id);
    const rows = await withTenantTx(this.db, tenantId, (tx) =>
      this.requisitions.list(tx, {
        limit: query.limit + 1,
        ...(query.status ? { status: query.status } : {}),
        ...(query.cursor ? { after: decodeCursor(query.cursor) } : {}),
      }),
    );
    const page = rows.slice(0, query.limit);
    return {
      items: page.map(toRequisitionView),
      next_cursor:
        rows.length > query.limit && page.length ? encodeCursor(page.at(-1) as Requisition) : null,
    };
  }

  async patch(
    principal: Principal,
    id: string,
    patch: RequisitionPatch,
    expectedVersion: number,
    tenant?: string,
  ): Promise<RequisitionView> {
    const tenantId = tenantOf(principal, tenant);
    return withTenantTx(this.db, tenantId, async (tx) => {
      const current = await this.load(tx, id, true);
      if (current.version !== expectedVersion) {
        throw new PreconditionFailedError(
          'VERSION_MISMATCH',
          'The requisition changed; reload it.',
        );
      }
      const next = { ...applyPatch(current, patch), version: current.version + 1 };
      await this.requisitions.update(tx, next, current.version);
      return toRequisitionView(next);
    });
  }

  /**
   * Snapshots the requirements (job profile or a manual list), the related-skill weights ρ from
   * the skill graph, and ē_j; then queues a full ranking (candidate rediscovery).
   */
  async calibrate(
    principal: Principal,
    id: string,
    manual: ManualSkill[] | undefined,
    tenant?: string,
  ): Promise<RequisitionView> {
    return this.calibrateFor(tenantOf(principal, tenant), id, manual);
  }

  async calibrateFor(
    tenantId: string,
    id: string,
    manual?: ManualSkill[],
  ): Promise<RequisitionView> {
    const current = await withTenantTx(this.db, tenantId, (tx) => this.load(tx, id));
    if (current.status === 'closed') {
      throw new DomainRuleError('REQUISITION_CLOSED', 'A closed requisition cannot be calibrated.');
    }
    const calibration = await upstream(() => this.buildCalibration(current, manual));
    const vector = await upstream(() =>
      this.embedder.embed(tenantId, calibration.embedded_text, calibration.embedding_model),
    );
    return withTenantTx(this.db, tenantId, async (tx) => {
      const fresh = await this.load(tx, id, true);
      const next: Requisition = {
        ...fresh,
        calibration,
        calibrationStatus: 'calibrated',
        calibrationVersion: fresh.calibrationVersion + 1,
        calibratedAt: this.clock.now(),
        version: fresh.version + 1,
      };
      await this.requisitions.update(tx, next, fresh.version);
      await this.requisitions.saveEmbedding(
        tx,
        next,
        calibration.embedding_model,
        sha256(calibration.embedded_text),
        vector,
      );
      await appendOutbox(
        tx,
        RequisitionCalibrated.build({
          tenantId,
          aggregateId: id,
          payload: {
            tenant_id: tenantId,
            requisition_id: id,
            job_profile_id: next.jobProfileId,
            job_profile_version: calibration.job_profile_version,
            required_skills: calibration.skills.length,
            calibration_version: next.calibrationVersion,
            occurred_at: this.clock.now().toISOString(),
          },
        }),
      );
      await this.work.enqueue(tx, {
        tenantId,
        kind: 'requisition',
        subjectId: id,
        reason: 'calibrated',
      });
      return toRequisitionView(next);
    });
  }

  private async buildCalibration(
    r: Requisition,
    manual: ManualSkill[] | undefined,
  ): Promise<Calibration> {
    let source: Calibration['source'] = 'manual';
    let profileVersion: number | null = null;
    let wanted: ManualSkill[];
    if (manual && manual.length) {
      wanted = manual;
    } else if (r.jobProfileId) {
      const profile = await this.taxonomy.jobProfile(r.tenantId, r.jobProfileId);
      if (!profile)
        throw new DomainRuleError(
          'JOB_PROFILE_NOT_FOUND',
          'The linked job profile does not exist.',
        );
      source = 'job_profile';
      profileVersion = profile.version;
      wanted = profile.skills.map((s) => ({
        skill_id: s.skill_id,
        weight: s.weight,
        target: s.target_proficiency,
        must_have: s.must_have,
      }));
    } else {
      throw new DomainRuleError(
        'NO_REQUIREMENTS',
        'Link a job profile or pass the required skills to calibrate.',
      );
    }
    const skills: CalibrationSkill[] = await Promise.all(
      wanted.map(async (s) => {
        const detail = await this.taxonomy.skill(r.tenantId, s.skill_id);
        return {
          ...s,
          name: detail?.name ?? null,
          related: (detail?.related ?? [])
            .filter((x) => x.skill_id !== s.skill_id)
            .map((x) => ({ skill_id: x.skill_id, rho: Math.min(MAX_RELATED_RHO, x.rho) })),
        };
      }),
    );
    const model = await this.vectors.activeModel();
    return {
      source,
      job_profile_version: profileVersion,
      skills,
      embedding_model: model,
      embedded_text: embeddedText(r, skills),
      lexical_query: lexicalQuery(r, skills),
    };
  }

  private async load(tx: Tx, id: string, forUpdate = false): Promise<Requisition> {
    const r = await this.requisitions.find(tx, id, { forUpdate });
    if (!r) throw new NotFoundError('REQUISITION_NOT_FOUND', 'No such requisition in this tenant.');
    return r;
  }
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
