import { Inject, Injectable } from '@nestjs/common';
import { type Logger } from 'pino';
import { DATABASE, type Database, withSystemTx, withTenantTx } from '@atlas/platform';
import { MatchService } from './match.service';
import {
  MATCHING_LOGGER,
  REQUISITION_REPOSITORY,
  type RequisitionRepository,
  type WorkItem,
  WORK_QUEUE,
  type WorkQueue,
} from './ports';
import { RequisitionService } from './requisition.service';

export const MAX_ATTEMPTS = 5;

/** Drains match_work: incremental re-scoring of candidates, re-calibration and re-ranking of requisitions. */
@Injectable()
export class RescoreWorker {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(WORK_QUEUE) private readonly work: WorkQueue,
    @Inject(REQUISITION_REPOSITORY) private readonly requisitions: RequisitionRepository,
    private readonly matches: MatchService,
    private readonly requisitionService: RequisitionService,
    @Inject(MATCHING_LOGGER) private readonly logger: Logger | null,
  ) {}

  /** Processes up to `limit` items; returns how many succeeded. */
  async drain(limit = 50): Promise<number> {
    const items = await withSystemTx(this.db, (tx) => this.work.claim(tx, limit));
    let done = 0;
    for (const item of items) {
      try {
        await this.run(item);
        done += 1;
      } catch (error) {
        const attempts = item.attempts + 1;
        this.logger?.warn(
          {
            err: error,
            tenant_id: item.tenantId,
            kind: item.kind,
            subject_id: item.subjectId,
            attempts,
          },
          'rescoring failed',
        );
        if (attempts < MAX_ATTEMPTS) {
          await withSystemTx(this.db, (tx) => this.work.retry(tx, { ...item, attempts }));
        } else {
          this.logger?.error(
            { tenant_id: item.tenantId, subject_id: item.subjectId },
            'rescoring dropped',
          );
        }
      }
    }
    return done;
  }

  async drainAll(): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await this.drain();
      total += n;
      if (n === 0) return total;
    }
  }

  async runForever(intervalMs = 1000): Promise<never> {
    for (;;) {
      try {
        await this.drain();
      } catch (error) {
        this.logger?.error({ err: error }, 'rescoring loop failed');
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  private async run(item: WorkItem): Promise<void> {
    if (item.kind === 'candidate') {
      await this.matches.rescoreCandidate(item.tenantId, item.subjectId);
      return;
    }
    const r = await withTenantTx(this.db, item.tenantId, (tx) =>
      this.requisitions.find(tx, item.subjectId),
    );
    if (!r || r.status === 'closed') return;
    if (item.reason === 'job_profile_updated') {
      // calibrateFor queues a 'calibrated' item, which re-ranks with the new snapshot.
      await this.requisitionService.calibrateFor(item.tenantId, r.id);
      return;
    }
    await this.matches.rescoreRequisition(item.tenantId, r.id);
  }
}
