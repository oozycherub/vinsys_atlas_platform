import { Inject, Injectable } from '@nestjs/common';
import {
  ConflictError,
  DATABASE,
  type Database,
  DomainRuleError,
  isUuid,
  newId,
  NotFoundError,
  type Principal,
} from '@atlas/platform';
import { type ImportRow, type PlanEntry, planImport } from '../domain/import-plan';
import { parentPath } from '../domain/paths';
import { createSkill, embeddingText, patchSkill, type Skill } from '../domain/skill';
import {
  type Embedding,
  EMBEDDING_PORT,
  type EmbeddingPort,
  IMPORT_REPOSITORY,
  type ImportBatch,
  type ImportRepository,
  SKILL_REPOSITORY,
  type SkillRepository,
} from './ports';
import { inScope, writeScope } from './scope';
import { SkillService } from './skill.service';
import { translate } from './translate';

export const IMPORT_TTL_MS = 24 * 60 * 60 * 1000;

/** Reads uploaded spreadsheets into rows (CSV or XLSX). */
export interface SpreadsheetParser {
  parse(file: { name: string; mimeType: string; content: Buffer }): Promise<ImportRow[]>;
}
export const SPREADSHEET_PARSER = Symbol('SPREADSHEET_PARSER');

export interface ImportView {
  import_id: string;
  tenant_id: string | null;
  status: string;
  file_name: string;
  row_count: number;
  summary: ImportBatch['summary'];
  entries: PlanEntry[];
  created_at: string;
  expires_at: string;
  committed_at: string | null;
}

function toImportView(b: ImportBatch): ImportView {
  return {
    import_id: b.id,
    tenant_id: b.tenantId,
    status: b.status,
    file_name: b.fileName,
    row_count: b.rowCount,
    summary: b.summary,
    entries: b.plan,
    created_at: b.createdAt.toISOString(),
    expires_at: b.expiresAt.toISOString(),
    committed_at: b.committedAt?.toISOString() ?? null,
  };
}

/**
 * Bulk import (docs/prompts/03-taxonomy-svc.md §2): upload → dry-run diff (stored for 24 h) →
 * commit. Commit is all-or-nothing, refuses a plan with errors, and refuses a plan whose base
 * taxonomy changed since the dry run (IMPORT_STALE), so what was reviewed is what is applied.
 */
@Injectable()
export class ImportService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SKILL_REPOSITORY) private readonly skills: SkillRepository,
    @Inject(IMPORT_REPOSITORY) private readonly imports: ImportRepository,
    @Inject(EMBEDDING_PORT) private readonly embeddings: EmbeddingPort,
    @Inject(SPREADSHEET_PARSER) private readonly parser: SpreadsheetParser,
    private readonly skillService: SkillService,
  ) {}

  async dryRun(
    principal: Principal,
    file: { name: string; mimeType: string; content: Buffer },
    tenantHint?: string,
  ): Promise<ImportView> {
    const scope = writeScope(principal, tenantHint);
    const rows = await translate(() => this.parser.parse(file));
    return inScope(this.db, scope, (tx) =>
      translate(async () => {
        const paths = new Set<string>();
        for (const row of rows) {
          let p: string | null = (row.values['path'] ?? '').trim().toLowerCase();
          while (p) {
            paths.add(p);
            p = parentPath(p);
          }
        }
        const visible = await this.skills.findByPaths(tx, scope.tenantId, [...paths]);
        // Prefer the scope's own node when a path exists both globally and in the tenant.
        const byPath = new Map<string, Skill>();
        for (const s of visible) {
          if (!byPath.has(s.path) || s.tenantId === scope.tenantId) byPath.set(s.path, s);
        }
        const { entries, summary } = planImport(rows, scope.tenantId, byPath);
        const now = new Date();
        const batch: ImportBatch = {
          id: newId(),
          tenantId: scope.tenantId,
          status: 'dry_run',
          fileName: file.name.slice(0, 255),
          rowCount: rows.length,
          summary,
          plan: entries,
          baseFingerprint: await this.skills.fingerprint(tx, scope.tenantId),
          createdBy: principal.subject,
          createdAt: now,
          expiresAt: new Date(now.getTime() + IMPORT_TTL_MS),
          committedAt: null,
        };
        await this.imports.insert(tx, batch);
        return toImportView(batch);
      }),
    );
  }

  async get(principal: Principal, id: string, tenantHint?: string): Promise<ImportView> {
    const scope = writeScope(principal, tenantHint);
    const batch = await inScope(this.db, scope, (tx) => this.load(tx, id, scope.tenantId));
    return toImportView(batch);
  }

  async commit(principal: Principal, id: string, tenantHint?: string): Promise<ImportView> {
    const scope = writeScope(principal, tenantHint);
    const preview = await inScope(this.db, scope, (tx) => this.load(tx, id, scope.tenantId));
    this.assertCommittable(preview);

    // Embed new and changed leaf skills before the transaction (no HTTP inside it).
    const toEmbed = preview.plan.filter(
      (e): e is Extract<PlanEntry, { action: 'create' | 'update' }> =>
        (e.action === 'create' || e.action === 'update') && e.fields.nodeType === 'skill',
    );
    const vectors = await this.skillService.embedMany(
      toEmbed.map((e) => embeddingText({ name: e.fields.name, description: e.fields.description })),
    );
    const embeddingByLine = new Map<number, Embedding>();
    toEmbed.forEach((e, i) => {
      const vector = vectors[i];
      if (vector) embeddingByLine.set(e.line, { vector, model: this.embeddings.model });
    });

    return inScope(this.db, scope, (tx) =>
      translate(async () => {
        const batch = await this.load(tx, id, scope.tenantId, true);
        this.assertCommittable(batch);
        if ((await this.skills.fingerprint(tx, scope.tenantId)) !== batch.baseFingerprint) {
          throw new ConflictError(
            'IMPORT_STALE',
            'The taxonomy changed since this dry run. Upload the file again to get a fresh diff.',
          );
        }
        const version = await this.skillService.pendingVersion(tx, scope);
        const now = new Date();
        const paths = new Set<string>();
        for (const e of batch.plan) {
          if (e.action === 'create' || e.action === 'update') {
            paths.add(e.fields.path);
            const parent = parentPath(e.fields.path);
            if (parent) paths.add(parent);
          }
        }
        const known = new Map<string, Skill>();
        for (const s of await this.skills.findByPaths(tx, scope.tenantId, [...paths])) {
          if (!known.has(s.path) || s.tenantId === scope.tenantId) known.set(s.path, s);
        }
        // Parents first, so a file can create a whole branch.
        const ordered = [...batch.plan].sort((a, b) => depthOf(a) - depthOf(b) || a.line - b.line);
        for (const entry of ordered) {
          if (entry.action === 'create') {
            const f = entry.fields;
            const parent = parentPath(f.path);
            const skill = createSkill({
              id: newId(),
              tenantId: scope.tenantId,
              nodeType: f.nodeType,
              path: f.path,
              name: f.name,
              description: f.description,
              classification: f.classification,
              aliases: f.aliases,
              externalId: f.externalId,
              parent: parent ? (known.get(parent) ?? null) : null,
              taxonomyVersion: version,
              now,
            });
            await this.skills.insert(tx, skill, embeddingByLine.get(entry.line) ?? null);
            known.set(skill.path, skill);
            await this.skillService.emitCreated(tx, skill);
          } else if (entry.action === 'update') {
            const existing = known.get(entry.fields.path);
            if (!existing)
              throw new ConflictError('IMPORT_STALE', 'A skill in this import no longer exists.');
            const f = entry.fields;
            const next = patchSkill(
              existing,
              {
                name: f.name,
                description: f.description,
                classification: f.classification,
                aliases: f.aliases,
                externalId: f.externalId,
              },
              version,
              now,
            );
            const embedding = embeddingByLine.get(entry.line);
            if (!(await this.skills.update(tx, next, existing.version, embedding ?? undefined))) {
              throw new ConflictError('IMPORT_STALE', 'A skill changed during the import.');
            }
          }
        }
        await this.imports.markCommitted(tx, batch.id, now);
        return toImportView({ ...batch, status: 'committed', committedAt: now });
      }),
    );
  }

  private assertCommittable(batch: ImportBatch): void {
    if (batch.status !== 'dry_run') {
      throw new ConflictError('IMPORT_ALREADY_COMMITTED', 'This import was already committed.');
    }
    if (batch.expiresAt.getTime() <= Date.now()) {
      throw new DomainRuleError(
        'IMPORT_EXPIRED',
        'This dry run has expired. Upload the file again.',
      );
    }
    if (batch.summary.error > 0) {
      throw new DomainRuleError(
        'IMPORT_HAS_ERRORS',
        `Fix the ${batch.summary.error} row(s) with errors and upload again.`,
      );
    }
  }

  private async load(
    tx: Parameters<ImportRepository['find']>[0],
    id: string,
    scopeTenantId: string | null,
    forUpdate = false,
  ): Promise<ImportBatch> {
    const batch = isUuid(id) ? await this.imports.find(tx, id, { forUpdate }) : null;
    if (batch?.tenantId !== scopeTenantId || !batch) {
      throw new NotFoundError('IMPORT_NOT_FOUND', 'Import not found.');
    }
    return batch;
  }
}

function depthOf(entry: PlanEntry): number {
  return entry.action === 'create' || entry.action === 'update'
    ? entry.fields.path.split('.').length
    : 0;
}
