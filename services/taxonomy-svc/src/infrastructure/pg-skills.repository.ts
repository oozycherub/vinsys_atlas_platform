import { Injectable } from '@nestjs/common';
import { type SkillClassification, type SkillNodeType } from '@atlas/contracts';
import { type Tx } from '@atlas/platform';
import {
  type EdgeRepository,
  type Embedding,
  type OverrideRepository,
  type RelatedSkill,
  type SkillEdge,
  type SkillListFilter,
  type SkillRepository,
  type View,
  type VisibleSkill,
} from '../application/ports';
import { type Skill, type SkillOverride } from '../domain/skill';

interface SkillRow {
  skill_id: string;
  tenant_id: string | null;
  node_type: SkillNodeType;
  path: string;
  name: string;
  description: string | null;
  classification: SkillClassification;
  aliases: string[];
  search_keys: string[];
  external_id: string | null;
  taxonomy_version: number;
  deprecated_at: Date | null;
  replaced_by: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  o_tenant_id?: string | null;
  o_hidden?: boolean | null;
  o_adopted?: boolean | null;
  o_display_name?: string | null;
  o_aliases?: string[] | null;
  o_search_keys?: string[] | null;
  o_version?: number | null;
}

const S = `s.skill_id, s.tenant_id, s.node_type, s.path::text AS path, s.name, s.description, s.classification,
  s.aliases, s.search_keys, s.external_id, s.taxonomy_version, s.deprecated_at, s.replaced_by, s.version,
  s.created_at, s.updated_at`;
const O = `o.tenant_id AS o_tenant_id, o.hidden AS o_hidden, o.adopted AS o_adopted, o.display_name AS o_display_name,
  o.aliases AS o_aliases, o.search_keys AS o_search_keys, o.version AS o_version`;
/** The overlay of the viewing tenant ($1); never matches in the global view ($1 NULL). */
const OVERLAY = `LEFT JOIN tenant_skill_overrides o ON o.skill_id = s.skill_id AND o.tenant_id = $1::uuid`;
/** Global rows plus the viewing tenant's own; explicit even though RLS enforces it too. */
const IN_VIEW = `(s.tenant_id IS NULL OR s.tenant_id = $1::uuid)`;
const NOT_HIDDEN = `NOT coalesce(o.hidden, false)`;

const date = (v: Date | null): Date | null => (v ? new Date(v) : null);

function toSkill(r: SkillRow): Skill {
  return {
    id: r.skill_id,
    tenantId: r.tenant_id,
    nodeType: r.node_type,
    path: r.path,
    name: r.name,
    description: r.description,
    classification: r.classification,
    aliases: r.aliases,
    searchKeys: r.search_keys,
    externalId: r.external_id,
    taxonomyVersion: Number(r.taxonomy_version),
    deprecatedAt: date(r.deprecated_at),
    replacedBy: r.replaced_by,
    version: Number(r.version),
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
}

function toVisible(r: SkillRow): VisibleSkill {
  const override: SkillOverride | null = r.o_tenant_id
    ? {
        tenantId: r.o_tenant_id,
        skillId: r.skill_id,
        hidden: Boolean(r.o_hidden),
        adopted: Boolean(r.o_adopted),
        displayName: r.o_display_name ?? null,
        aliases: r.o_aliases ?? [],
        searchKeys: r.o_search_keys ?? [],
        version: Number(r.o_version),
      }
    : null;
  return { ...toSkill(r), override };
}

/** pgvector text format. */
export function vectorLiteral(v: readonly number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(',')}]`;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

@Injectable()
export class PgSkillRepository implements SkillRepository {
  async findById(
    tx: Tx,
    view: View,
    id: string,
    options: { includeHidden?: boolean; forUpdate?: boolean } = {},
  ): Promise<VisibleSkill | null> {
    const { rows } = await tx.query<SkillRow>(
      `SELECT ${S}, ${O} FROM skills s ${OVERLAY}
       WHERE s.skill_id = $2 AND ${IN_VIEW} ${options.includeHidden ? '' : `AND ${NOT_HIDDEN}`}
       ${options.forUpdate ? 'FOR UPDATE OF s' : ''}`,
      [view, id],
    );
    return rows[0] ? toVisible(rows[0]) : null;
  }

  async findByPaths(tx: Tx, view: View, paths: readonly string[]): Promise<Skill[]> {
    if (paths.length === 0) return [];
    const { rows } = await tx.query<SkillRow>(
      `SELECT ${S} FROM skills s WHERE s.path::text = ANY($2::text[]) AND ${IN_VIEW}`,
      [view, [...paths]],
    );
    return rows.map(toSkill);
  }

  async insert(tx: Tx, s: Skill, embedding: Embedding | null): Promise<void> {
    await tx.query(
      `INSERT INTO skills (skill_id, tenant_id, node_type, path, name, description, classification, aliases,
         search_keys, external_id, embedding, embedding_model, taxonomy_version, deprecated_at, replaced_by,
         version, created_at, updated_at)
       VALUES ($1, $2, $3, $4::ltree, $5, $6, $7, $8::text[], $9::text[], $10, $11::vector, $12, $13, $14, $15,
         $16, $17, $18)`,
      [
        s.id,
        s.tenantId,
        s.nodeType,
        s.path,
        s.name,
        s.description,
        s.classification,
        [...s.aliases],
        [...s.searchKeys],
        s.externalId,
        embedding ? vectorLiteral(embedding.vector) : null,
        embedding?.model ?? null,
        s.taxonomyVersion,
        s.deprecatedAt,
        s.replacedBy,
        s.version,
        s.createdAt,
        s.updatedAt,
      ],
    );
  }

  async update(
    tx: Tx,
    s: Skill,
    expectedVersion: number,
    embedding?: Embedding | null,
  ): Promise<boolean> {
    const setEmbedding =
      embedding === undefined ? '' : ', embedding = $14::vector, embedding_model = $15';
    const params: unknown[] = [
      s.id,
      expectedVersion,
      s.name,
      s.description,
      s.classification,
      [...s.aliases],
      [...s.searchKeys],
      s.externalId,
      s.taxonomyVersion,
      s.deprecatedAt,
      s.replacedBy,
      s.version,
      s.tenantId,
    ];
    if (embedding !== undefined) {
      params.push(embedding ? vectorLiteral(embedding.vector) : null, embedding?.model ?? null);
    }
    const { rowCount } = await tx.query(
      `UPDATE skills SET name = $3, description = $4, classification = $5, aliases = $6::text[],
         search_keys = $7::text[], external_id = $8, taxonomy_version = $9, deprecated_at = $10,
         replaced_by = $11, version = $12${setEmbedding}
       WHERE skill_id = $1 AND version = $2 AND tenant_id IS NOT DISTINCT FROM $13::uuid`,
      params,
    );
    return rowCount === 1;
  }

  async list(tx: Tx, f: SkillListFilter): Promise<VisibleSkill[]> {
    const q = f.q?.trim().toLowerCase() ?? null;
    const { rows } = await tx.query<SkillRow>(
      `SELECT ${S}, ${O} FROM skills s ${OVERLAY}
       WHERE ${IN_VIEW} AND ${NOT_HIDDEN}
         AND ($2::text IS NULL OR s.path <@ $2::ltree)
         AND ($3::text IS NULL
              OR lower(coalesce(o.display_name, s.name)) LIKE '%' || $4 || '%' ESCAPE '\\'
              OR s.search_keys && ARRAY[$3::text]
              OR coalesce(o.search_keys, '{}') && ARRAY[$3::text]
              OR similarity(lower(s.name), $3::text) > 0.45)
         AND ($5::skill_classification IS NULL OR s.classification = $5::skill_classification)
         AND ($6::skill_node_type IS NULL OR s.node_type = $6::skill_node_type)
         AND ($7::boolean OR s.deprecated_at IS NULL)
         AND ($8::text IS NULL OR (s.path::text, s.skill_id) > ($8::text, $9::uuid))
       ORDER BY s.path::text, s.skill_id
       LIMIT $10`,
      [
        f.view,
        f.path ?? null,
        q,
        q ? escapeLike(q) : null,
        f.classification ?? null,
        f.nodeType ?? null,
        f.includeDeprecated,
        f.after?.path ?? null,
        f.after?.id ?? null,
        f.limit,
      ],
    );
    return rows.map(toVisible);
  }

  async ancestors(tx: Tx, view: View, path: string): Promise<Skill[]> {
    const { rows } = await tx.query<SkillRow>(
      `SELECT ${S} FROM skills s
       WHERE s.path @> $2::ltree AND s.path <> $2::ltree AND ${IN_VIEW}
       ORDER BY nlevel(s.path), s.tenant_id NULLS FIRST`,
      [view, path],
    );
    return rows.map(toSkill);
  }

  async aliasCandidates(
    tx: Tx,
    view: View,
    keys: readonly string[],
  ): Promise<{ key: string; skill: Skill }[]> {
    if (keys.length === 0) return [];
    const { rows } = await tx.query<SkillRow & { matched: string[] }>(
      `SELECT ${S}, ${O},
         ARRAY(SELECT unnest(s.search_keys || coalesce(o.search_keys, '{}')) INTERSECT SELECT unnest($2::text[])) AS matched
       FROM skills s ${OVERLAY}
       WHERE ${IN_VIEW} AND ${NOT_HIDDEN} AND s.node_type = 'skill'
         AND (s.search_keys && $2::text[] OR coalesce(o.search_keys, '{}') && $2::text[])`,
      [view, [...keys]],
    );
    return rows.flatMap((r) => r.matched.map((key) => ({ key, skill: toSkill(r) })));
  }

  async nearest(
    tx: Tx,
    view: View,
    vector: readonly number[],
    model: string,
  ): Promise<{ skill: Skill; cosine: number } | null> {
    const { rows } = await tx.query<SkillRow & { cosine: number }>(
      `SELECT ${S}, 1 - (s.embedding <=> $2::vector) AS cosine
       FROM skills s ${OVERLAY}
       WHERE s.node_type = 'skill' AND s.deprecated_at IS NULL AND s.embedding_model = $3
         AND ${IN_VIEW} AND ${NOT_HIDDEN}
       ORDER BY s.embedding <=> $2::vector
       LIMIT 1`,
      [view, vectorLiteral(vector), model],
    );
    const r = rows[0];
    return r ? { skill: toSkill(r), cosine: Number(r.cosine) } : null;
  }

  async needingEmbedding(
    tx: Tx,
    scopeTenantId: string | null,
    model: string,
    limit: number,
  ): Promise<Skill[]> {
    const { rows } = await tx.query<SkillRow>(
      `SELECT ${S} FROM skills s
       WHERE s.tenant_id IS NOT DISTINCT FROM $1::uuid AND s.node_type = 'skill' AND s.deprecated_at IS NULL
         AND s.embedding_model IS DISTINCT FROM $2
       ORDER BY s.skill_id LIMIT $3`,
      [scopeTenantId, model, limit],
    );
    return rows.map(toSkill);
  }

  async setEmbedding(tx: Tx, skillId: string, embedding: Embedding): Promise<void> {
    await tx.query(
      `UPDATE skills SET embedding = $2::vector, embedding_model = $3 WHERE skill_id = $1`,
      [skillId, vectorLiteral(embedding.vector), embedding.model],
    );
  }

  async fingerprint(tx: Tx, scopeTenantId: string | null): Promise<string> {
    const { rows } = await tx.query<{ n: string; latest: Date | null; versions: string }>(
      `SELECT count(*)::text AS n, max(updated_at) AS latest, coalesce(sum(version), 0)::text AS versions
       FROM skills s WHERE (s.tenant_id IS NULL OR s.tenant_id = $1::uuid)`,
      [scopeTenantId],
    );
    const r = rows[0];
    return `${r?.n ?? 0}:${r?.latest ? new Date(r.latest).toISOString() : '-'}:${r?.versions ?? 0}`;
  }

  async countAtVersion(tx: Tx, scopeTenantId: string | null, version: number): Promise<number> {
    const { rows } = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM skills WHERE tenant_id IS NOT DISTINCT FROM $1::uuid AND taxonomy_version = $2`,
      [scopeTenantId, version],
    );
    return Number(rows[0]?.n ?? 0);
  }
}

@Injectable()
export class PgEdgeRepository implements EdgeRepository {
  async insert(tx: Tx, e: SkillEdge): Promise<boolean> {
    const { rowCount } = await tx.query(
      `INSERT INTO skill_edges (tenant_id, src, dst, edge_type, weight) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (src, dst, edge_type) DO NOTHING`,
      [e.tenantId, e.src, e.dst, e.edgeType, e.weight],
    );
    return rowCount === 1;
  }

  async delete(
    tx: Tx,
    scopeTenantId: string | null,
    src: string,
    dst: string,
    edgeType: SkillEdge['edgeType'],
  ): Promise<boolean> {
    const { rowCount } = await tx.query(
      `DELETE FROM skill_edges WHERE src = $1 AND dst = $2 AND edge_type = $3
         AND edge_type <> 'REPLACES' AND tenant_id IS NOT DISTINCT FROM $4::uuid`,
      [src, dst, edgeType, scopeTenantId],
    );
    return rowCount === 1;
  }

  async lockPrerequisites(tx: Tx): Promise<void> {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('taxonomy.prerequisite_edges'))`);
  }

  async reaches(tx: Tx, view: View, from: string, to: string): Promise<boolean> {
    // UNION (not UNION ALL) makes the walk terminate even if bad data already has a cycle.
    const { rows } = await tx.query<{ found: boolean }>(
      `WITH RECURSIVE reach(id) AS (
         SELECT $2::uuid
         UNION
         SELECT e.dst FROM skill_edges e JOIN reach r ON e.src = r.id
         WHERE e.edge_type = 'PREREQUISITE_OF' AND (e.tenant_id IS NULL OR e.tenant_id = $1::uuid)
       )
       SELECT EXISTS (SELECT 1 FROM reach WHERE id = $3::uuid) AS found`,
      [view, from, to],
    );
    return Boolean(rows[0]?.found);
  }

  async related(tx: Tx, view: View, skillId: string): Promise<RelatedSkill[]> {
    const { rows } = await tx.query<
      SkillRow & {
        edge_type: SkillEdge['edgeType'];
        direction: 'out' | 'in' | 'both';
        weight: string;
      }
    >(
      `SELECT ${S}, x.edge_type, x.direction, x.weight::text AS weight
       FROM (
         SELECT e.dst AS other, e.edge_type,
                CASE WHEN e.edge_type = 'RELATED_TO' THEN 'both' ELSE 'out' END AS direction, e.weight
         FROM skill_edges e WHERE e.src = $2 AND (e.tenant_id IS NULL OR e.tenant_id = $1::uuid)
         UNION ALL
         SELECT e.src, e.edge_type,
                CASE WHEN e.edge_type = 'RELATED_TO' THEN 'both' ELSE 'in' END, e.weight
         FROM skill_edges e WHERE e.dst = $2 AND (e.tenant_id IS NULL OR e.tenant_id = $1::uuid)
       ) x
       JOIN skills s ON s.skill_id = x.other
       ${OVERLAY}
       WHERE ${IN_VIEW} AND ${NOT_HIDDEN}
       ORDER BY x.edge_type, x.weight DESC, s.path::text`,
      [view, skillId],
    );
    return rows.map((r) => ({
      skill: toSkill(r),
      edgeType: r.edge_type,
      direction: r.direction,
      weight: Number(r.weight),
    }));
  }
}

interface OverrideRow {
  tenant_id: string;
  skill_id: string;
  hidden: boolean;
  adopted: boolean;
  display_name: string | null;
  aliases: string[];
  search_keys: string[];
  version: number;
}

/** Tenant-only table: the caller's transaction carries the tenant context. */
@Injectable()
export class PgOverrideRepository implements OverrideRepository {
  async find(tx: Tx, skillId: string): Promise<SkillOverride | null> {
    const { rows } = await tx.query<OverrideRow>(
      `SELECT tenant_id, skill_id, hidden, adopted, display_name, aliases, search_keys, version
       FROM tenant_skill_overrides WHERE skill_id = $1 AND tenant_id = current_tenant_id() FOR UPDATE`,
      [skillId],
    );
    const r = rows[0];
    return r
      ? {
          tenantId: r.tenant_id,
          skillId: r.skill_id,
          hidden: r.hidden,
          adopted: r.adopted,
          displayName: r.display_name,
          aliases: r.aliases,
          searchKeys: r.search_keys,
          version: Number(r.version),
        }
      : null;
  }

  async upsert(tx: Tx, o: SkillOverride, expectedVersion: number | null): Promise<boolean> {
    const values = [
      o.tenantId,
      o.skillId,
      o.hidden,
      o.adopted,
      o.displayName,
      [...o.aliases],
      [...o.searchKeys],
      o.version,
    ];
    if (expectedVersion === null) {
      const { rowCount } = await tx.query(
        `INSERT INTO tenant_skill_overrides (tenant_id, skill_id, hidden, adopted, display_name, aliases, search_keys, version)
         VALUES ($1, $2, $3, $4, $5, $6::text[], $7::text[], $8) ON CONFLICT DO NOTHING`,
        values,
      );
      return rowCount === 1;
    }
    const { rowCount } = await tx.query(
      `UPDATE tenant_skill_overrides SET hidden = $3, adopted = $4, display_name = $5, aliases = $6::text[],
         search_keys = $7::text[], version = $8
       WHERE tenant_id = $1 AND skill_id = $2 AND version = $9`,
      [...values, expectedVersion],
    );
    return rowCount === 1;
  }

  async delete(tx: Tx, skillId: string): Promise<boolean> {
    const { rowCount } = await tx.query(
      `DELETE FROM tenant_skill_overrides WHERE skill_id = $1 AND tenant_id = current_tenant_id()`,
      [skillId],
    );
    return rowCount === 1;
  }
}
