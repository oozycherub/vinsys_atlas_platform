import { Inject, Injectable } from '@nestjs/common';
import {
  BadRequestError,
  DATABASE,
  type Database,
  newId,
  NotFoundError,
  type Principal,
  withTenantTx,
} from '@atlas/platform';
import { parseCsv, parseDemandRows, records, type RowError } from '../domain/demand';
import { MANAGERS, requireRole, tenantOf } from './access';
import {
  CATALOGUE_REPOSITORY,
  type CatalogueRepository,
  DEMAND_REPOSITORY,
  DEMAND_SHEETS,
  type DemandRepository,
  type DemandSheets,
  INTEL_SETTINGS,
  type IntelSettings,
} from './ports';

/**
 * Capture Demand and Fulfilment Plans (PRD §2.5(iv)). Uploads are parsed here; plans are solved
 * by intelligence-ml (OR-Tools CP-SAT), which claims the queued plan (ADR-0009 §5).
 */
@Injectable()
export class DemandService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(DEMAND_REPOSITORY) private readonly demands: DemandRepository,
    @Inject(CATALOGUE_REPOSITORY) private readonly catalogue: CatalogueRepository,
    @Inject(DEMAND_SHEETS) private readonly sheets: DemandSheets,
    @Inject(INTEL_SETTINGS) private readonly settings: IntelSettings,
  ) {}

  async upload(p: Principal, tenant: string | undefined, fileName: string, content: Buffer) {
    requireRole(p, MANAGERS);
    const tenantId = tenantOf(p, tenant);
    if (content.byteLength === 0 || content.byteLength > this.settings.maxUploadBytes)
      throw new BadRequestError(
        'FILE_SIZE',
        `The file must be 1 byte to ${this.settings.maxUploadBytes} bytes.`,
      );
    let table: string[][];
    try {
      table = /\.xlsx$/i.test(fileName)
        ? await this.sheets.rows(fileName, content)
        : parseCsv(content.toString('utf8'));
    } catch {
      throw new BadRequestError(
        'UNREADABLE_FILE',
        'The file is not a readable .csv or .xlsx sheet.',
      );
    }
    const rows = records(table);
    const parsed = parseDemandRows(rows);
    const batchId = newId();
    return withTenantTx(this.db, tenantId, async (tx) => {
      const errors: RowError[] = [...parsed.errors];
      let loaded = 0;
      for (const [i, d] of parsed.demands.entries()) {
        let skills = d.skills;
        if (skills.length === 0 && d.job_profile_id) {
          skills = (await this.catalogue.profile(tx, d.job_profile_id))?.skills ?? [];
          if (skills.length === 0) {
            errors.push({
              row: i + 1,
              message: `job profile ${d.job_profile_id} is not known; give skills`,
            });
            continue;
          }
        }
        await this.demands.upsertDemand(tx, batchId, newId(), { ...d, skills });
        loaded += 1;
      }
      const status = loaded > 0 ? 'processed' : 'failed';
      await this.demands.insertBatch(tx, {
        id: batchId,
        fileName,
        status,
        rowsTotal: rows.length,
        rowsLoaded: loaded,
        errors,
        by: p.subject,
      });
      return { batch_id: batchId, status, rows_total: rows.length, rows_loaded: loaded, errors };
    });
  }

  async batch(p: Principal, tenant: string | undefined, id: string) {
    requireRole(p, MANAGERS);
    const b = await withTenantTx(this.db, tenantOf(p, tenant), (tx) => this.demands.batch(tx, id));
    if (!b) throw new NotFoundError('BATCH_NOT_FOUND', 'Batch not found.');
    return b;
  }

  async list(
    p: Principal,
    tenant: string | undefined,
    filter: { status?: string; accountId?: string; batchId?: string },
  ) {
    requireRole(p, MANAGERS);
    return {
      demands: await withTenantTx(this.db, tenantOf(p, tenant), (tx) =>
        this.demands.list(tx, filter),
      ),
    };
  }

  /** Queues a plan (a queued or running plan for the same account is returned instead). */
  async compute(
    p: Principal,
    tenant: string | undefined,
    accountId: string | null,
    horizonDays: number,
  ) {
    requireRole(p, MANAGERS);
    const queued = await withTenantTx(this.db, tenantOf(p, tenant), (tx) =>
      this.demands.queuePlan(tx, { id: newId(), accountId, horizonDays, by: p.subject }),
    );
    return { plan_id: queued.id, status: 'queued', created: queued.created };
  }

  async plan(p: Principal, tenant: string | undefined, id: string) {
    requireRole(p, MANAGERS);
    return withTenantTx(this.db, tenantOf(p, tenant), async (tx) => {
      const plan = await this.demands.plan(tx, id);
      if (!plan) throw new NotFoundError('PLAN_NOT_FOUND', 'Plan not found.');
      return {
        ...plan,
        lines: plan['status'] === 'done' ? await this.demands.planLines(tx, id) : [],
      };
    });
  }
}
