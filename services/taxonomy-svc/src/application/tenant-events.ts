import { Inject, Injectable } from '@nestjs/common';
import { TenantPurged } from '@atlas/contracts';
import { type EventHandler, setTenantContext } from '@atlas/platform';
import { type Logger } from 'pino';
import { PURGE_REPOSITORY, type PurgeRepository } from './ports';

export const TAXONOMY_CONSUMER = 'taxonomy-svc.tenant-lifecycle';
export const TAXONOMY_LOGGER = Symbol('TAXONOMY_LOGGER');

/** Tenant purge removes every overlay, custom skill, edge, job profile and import of the tenant. */
@Injectable()
export class TenantEventHandlers {
  constructor(
    @Inject(PURGE_REPOSITORY) private readonly purge: PurgeRepository,
    @Inject(TAXONOMY_LOGGER) private readonly logger: Logger | null,
  ) {}

  handlers(): Record<string, EventHandler> {
    return {
      [TenantPurged.topic]: async (tx, event) => {
        const tenantId = (event.payload as { tenant_id: string }).tenant_id;
        await setTenantContext(tx, tenantId);
        const removed = await this.purge.purgeTenant(tx);
        this.logger?.info({ tenant_id: tenantId, removed }, 'tenant taxonomy purged');
        return undefined;
      },
    };
  }
}
