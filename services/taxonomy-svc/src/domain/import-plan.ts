import {
  SKILL_CLASSIFICATIONS,
  SKILL_NODE_TYPES,
  type SkillClassification,
  type SkillNodeType,
} from '@atlas/contracts';
import { TaxonomyDomainError } from './errors';
import { assertPath, parentPath } from './paths';
import { type Skill } from './skill';
import { cleanAliases } from './terms';

export const MAX_IMPORT_ROWS = 5000;

/** One spreadsheet row, as text. Header names are case-insensitive. */
export interface ImportRow {
  line: number;
  values: Readonly<Record<string, string>>;
}

export interface PlannedFields {
  path: string;
  nodeType: SkillNodeType;
  name: string;
  description: string | null;
  classification: SkillClassification;
  aliases: string[];
  externalId: string | null;
}

export type PlanEntry =
  | { line: number; action: 'create'; fields: PlannedFields }
  | { line: number; action: 'update'; skillId: string; fields: PlannedFields; changed: string[] }
  | { line: number; action: 'unchanged'; skillId: string; path: string }
  | { line: number; action: 'error'; path: string | null; errors: string[] };

export interface ImportSummary {
  create: number;
  update: number;
  unchanged: number;
  error: number;
}

export const REQUIRED_COLUMNS = ['path', 'node_type', 'name'] as const;
export const KNOWN_COLUMNS = [
  ...REQUIRED_COLUMNS,
  'description',
  'classification',
  'aliases',
  'external_id',
] as const;

function field(row: ImportRow, name: string): string {
  return (row.values[name] ?? '').trim();
}

function parseRow(row: ImportRow): PlannedFields | string[] {
  const errors: string[] = [];
  const path = field(row, 'path').toLowerCase();
  const nodeType = field(row, 'node_type').toLowerCase();
  const name = field(row, 'name');
  const classification = field(row, 'classification').toLowerCase() || 'unclassified';
  if (!(SKILL_NODE_TYPES as readonly string[]).includes(nodeType)) {
    errors.push(`node_type must be one of ${SKILL_NODE_TYPES.join(', ')}`);
  } else {
    try {
      assertPath(path, nodeType as SkillNodeType);
    } catch (error) {
      errors.push((error as TaxonomyDomainError).message);
    }
  }
  if (!name || name.length > 200) errors.push('name must be 1–200 characters');
  if (!(SKILL_CLASSIFICATIONS as readonly string[]).includes(classification)) {
    errors.push(`classification must be one of ${SKILL_CLASSIFICATIONS.join(', ')}`);
  }
  const description = field(row, 'description');
  if (description.length > 2000) errors.push('description must be at most 2000 characters');
  if (errors.length > 0) return errors;
  return {
    path,
    nodeType: nodeType as SkillNodeType,
    name,
    description: description || null,
    classification: classification as SkillClassification,
    aliases: cleanAliases(field(row, 'aliases').split(/[;|]/)),
    externalId: field(row, 'external_id') || null,
  };
}

function changes(existing: Skill, f: PlannedFields): string[] {
  const out: string[] = [];
  if (existing.name !== f.name) out.push('name');
  if (existing.description !== f.description) out.push('description');
  if (existing.classification !== f.classification) out.push('classification');
  if (existing.aliases.join('\u0000') !== f.aliases.join('\u0000')) out.push('aliases');
  if (existing.externalId !== f.externalId) out.push('external_id');
  return out;
}

/**
 * Plans an import against the taxonomy visible in a scope (dry run). Imports create and update;
 * they never delete or deprecate. Rows are processed parents-first, so a file may create a whole
 * branch. A path owned by another scope (e.g. a global node during a tenant import) is an error.
 */
export function planImport(
  rows: readonly ImportRow[],
  scopeTenantId: string | null,
  visibleByPath: ReadonlyMap<string, Skill>,
): { entries: PlanEntry[]; summary: ImportSummary } {
  if (rows.length === 0) {
    throw new TaxonomyDomainError('validation', 'IMPORT_EMPTY', 'The file has no data rows.');
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new TaxonomyDomainError(
      'validation',
      'IMPORT_TOO_LARGE',
      `At most ${MAX_IMPORT_ROWS} rows per import.`,
    );
  }
  const parsed = rows.map((row) => ({ row, result: parseRow(row) }));
  const depth = (p: { result: PlannedFields | string[] }): number =>
    Array.isArray(p.result) ? 0 : p.result.path.split('.').length;
  parsed.sort((a, b) => depth(a) - depth(b) || a.row.line - b.row.line);

  const seen = new Map<string, number>();
  const created = new Set<string>();
  const entries: PlanEntry[] = [];
  for (const { row, result } of parsed) {
    if (Array.isArray(result)) {
      entries.push({
        line: row.line,
        action: 'error',
        path: field(row, 'path') || null,
        errors: result,
      });
      continue;
    }
    const errors: string[] = [];
    const firstLine = seen.get(result.path);
    if (firstLine !== undefined) errors.push(`duplicate of line ${firstLine}`);
    seen.set(result.path, firstLine ?? row.line);
    const parent = parentPath(result.path);
    const parentNode = parent ? visibleByPath.get(parent) : undefined;
    if (parent && !parentNode && !created.has(parent))
      errors.push(`parent "${parent}" does not exist`);
    if (parentNode?.deprecatedAt) errors.push(`parent "${parent}" is deprecated`);
    if (scopeTenantId === null && parentNode && parentNode.tenantId !== null) {
      errors.push('a global node cannot sit under a tenant node');
    }
    const existing = visibleByPath.get(result.path);
    if (existing && existing.tenantId !== scopeTenantId) {
      errors.push('this path is a global skill; change it with an override instead');
    }
    if (existing && existing.nodeType !== result.nodeType) {
      errors.push(`existing node is a ${existing.nodeType}`);
    }
    if (existing?.deprecatedAt) errors.push('the existing node is deprecated');
    if (errors.length > 0) {
      entries.push({ line: row.line, action: 'error', path: result.path, errors });
      continue;
    }
    if (!existing) {
      created.add(result.path);
      entries.push({ line: row.line, action: 'create', fields: result });
      continue;
    }
    const changed = changes(existing, result);
    entries.push(
      changed.length > 0
        ? { line: row.line, action: 'update', skillId: existing.id, fields: result, changed }
        : { line: row.line, action: 'unchanged', skillId: existing.id, path: result.path },
    );
  }
  entries.sort((a, b) => a.line - b.line);
  const summary: ImportSummary = { create: 0, update: 0, unchanged: 0, error: 0 };
  for (const e of entries) summary[e.action] += 1;
  return { entries, summary };
}
