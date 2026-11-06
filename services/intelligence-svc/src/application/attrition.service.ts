import { Inject, Injectable } from '@nestjs/common';
import {
  CLOCK,
  type Clock,
  DATABASE,
  type Database,
  NotFoundError,
  type Principal,
  withTenantTx,
} from '@atlas/platform';
import { requireHrbp, tenantOf } from './access';
import { ATTRITION_REPOSITORY, type AttritionRepository } from './ports';

/**
 * Attrition alerts and scores for HRBPs (PRD §2.5(vi) governance). Every call needs the `hrbp`
 * scope, runs under the HRBP RLS policy, and is written to the audit log in the same
 * transaction; employees never reach these routes.
 */
@Injectable()
export class AttritionService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ATTRITION_REPOSITORY) private readonly attrition: AttritionRepository,
  ) {}

  private run<T>(
    p: Principal,
    tenant: string | undefined,
    action: string,
    target: string | null,
    work: (tx: Parameters<Parameters<typeof withTenantTx>[2]>[0]) => Promise<T>,
  ): Promise<T> {
    requireHrbp(p);
    return withTenantTx(this.db, tenantOf(p, tenant), async (tx) => {
      await this.attrition.asHrbp(tx);
      await this.attrition.audit(tx, p.subject, action, target);
      return work(tx);
    });
  }

  alerts(p: Principal, tenant: string | undefined, status: string | null, limit: number) {
    return this.run(p, tenant, 'attrition.alerts.list', status, async (tx) => ({
      alerts: await this.attrition.alerts(tx, status, limit),
    }));
  }

  acknowledge(p: Principal, tenant: string | undefined, alertId: string) {
    return this.run(p, tenant, 'attrition.alert.acknowledge', alertId, async (tx) => {
      if (!(await this.attrition.acknowledge(tx, alertId, p.subject, this.clock.now())))
        throw new NotFoundError('ALERT_NOT_FOUND', 'No open alert with this id.');
      return { alert_id: alertId, status: 'acknowledged' };
    });
  }

  employee(p: Principal, tenant: string | undefined, employeeId: string) {
    return this.run(p, tenant, 'attrition.employee.read', employeeId, async (tx) => ({
      employee_id: employeeId,
      scores: await this.attrition.scores(tx, employeeId, 12),
    }));
  }

  model(p: Principal, tenant: string | undefined) {
    return this.run(p, tenant, 'attrition.model.read', null, async (tx) => {
      const m = await this.attrition.activeModel(tx);
      if (!m)
        throw new NotFoundError(
          'MODEL_NOT_FOUND',
          'No attrition model has been trained for this tenant yet.',
        );
      return m;
    });
  }
}
