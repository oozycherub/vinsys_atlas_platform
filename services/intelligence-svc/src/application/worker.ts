import { Inject, Injectable } from '@nestjs/common';
import { type Logger } from 'pino';
import {
  CLOCK,
  type Clock,
  DATABASE,
  type Database,
  withSystemTx,
  withTenantTx,
} from '@atlas/platform';
import { Matcher } from './matcher';
import {
  INTEL_LOGGER,
  INTEL_SETTINGS,
  type IntelSettings,
  WORK_QUEUE,
  type WorkItem,
  type WorkQueue,
} from './ports';

const MAX_BACKOFF_MS = 5 * 60_000;

/** Drains the incremental work queue (coalesced per subject): rankings and employee re-scores. */
@Injectable()
export class IntelWorker {
  private stopped = false;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WORK_QUEUE) private readonly work: WorkQueue,
    @Inject(INTEL_SETTINGS) private readonly settings: IntelSettings,
    @Inject(INTEL_LOGGER) private readonly logger: Logger | null,
    private readonly matcher: Matcher,
  ) {}

  async process(item: WorkItem): Promise<void> {
    if (item.kind === 'opportunity')
      await this.matcher.rankOpportunity(item.tenantId, item.subjectId);
    else await this.matcher.rescoreEmployee(item.tenantId, item.subjectId);
  }

  /** One pass; returns how many items were processed (failures are retried with backoff). */
  async runOnce(): Promise<number> {
    const now = this.clock.now();
    const items = await withSystemTx(this.db, (tx) =>
      this.work.due(tx, this.settings.workBatch, now),
    );
    let done = 0;
    for (const item of items) {
      try {
        await this.process(item);
        await withTenantTx(this.db, item.tenantId, (tx) => this.work.done(tx, item));
        done += 1;
      } catch (error) {
        const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (item.attempts ?? 0));
        this.logger?.warn(
          { kind: item.kind, error: (error as Error).message },
          'intelligence work failed; retrying',
        );
        await withTenantTx(this.db, item.tenantId, (tx) =>
          this.work.retry(tx, item, new Date(this.clock.now().getTime() + delay)),
        );
      }
    }
    return done;
  }

  /* c8 ignore start - process loop */
  async runForever(): Promise<void> {
    while (!this.stopped) {
      const n = await this.runOnce().catch((error: unknown) => {
        this.logger?.error({ error: (error as Error).message }, 'work pass failed');
        return 0;
      });
      if (n === 0) await new Promise((r) => setTimeout(r, this.settings.workPollMs));
    }
  }

  stop(): void {
    this.stopped = true;
  }
  /* c8 ignore stop */
}
