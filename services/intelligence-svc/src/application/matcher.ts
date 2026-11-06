import { Inject, Injectable } from '@nestjs/common';
import { type Logger } from 'pino';
import { CLOCK, type Clock, DATABASE, type Database, type Tx, withTenantTx } from '@atlas/platform';
import { type AvailabilityInput, monthsBetween } from '../domain/availability';
import { type EmployeeSkill, matchEmployee } from '../domain/marketplace';
import { MAX_MATCHES } from '../domain/opportunity';
import { readiness } from '../domain/readiness';
import {
  CATALOGUE_REPOSITORY,
  type CatalogueRepository,
  EMBEDDER,
  type Embedder,
  type Employee,
  EMPLOYEE_REPOSITORY,
  type EmployeeRepository,
  INTEL_LOGGER,
  INTEL_SETTINGS,
  type IntelSettings,
  type MatchRow,
  type Opportunity,
  OPPORTUNITY_REPOSITORY,
  type OpportunityRepository,
  PROJECT_REPOSITORY,
  type ProjectRepository,
  TAXONOMY,
  type Taxonomy,
  VECTOR_SEARCH,
  type VectorSearch,
} from './ports';

const DIMENSIONS = ['department', 'job_profile', 'location'] as const;
const today = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The marketplace's incremental engine (PRD §2.5(c) steps 2-4). Remote calls (embeddings, the
 * vector index, the skill graph) happen between transactions, never inside one.
 */
@Injectable()
export class Matcher {
  private readonly relatedCache = new Map<string, { skillId: string; rho: number }[]>();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(EMPLOYEE_REPOSITORY) private readonly employees: EmployeeRepository,
    @Inject(CATALOGUE_REPOSITORY) private readonly catalogue: CatalogueRepository,
    @Inject(OPPORTUNITY_REPOSITORY) private readonly opportunities: OpportunityRepository,
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(VECTOR_SEARCH) private readonly vectors: VectorSearch,
    @Inject(EMBEDDER) private readonly embedder: Embedder,
    @Inject(TAXONOMY) private readonly taxonomy: Taxonomy,
    @Inject(INTEL_SETTINGS) private readonly settings: IntelSettings,
    @Inject(INTEL_LOGGER) private readonly logger: Logger | null,
  ) {}

  // --- gaps and the heat-map ------------------------------------------------------------------

  /** Recomputes an employee's role gap and the heat-map cells of their old and new groups. */
  async refreshGaps(tx: Tx, employeeId: string): Promise<void> {
    const e = await this.employees.get(tx, employeeId);
    const previous = await this.employees.roleGap(tx, employeeId);
    const profile =
      e?.status === 'active' && e.jobProfileId
        ? await this.catalogue.profile(tx, e.jobProfileId)
        : null;
    const groups = new Map<(typeof DIMENSIONS)[number], Set<string>>(
      DIMENSIONS.map((d) => [d, new Set()]),
    );
    const note = (
      row: { department: string | null; location: string | null; jobProfileId: string } | null,
    ) => {
      if (!row) return;
      if (row.department) groups.get('department')?.add(row.department);
      if (row.location) groups.get('location')?.add(row.location);
      groups.get('job_profile')?.add(row.jobProfileId);
    };
    note(previous);
    if (e && profile) {
      const skills = (await this.employees.skills(tx, [employeeId])).get(employeeId) ?? [];
      const fit = readiness(profile.skills, new Map(skills.map((s) => [s.skillId, s.proficiency])));
      const row = {
        employeeId,
        jobProfileId: profile.jobProfileId,
        roleGapPct: fit.roleGapPct,
        readiness: fit.readiness,
        gaps: fit.gaps,
        department: e.department,
        location: e.location,
      };
      await this.employees.saveRoleGap(tx, row, this.clock.now());
      note(row);
    } else if (previous) {
      await this.employees.deleteRoleGap(tx, employeeId);
    }
    for (const [dimension, keys] of groups)
      if (keys.size > 0) await this.employees.refreshGaps(tx, dimension, [...keys]);
  }

  // --- matching ---------------------------------------------------------------------------------

  private async related(tenantId: string, skillIds: readonly string[]) {
    const out = new Map<string, { skillId: string; rho: number }[]>();
    for (const id of skillIds) {
      const key = `${tenantId}:${id}`;
      if (!this.relatedCache.has(key)) {
        try {
          this.relatedCache.set(key, await this.taxonomy.related(tenantId, id));
        } catch {
          this.relatedCache.set(key, []); // the skill graph is a bonus, never a blocker
        }
      }
      out.set(id, this.relatedCache.get(key) ?? []);
    }
    return out;
  }

  /** The opportunity's requirement vector (embedded once, stored with it). */
  private async embedding(o: Opportunity): Promise<{ vector: number[]; model: string } | null> {
    try {
      const model = await this.vectors.activeModel();
      if (o.embedding && o.embeddingModel === model) return { vector: o.embedding, model };
      const text = [o.title, o.description].filter(Boolean).join('\n\n');
      return { vector: await this.embedder.embed(o.tenantId, text, model), model };
    } catch (error) {
      this.logger?.warn(
        { error: (error as Error).message },
        'embedding unavailable: ranking without SEM',
      );
      return null;
    }
  }

  private async chunks(
    tenantId: string,
    vector: number[] | null,
    model: string,
    ids: string[],
  ): Promise<Map<string, number[][]>> {
    const out = new Map<string, number[][]>();
    if (!vector || ids.length === 0) return out;
    try {
      for (const hit of await this.vectors.closestChunks(tenantId, vector, model, ids, 3)) {
        if (hit.vector) out.set(hit.candidateId, [...(out.get(hit.candidateId) ?? []), hit.vector]);
      }
    } catch (error) {
      this.logger?.warn(
        { error: (error as Error).message },
        'vector index unavailable: ranking without SEM',
      );
    }
    return out;
  }

  private score(
    o: Opportunity,
    e: Employee,
    skills: Map<string, EmployeeSkill>,
    allocations: AvailabilityInput['allocations'],
    related: Map<string, { skillId: string; rho: number }[]>,
    chunks: number[][] | undefined,
    job: number[] | null,
    requisitionScore: number | null,
  ): MatchRow {
    const now = this.clock.now();
    const m = matchEmployee({
      requirements: o.skills,
      related,
      skills,
      semantic: job && chunks ? { chunks, job } : null,
      availability: {
        allocations,
        window: { start: o.startDate, end: o.endDate },
        requiredPercent: o.allocationPct,
        tenureInRoleMonths: e.roleStartedAt ? monthsBetween(e.roleStartedAt, today(now)) : null,
        minTenureMonths: o.minTenureMonths,
        optedIn: e.marketplaceOptIn,
        opportunityType: o.type,
      },
      requisitionScore,
      sourceSyncedAt: e.sourceSyncedAt,
      now,
    });
    return {
      employeeId: e.employeeId,
      score: m.score,
      availability: m.availability,
      scoreInternal: m.scoreInternal,
      readiness: m.readiness,
      explanation: m.explanation as unknown as Record<string, unknown>,
      lowConfidence: m.lowConfidence,
      stale: m.stale,
      computedAt: now,
    };
  }

  private async inputs(tx: Tx, employees: Employee[]) {
    const ids = employees.map((e) => e.employeeId);
    const skillRows = await this.employees.skills(tx, ids);
    const skills = new Map(
      [...skillRows].map(([id, rows]) => [
        id,
        new Map(
          rows.map((r) => [r.skillId, { proficiency: r.proficiency, validated: r.validated }]),
        ),
      ]),
    );
    const allocations = await this.projects.allocations(tx, ids);
    return { skills, allocations };
  }

  /** Ranks every eligible employee for an opportunity and keeps the top 200 (step 2). */
  async rankOpportunity(tenantId: string, opportunityId: string): Promise<number> {
    const o = await withTenantTx(this.db, tenantId, (tx) =>
      this.opportunities.get(tx, opportunityId),
    );
    if (!o) return 0;
    if (o.status !== 'open') {
      await withTenantTx(this.db, tenantId, (tx) =>
        this.opportunities.replaceMatches(tx, o.id, []),
      );
      return 0;
    }
    const emb = await this.embedding(o);
    const related = await this.related(
      tenantId,
      o.skills.map((s) => s.skill_id),
    );
    let eligible = await withTenantTx(this.db, tenantId, (tx) => this.employees.active(tx));
    eligible = eligible.filter((e) => e.marketplaceOptIn || o.type === 'project');
    if (eligible.length > this.settings.annThreshold && emb) {
      // Pre-filter large workforces: ANN over profile chunks (tenant-scoped), plus everyone who
      // holds a required skill, so employees without embeddings (cold start, PRD §2.5d) still
      // match on skills. Then structured rescoring of that pool.
      const near = new Set<string>();
      try {
        const hits = await this.vectors.ann(
          tenantId,
          emb.vector,
          emb.model,
          this.settings.annCandidates,
        );
        for (const h of hits) near.add(h.candidateId);
      } catch (error) {
        this.logger?.warn(
          { error: (error as Error).message },
          'ANN unavailable: skill pre-filter only',
        );
      }
      const skilled = await withTenantTx(this.db, tenantId, (tx) =>
        this.employees.withAnySkill(
          tx,
          o.skills.map((s) => s.skill_id),
        ),
      );
      eligible = eligible.filter((e) => near.has(e.employeeId) || skilled.has(e.employeeId));
    }
    const ids = eligible.map((e) => e.employeeId);
    const chunks = await this.chunks(tenantId, emb?.vector ?? null, emb?.model ?? '', ids);
    return withTenantTx(this.db, tenantId, async (tx) => {
      const { skills, allocations } = await this.inputs(tx, eligible);
      const reqScores = o.requisitionId
        ? await this.employees.requisitionScores(tx, o.requisitionId)
        : new Map<string, number>();
      const rows = eligible
        .map((e) =>
          this.score(
            o,
            e,
            skills.get(e.employeeId) ?? new Map(),
            allocations.get(e.employeeId) ?? [],
            related,
            chunks.get(e.employeeId),
            emb?.vector ?? null,
            reqScores.get(e.employeeId) ?? null,
          ),
        )
        .sort((a, b) => b.scoreInternal - a.scoreInternal || b.score - a.score)
        .slice(0, MAX_MATCHES);
      if (emb && (o.embeddingModel !== emb.model || !o.embedding))
        await this.opportunities.update(tx, o.id, o.version, {
          embedding: emb.vector,
          embeddingModel: emb.model,
        });
      await this.opportunities.replaceMatches(tx, o.id, rows);
      return rows.length;
    });
  }

  /** Re-scores one employee against every open opportunity (skills or allocations changed). */
  async rescoreEmployee(tenantId: string, employeeId: string): Promise<number> {
    const loaded = await withTenantTx(this.db, tenantId, async (tx) => {
      await this.refreshGaps(tx, employeeId);
      const e = await this.employees.get(tx, employeeId);
      return { e, open: e?.status === 'active' ? await this.opportunities.open(tx) : [] };
    });
    const { e, open } = loaded;
    if (!e || e.status !== 'active') {
      await withTenantTx(this.db, tenantId, async (tx) => {
        for (const o of await this.opportunities.open(tx))
          await this.opportunities.upsertMatch(tx, o.id, null, employeeId);
      });
      return 0;
    }
    const model = await this.vectors.activeModel().catch(() => '');
    const semantic = new Map<string, number[][] | undefined>();
    for (const o of open) {
      if (o.embedding && o.embeddingModel === model)
        semantic.set(
          o.id,
          (await this.chunks(tenantId, o.embedding, model, [employeeId])).get(employeeId),
        );
    }
    const related = new Map<string, Map<string, { skillId: string; rho: number }[]>>();
    for (const o of open)
      related.set(
        o.id,
        await this.related(
          tenantId,
          o.skills.map((s) => s.skill_id),
        ),
      );
    return withTenantTx(this.db, tenantId, async (tx) => {
      const { skills, allocations } = await this.inputs(tx, [e]);
      let n = 0;
      for (const o of open) {
        const eligible = e.marketplaceOptIn || o.type === 'project';
        const req = o.requisitionId
          ? (await this.employees.requisitionScores(tx, o.requisitionId)).get(employeeId)
          : undefined;
        const row = eligible
          ? this.score(
              o,
              e,
              skills.get(employeeId) ?? new Map(),
              allocations.get(employeeId) ?? [],
              related.get(o.id) ?? new Map(),
              semantic.get(o.id),
              o.embedding && o.embeddingModel === model ? o.embedding : null,
              req ?? null,
            )
          : null;
        await this.opportunities.upsertMatch(tx, o.id, row, employeeId);
        if (row) n += 1;
      }
      return n;
    });
  }
}
