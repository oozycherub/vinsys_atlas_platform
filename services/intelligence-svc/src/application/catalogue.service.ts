import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE,
  type Database,
  newId,
  NotFoundError,
  type Principal,
  withTenantTx,
} from '@atlas/platform';
import { type LearningItem, type Transition } from '../domain/career';
import { ADMINS, requireRole, tenantOf, WORKFORCE } from './access';
import { CATALOGUE_REPOSITORY, type CatalogueRepository } from './ports';

/** Career-path edges (TRANSITIONS_TO) and the learning catalogue (an LMS integration feeds it). */
@Injectable()
export class CatalogueService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CATALOGUE_REPOSITORY) private readonly catalogue: CatalogueRepository,
  ) {}

  async transitions(p: Principal, tenant: string | undefined): Promise<Transition[]> {
    requireRole(p, WORKFORCE);
    return withTenantTx(this.db, tenantOf(p, tenant), (tx) => this.catalogue.transitions(tx));
  }

  async putTransition(
    p: Principal,
    tenant: string | undefined,
    t: Transition,
  ): Promise<Transition> {
    requireRole(p, ADMINS);
    await withTenantTx(this.db, tenantOf(p, tenant), (tx) => this.catalogue.putTransition(tx, t));
    return t;
  }

  async deleteTransition(
    p: Principal,
    tenant: string | undefined,
    from: string,
    to: string,
  ): Promise<void> {
    requireRole(p, ADMINS);
    const gone = await withTenantTx(this.db, tenantOf(p, tenant), (tx) =>
      this.catalogue.deleteTransition(tx, from, to),
    );
    if (!gone) throw new NotFoundError('TRANSITION_NOT_FOUND', 'No such transition.');
  }

  async learningItems(p: Principal, tenant: string | undefined): Promise<LearningItem[]> {
    requireRole(p, WORKFORCE);
    return withTenantTx(this.db, tenantOf(p, tenant), (tx) => this.catalogue.learningItems(tx));
  }

  async putLearningItem(
    p: Principal,
    tenant: string | undefined,
    input: Omit<LearningItem, 'item_id'> & {
      item_id?: string;
      provider: string | null;
      url: string | null;
      external_ref: string | null;
    },
  ): Promise<LearningItem> {
    requireRole(p, ADMINS);
    const item = { ...input, item_id: input.item_id ?? newId() };
    await withTenantTx(this.db, tenantOf(p, tenant), (tx) =>
      this.catalogue.putLearningItem(tx, item),
    );
    return item;
  }
}
