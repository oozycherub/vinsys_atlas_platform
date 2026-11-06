import { Inject, Injectable } from '@nestjs/common';
import {
  SkillCreated,
  SkillDeprecated,
  type SkillClassification,
  type SkillNodeType,
  TaxonomyVersionPublished,
} from '@atlas/contracts';
import {
  appendOutbox,
  CLOCK,
  type Clock,
  ConflictError,
  DATABASE,
  type Database,
  DomainRuleError,
  isUuid,
  newId,
  NotFoundError,
  type Principal,
  ServiceUnavailableError,
  type Tx,
  ValidationError,
} from '@atlas/platform';
import { TaxonomyDomainError } from '../domain/errors';
import { assertPath, parentPath } from '../domain/paths';
import {
  assertVersion,
  assertWritable,
  buildOverride,
  createSkill,
  deprecateSkill,
  embeddingInputChanged,
  embeddingText,
  type OverrideInput,
  patchSkill,
  type Skill,
  type SkillPatch,
} from '../domain/skill';
import {
  EDGE_REPOSITORY,
  type EdgeRepository,
  type Embedding,
  EMBEDDING_PORT,
  type EmbeddingPort,
  OVERRIDE_REPOSITORY,
  type OverrideRepository,
  SKILL_REPOSITORY,
  type SkillEdge,
  type SkillRepository,
  VERSION_REPOSITORY,
  type VersionRepository,
  type View,
  type VisibleSkill,
} from './ports';
import { inScope, readScope, type Scope, writeScope } from './scope';
import { translate } from './translate';
import {
  decodeCursor,
  encodeCursor,
  type Page,
  type SkillDetailView,
  type SkillView,
  toDetailView,
  toSkillView,
} from './views';

export interface CreateSkillCommand {
  nodeType: SkillNodeType;
  path: string;
  name: string;
  description?: string | null;
  classification?: SkillClassification;
  aliases?: readonly string[];
  externalId?: string | null;
}

export interface ListSkillsQuery {
  path?: string;
  q?: string;
  classification?: SkillClassification;
  nodeType?: SkillNodeType;
  includeDeprecated: boolean;
  limit: number;
  cursor?: string;
}

const MAX_SUCCESSOR_HOPS = 10;
const UNIQUE_VIOLATION = '23505';

/** The skill graph: browse, curate (global or tenant), overlays, edges and publishing. */
@Injectable()
export class SkillService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SKILL_REPOSITORY) private readonly skills: SkillRepository,
    @Inject(EDGE_REPOSITORY) private readonly edges: EdgeRepository,
    @Inject(OVERRIDE_REPOSITORY) private readonly overrides: OverrideRepository,
    @Inject(VERSION_REPOSITORY) private readonly versions: VersionRepository,
    @Inject(EMBEDDING_PORT) private readonly embeddings: EmbeddingPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(
    principal: Principal,
    query: ListSkillsQuery,
    tenantHint?: string,
  ): Promise<Page<SkillView>> {
    const scope = readScope(principal, tenantHint);
    let after: { path: string; id: string } | undefined;
    if (query.cursor) {
      const parts = decodeCursor(query.cursor, 2);
      if (!parts?.[0] || !parts[1] || !isUuid(parts[1])) {
        throw new ValidationError('The cursor is invalid.', [
          { path: 'query.cursor', message: 'Malformed cursor' },
        ]);
      }
      after = { path: parts[0], id: parts[1] };
    }
    const rows = await inScope(this.db, scope, (tx) =>
      this.skills.list(tx, {
        view: scope.tenantId,
        ...(query.path ? { path: query.path } : {}),
        ...(query.q ? { q: query.q } : {}),
        ...(query.classification ? { classification: query.classification } : {}),
        ...(query.nodeType ? { nodeType: query.nodeType } : {}),
        includeDeprecated: query.includeDeprecated,
        limit: query.limit + 1,
        ...(after ? { after } : {}),
      }),
    );
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map(toSkillView),
      next_cursor: rows.length > query.limit && last ? encodeCursor([last.path, last.id]) : null,
    };
  }

  /** With ancestors, related skills and, for a deprecated skill, its active successor. */
  async get(principal: Principal, id: string, tenantHint?: string): Promise<SkillDetailView> {
    const scope = readScope(principal, tenantHint);
    return inScope(this.db, scope, async (tx) => {
      const skill = await this.visible(tx, scope.tenantId, id);
      const [ancestors, related, successor] = await Promise.all([
        this.skills.ancestors(tx, scope.tenantId, skill.path),
        this.edges.related(tx, scope.tenantId, skill.id),
        skill.deprecatedAt
          ? this.resolveSuccessor(tx, scope.tenantId, skill)
          : Promise.resolve(null),
      ]);
      return toDetailView(skill, ancestors, related, successor);
    });
  }

  async create(
    principal: Principal,
    command: CreateSkillCommand,
    tenantHint?: string,
  ): Promise<SkillView> {
    const scope = writeScope(principal, tenantHint);
    const embedding =
      command.nodeType === 'skill' ? await this.embed(command.name, command.description) : null;
    return inScope(this.db, scope, (tx) =>
      translate(async () => {
        const path = command.path.toLowerCase();
        assertPath(path, command.nodeType); // shape errors before lookups
        const parent = parentPath(path);
        const [parentNode] = parent
          ? await this.skills.findByPaths(tx, scope.tenantId, [parent])
          : [];
        const clash = (await this.skills.findByPaths(tx, scope.tenantId, [path]))[0];
        if (clash) {
          throw new ConflictError(
            'SKILL_PATH_TAKEN',
            clash.tenantId === null && scope.tenantId !== null
              ? `"${path}" is a global skill; adopt or override it instead.`
              : `A node already exists at "${path}".`,
          );
        }
        const skill = createSkill({
          id: newId(),
          tenantId: scope.tenantId,
          nodeType: command.nodeType,
          path,
          name: command.name,
          description: command.description ?? null,
          ...(command.classification ? { classification: command.classification } : {}),
          aliases: command.aliases ?? [],
          externalId: command.externalId ?? null,
          parent: parentNode ?? null,
          taxonomyVersion: await this.pendingVersion(tx, scope),
          now: this.clock.now(),
        });
        try {
          await this.skills.insert(tx, skill, embedding);
        } catch (error) {
          if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
            throw new ConflictError('SKILL_PATH_TAKEN', `A node already exists at "${path}".`);
          }
          throw error;
        }
        await this.emitCreated(tx, skill);
        return toSkillView(skill);
      }),
    );
  }

  async patch(
    principal: Principal,
    id: string,
    patch: SkillPatch,
    ifMatch: number,
    tenantHint?: string,
  ): Promise<SkillView> {
    const scope = writeScope(principal, tenantHint);
    // Read first to know whether the embedding input changes, then embed outside the transaction.
    const current = await inScope(this.db, scope, (tx) =>
      this.visible(tx, scope.tenantId, id, true),
    );
    const preview = {
      name: patch.name?.trim() ?? current.name,
      description: patch.description !== undefined ? patch.description : current.description,
    };
    const needsEmbedding =
      current.nodeType === 'skill' &&
      (preview.name !== current.name || preview.description !== current.description);
    const embedding = needsEmbedding
      ? await this.embed(preview.name, preview.description)
      : undefined;
    return inScope(this.db, scope, (tx) =>
      translate(async () => {
        const skill = // No FOR UPDATE: under RLS a tenant cannot lock a global row, so the lock would hide it
          // (404) before assertWritable can explain (403). The version compare-and-set guards races.
          await this.visible(tx, scope.tenantId, id, true);
        assertWritable(skill, scope.tenantId);
        assertVersion(skill, ifMatch);
        const next = patchSkill(
          skill,
          patch,
          await this.pendingVersion(tx, scope),
          this.clock.now(),
        );
        // If the text changed again since the preview, the stale vector is dropped (re-embed job).
        const vector = embeddingInputChanged(skill, next)
          ? embedding && embeddingText(next) === embeddingText(preview)
            ? embedding
            : null
          : undefined;
        if (!(await this.skills.update(tx, next, skill.version, vector))) {
          throw new TaxonomyDomainError(
            'precondition_failed',
            'VERSION_MISMATCH',
            'The skill changed concurrently.',
          );
        }
        return toSkillView(next);
      }),
    );
  }

  /** Keeps the row, links the successor with a REPLACES edge and emits skill.deprecated. */
  async deprecate(
    principal: Principal,
    id: string,
    replacedBy: string | null,
    tenantHint?: string,
  ): Promise<SkillDetailView> {
    const scope = writeScope(principal, tenantHint);
    await inScope(this.db, scope, (tx) =>
      translate(async () => {
        const skill = // No FOR UPDATE: under RLS a tenant cannot lock a global row, so the lock would hide it
          // (404) before assertWritable can explain (403). The version compare-and-set guards races.
          await this.visible(tx, scope.tenantId, id, true);
        assertWritable(skill, scope.tenantId);
        const successor = replacedBy ? await this.visible(tx, scope.tenantId, replacedBy) : null;
        const now = this.clock.now();
        const next = deprecateSkill(skill, successor, await this.pendingVersion(tx, scope), now);
        if (!(await this.skills.update(tx, next, skill.version))) {
          throw new TaxonomyDomainError(
            'precondition_failed',
            'VERSION_MISMATCH',
            'The skill changed concurrently.',
          );
        }
        if (successor) {
          await this.edges.insert(tx, {
            tenantId: scope.tenantId,
            src: skill.id,
            dst: successor.id,
            edgeType: 'REPLACES',
            weight: 1,
          });
        }
        await appendOutbox(
          tx,
          SkillDeprecated.build({
            tenantId: scope.tenantId,
            aggregateId: skill.id,
            payload: {
              tenant_id: scope.tenantId,
              skill_id: skill.id,
              replaced_by: successor?.id ?? null,
              taxonomy_version: next.taxonomyVersion,
              occurred_at: now.toISOString(),
            },
          }),
        );
      }),
    );
    return this.get(principal, id, tenantHint);
  }

  /** Tenant overlay on a global skill: hide, adopt, rename (display name) and extra aliases. */
  async putOverride(
    principal: Principal,
    id: string,
    input: OverrideInput,
    ifMatch: number | undefined,
    tenantHint?: string,
  ): Promise<SkillView> {
    const scope = writeScope(principal, tenantHint);
    const tenantId = scope.tenantId;
    if (!tenantId)
      throw new NotFoundError('TENANT_ID_REQUIRED', 'Overrides are per tenant: pass tenant_id.');
    return inScope(this.db, scope, (tx) =>
      translate(async () => {
        const skill = await this.visible(tx, tenantId, id, true);
        const existing = await this.overrides.find(tx, id);
        if (existing && ifMatch !== undefined && ifMatch !== existing.version) {
          throw new TaxonomyDomainError(
            'precondition_failed',
            'VERSION_MISMATCH',
            'The override changed since you read it.',
          );
        }
        const override = buildOverride(tenantId, skill, input, existing?.version ?? 0);
        if (!(await this.overrides.upsert(tx, override, existing?.version ?? null))) {
          throw new TaxonomyDomainError(
            'precondition_failed',
            'VERSION_MISMATCH',
            'The override changed concurrently.',
          );
        }
        return toSkillView({ ...skill, override });
      }),
    );
  }

  async deleteOverride(principal: Principal, id: string, tenantHint?: string): Promise<void> {
    const scope = writeScope(principal, tenantHint);
    if (!scope.tenantId) throw new NotFoundError('TENANT_ID_REQUIRED', 'Overrides are per tenant.');
    const removed = await inScope(this.db, scope, (tx) => this.overrides.delete(tx, id));
    if (!removed)
      throw new NotFoundError('OVERRIDE_NOT_FOUND', 'No override exists for this skill.');
  }

  /**
   * Lateral edges between leaf skills. RELATED_TO is symmetric and stored once (src < dst);
   * PREREQUISITE_OF may not close a cycle; REPLACES only comes from deprecation.
   */
  async addEdge(
    principal: Principal,
    input: { src: string; dst: string; edgeType: 'RELATED_TO' | 'PREREQUISITE_OF'; weight: number },
    tenantHint?: string,
  ): Promise<SkillEdge> {
    const scope = writeScope(principal, tenantHint);
    if (input.src === input.dst) {
      throw new DomainRuleError('SELF_EDGE', 'A skill cannot be related to itself.');
    }
    return inScope(this.db, scope, async (tx) => {
      const [a, b] = [
        await this.visible(tx, scope.tenantId, input.src),
        await this.visible(tx, scope.tenantId, input.dst),
      ];
      for (const s of [a, b]) {
        if (s.nodeType !== 'skill' || s.deprecatedAt) {
          throw new DomainRuleError('INVALID_EDGE_NODE', 'Edges connect active leaf skills only.');
        }
        if (scope.tenantId === null && s.tenantId !== null) {
          throw new DomainRuleError(
            'GLOBAL_EDGE_TO_TENANT',
            'A global edge must connect global skills.',
          );
        }
      }
      if (input.edgeType === 'PREREQUISITE_OF') {
        await this.edges.lockPrerequisites(tx);
        if (await this.edges.reaches(tx, scope.tenantId, input.dst, input.src)) {
          throw new DomainRuleError(
            'PREREQUISITE_CYCLE',
            'This prerequisite would create a cycle: the target already leads back to the source.',
          );
        }
      }
      const [src, dst] =
        input.edgeType === 'RELATED_TO' && input.dst < input.src
          ? [input.dst, input.src]
          : [input.src, input.dst];
      const edge: SkillEdge = {
        tenantId: scope.tenantId,
        src,
        dst,
        edgeType: input.edgeType,
        weight: input.weight,
      };
      if (!(await this.edges.insert(tx, edge))) {
        throw new ConflictError('EDGE_EXISTS', 'This edge already exists.');
      }
      return edge;
    });
  }

  async removeEdge(
    principal: Principal,
    input: { src: string; dst: string; edgeType: 'RELATED_TO' | 'PREREQUISITE_OF' },
    tenantHint?: string,
  ): Promise<void> {
    const scope = writeScope(principal, tenantHint);
    const [src, dst] =
      input.edgeType === 'RELATED_TO' && input.dst < input.src
        ? [input.dst, input.src]
        : [input.src, input.dst];
    const removed = await inScope(this.db, scope, (tx) =>
      this.edges.delete(tx, scope.tenantId, src, dst, input.edgeType),
    );
    if (!removed) throw new NotFoundError('EDGE_NOT_FOUND', 'No such edge in this scope.');
  }

  async versionInfo(
    principal: Principal,
    tenantHint?: string,
  ): Promise<{ tenant_id: string | null; published_version: number; pending_changes: number }> {
    const scope = readScope(principal, tenantHint);
    return inScope(this.db, scope, async (tx) => {
      const published = await this.versions.publishedVersion(tx, scope.tenantId);
      return {
        tenant_id: scope.tenantId,
        published_version: published,
        pending_changes: await this.skills.countAtVersion(tx, scope.tenantId, published + 1),
      };
    });
  }

  /** Marks a release: pending changes become version N and downstream re-normalises. */
  async publish(
    principal: Principal,
    tenantHint?: string,
  ): Promise<{ version: number; changed_skills: number }> {
    const scope = writeScope(principal, tenantHint);
    return inScope(this.db, scope, async (tx) => {
      const version = (await this.versions.publishedVersion(tx, scope.tenantId)) + 1;
      const changed = await this.skills.countAtVersion(tx, scope.tenantId, version);
      if (changed === 0)
        throw new DomainRuleError(
          'NOTHING_TO_PUBLISH',
          'No skills changed since the last version.',
        );
      const now = this.clock.now();
      await this.versions.publish(tx, scope.tenantId, version, principal.subject, now);
      await appendOutbox(
        tx,
        TaxonomyVersionPublished.build({
          tenantId: scope.tenantId,
          aggregateId: scope.tenantId ?? GLOBAL_SCOPE_ID,
          payload: {
            tenant_id: scope.tenantId,
            version,
            changed_skills: changed,
            published_by: principal.subject,
            occurred_at: now.toISOString(),
          },
        }),
      );
      return { version, changed_skills: changed };
    });
  }

  /** Embeds active skills that have no vector from the current model (model change, outages). */
  async reembed(
    principal: Principal,
    limit: number,
    tenantHint?: string,
  ): Promise<{ embedded: number; remaining: boolean }> {
    const scope = writeScope(principal, tenantHint);
    const pending = await inScope(this.db, scope, (tx) =>
      this.skills.needingEmbedding(tx, scope.tenantId, this.embeddings.model, limit + 1),
    );
    const batch = pending.slice(0, limit);
    if (batch.length === 0) return { embedded: 0, remaining: false };
    const vectors = await this.embedMany(batch.map(embeddingText));
    await inScope(this.db, scope, async (tx) => {
      for (const [i, skill] of batch.entries()) {
        const vector = vectors[i];
        if (vector)
          await this.skills.setEmbedding(tx, skill.id, { vector, model: this.embeddings.model });
      }
    });
    return { embedded: batch.length, remaining: pending.length > limit };
  }

  /** Version that unpublished changes in a scope belong to. */
  async pendingVersion(tx: Tx, scope: Scope): Promise<number> {
    return (await this.versions.publishedVersion(tx, scope.tenantId)) + 1;
  }

  async emitCreated(tx: Tx, skill: Skill): Promise<void> {
    await appendOutbox(
      tx,
      SkillCreated.build({
        tenantId: skill.tenantId,
        aggregateId: skill.id,
        payload: {
          tenant_id: skill.tenantId,
          skill_id: skill.id,
          node_type: skill.nodeType,
          path: skill.path,
          name: skill.name,
          taxonomy_version: skill.taxonomyVersion,
          occurred_at: skill.createdAt.toISOString(),
        },
      }),
    );
  }

  async embedMany(texts: readonly string[]): Promise<number[][]> {
    try {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += 64)
        out.push(...(await this.embeddings.embed(texts.slice(i, i + 64))));
      return out;
    } catch {
      throw new ServiceUnavailableError(
        'EMBEDDINGS_UNAVAILABLE',
        'The embedding service is unavailable; retry shortly.',
      );
    }
  }

  private async embed(name: string, description: string | null | undefined): Promise<Embedding> {
    const [vector] = await this.embedMany([
      embeddingText({ name: name.trim(), description: description?.trim() || null }),
    ]);
    if (!vector)
      throw new ServiceUnavailableError('EMBEDDINGS_UNAVAILABLE', 'No embedding was returned.');
    return { vector, model: this.embeddings.model };
  }

  private async visible(
    tx: Tx,
    view: View,
    id: string,
    includeHidden = false,
    forUpdate = false,
  ): Promise<VisibleSkill> {
    const skill = isUuid(id)
      ? await this.skills.findById(tx, view, id, { includeHidden, forUpdate })
      : null;
    if (!skill) throw new NotFoundError('SKILL_NOT_FOUND', 'Skill not found.');
    return skill;
  }

  private async resolveSuccessor(tx: Tx, view: View, skill: Skill): Promise<Skill | null> {
    let current: Skill = skill;
    for (let hop = 0; hop < MAX_SUCCESSOR_HOPS && current.replacedBy; hop += 1) {
      const next = await this.skills.findById(tx, view, current.replacedBy, {
        includeHidden: true,
      });
      if (!next) return null;
      if (!next.deprecatedAt) return next;
      current = next;
    }
    return null;
  }
}

/** Aggregate id for global-taxonomy version events. */
export const GLOBAL_SCOPE_ID = '00000000-0000-0000-0000-000000000000';
