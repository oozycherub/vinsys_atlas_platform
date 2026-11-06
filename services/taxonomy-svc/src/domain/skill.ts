import { type SkillClassification, type SkillNodeType } from '@atlas/contracts';
import { TaxonomyDomainError } from './errors';
import { assertPath, parentType } from './paths';
import { cleanAliases, searchKeys } from './terms';

/** A node of the skill graph. `tenantId` null = global taxonomy. Immutable value. */
export interface Skill {
  readonly id: string;
  readonly tenantId: string | null;
  readonly nodeType: SkillNodeType;
  readonly path: string;
  readonly name: string;
  readonly description: string | null;
  readonly classification: SkillClassification;
  readonly aliases: readonly string[];
  readonly searchKeys: readonly string[];
  readonly externalId: string | null;
  readonly taxonomyVersion: number;
  readonly deprecatedAt: Date | null;
  readonly replacedBy: string | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A tenant's overlay on a global skill. */
export interface SkillOverride {
  readonly tenantId: string;
  readonly skillId: string;
  readonly hidden: boolean;
  readonly adopted: boolean;
  readonly displayName: string | null;
  readonly aliases: readonly string[];
  readonly searchKeys: readonly string[];
  readonly version: number;
}

export interface NewSkillInput {
  id: string;
  tenantId: string | null;
  nodeType: SkillNodeType;
  path: string;
  name: string;
  description?: string | null;
  classification?: SkillClassification;
  aliases?: readonly string[];
  externalId?: string | null;
  /** The node one level up, or null for a domain. Must be visible in this scope. */
  parent: Skill | null;
  taxonomyVersion: number;
  now: Date;
}

function assertName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 200) {
    throw new TaxonomyDomainError('validation', 'INVALID_NAME', 'Name must be 1–200 characters.');
  }
  return trimmed;
}

/**
 * Creates a node. The parent must be the type one level up, and must not be deprecated; a global
 * node can only hang under a global parent (tenant nodes may hang under either).
 */
export function createSkill(input: NewSkillInput): Skill {
  assertPath(input.path, input.nodeType);
  const expectedParent = parentType(input.nodeType);
  if (expectedParent) {
    if (!input.parent) {
      throw new TaxonomyDomainError(
        'validation',
        'PARENT_NOT_FOUND',
        `The parent ${expectedParent} of "${input.path}" does not exist.`,
      );
    }
    if (
      input.parent.nodeType !== expectedParent ||
      !input.path.startsWith(`${input.parent.path}.`)
    ) {
      throw new TaxonomyDomainError(
        'validation',
        'INVALID_PARENT',
        `A ${input.nodeType} must sit directly under a ${expectedParent}.`,
      );
    }
    if (input.parent.deprecatedAt) {
      throw new TaxonomyDomainError('rule', 'PARENT_DEPRECATED', 'The parent node is deprecated.');
    }
    if (input.tenantId === null && input.parent.tenantId !== null) {
      throw new TaxonomyDomainError(
        'rule',
        'GLOBAL_UNDER_TENANT',
        'A global node cannot sit under a tenant node.',
      );
    }
  }
  const name = assertName(input.name);
  const aliases = cleanAliases(input.aliases ?? []);
  return {
    id: input.id,
    tenantId: input.tenantId,
    nodeType: input.nodeType,
    path: input.path,
    name,
    description: input.description?.trim() || null,
    classification: input.classification ?? 'unclassified',
    aliases,
    searchKeys: searchKeys(name, aliases),
    externalId: input.externalId ?? null,
    taxonomyVersion: input.taxonomyVersion,
    deprecatedAt: null,
    replacedBy: null,
    version: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export interface SkillPatch {
  name?: string;
  description?: string | null;
  classification?: SkillClassification;
  aliases?: readonly string[];
  externalId?: string | null;
}

export function patchSkill(
  skill: Skill,
  patch: SkillPatch,
  taxonomyVersion: number,
  now: Date,
): Skill {
  if (skill.deprecatedAt) {
    throw new TaxonomyDomainError(
      'rule',
      'SKILL_DEPRECATED',
      'A deprecated skill cannot be edited.',
    );
  }
  const name = patch.name !== undefined ? assertName(patch.name) : skill.name;
  const aliases = patch.aliases !== undefined ? cleanAliases(patch.aliases) : skill.aliases;
  return {
    ...skill,
    name,
    aliases,
    searchKeys: searchKeys(name, aliases),
    ...(patch.description !== undefined ? { description: patch.description?.trim() || null } : {}),
    ...(patch.classification !== undefined ? { classification: patch.classification } : {}),
    ...(patch.externalId !== undefined ? { externalId: patch.externalId } : {}),
    taxonomyVersion,
    version: skill.version + 1,
    updatedAt: now,
  };
}

/** True when the change affects what the embedding was computed from. */
export function embeddingInputChanged(before: Skill, after: Skill): boolean {
  return before.name !== after.name || before.description !== after.description;
}

export function embeddingText(skill: Pick<Skill, 'name' | 'description'>): string {
  return skill.description ? `${skill.name}: ${skill.description}` : skill.name;
}

/**
 * Deprecation keeps the row and points at a successor (PRD §2.5). The successor must be the same
 * node type, active, and visible from the deprecated node's scope (a global node cannot be
 * replaced by a tenant node).
 */
export function deprecateSkill(
  skill: Skill,
  successor: Skill | null,
  taxonomyVersion: number,
  now: Date,
): Skill {
  if (skill.deprecatedAt) {
    throw new TaxonomyDomainError('rule', 'SKILL_DEPRECATED', 'The skill is already deprecated.');
  }
  if (successor) {
    if (successor.id === skill.id) {
      throw new TaxonomyDomainError(
        'validation',
        'INVALID_SUCCESSOR',
        'A skill cannot replace itself.',
      );
    }
    if (successor.nodeType !== skill.nodeType) {
      throw new TaxonomyDomainError(
        'validation',
        'INVALID_SUCCESSOR',
        'The successor must be the same node type.',
      );
    }
    if (successor.deprecatedAt) {
      throw new TaxonomyDomainError('rule', 'INVALID_SUCCESSOR', 'The successor is deprecated.');
    }
    if (skill.tenantId === null && successor.tenantId !== null) {
      throw new TaxonomyDomainError(
        'rule',
        'INVALID_SUCCESSOR',
        'A global skill can only be replaced by a global skill.',
      );
    }
  }
  return {
    ...skill,
    deprecatedAt: now,
    replacedBy: successor?.id ?? null,
    taxonomyVersion,
    version: skill.version + 1,
    updatedAt: now,
  };
}

/** Tenants change global skills only through overrides; global skills only via the curator. */
export function assertWritable(skill: Skill, scopeTenantId: string | null): void {
  if (skill.tenantId !== scopeTenantId) {
    throw new TaxonomyDomainError(
      'forbidden',
      skill.tenantId === null ? 'GLOBAL_SKILL_READ_ONLY' : 'NOT_YOUR_SKILL',
      skill.tenantId === null
        ? 'Global skills are changed by the platform curator; use an override instead.'
        : 'This skill belongs to another scope.',
    );
  }
}

export function assertVersion(skill: { version: number }, expected: number): void {
  if (skill.version !== expected) {
    throw new TaxonomyDomainError(
      'precondition_failed',
      'VERSION_MISMATCH',
      `This changed since you read it (current version ${skill.version}). Re-read and retry.`,
    );
  }
}

export interface OverrideInput {
  hidden: boolean;
  adopted: boolean;
  displayName: string | null;
  aliases: readonly string[];
}

/** Overlays apply to global skills only; tenant skills are edited directly. */
export function buildOverride(
  tenantId: string,
  skill: Skill,
  input: OverrideInput,
  previousVersion: number,
): SkillOverride {
  if (skill.tenantId !== null) {
    throw new TaxonomyDomainError(
      'validation',
      'OVERRIDE_ON_TENANT_SKILL',
      'Overrides apply to global skills; edit your own skill directly.',
    );
  }
  if (input.hidden && input.adopted) {
    throw new TaxonomyDomainError(
      'validation',
      'INVALID_OVERRIDE',
      'A skill cannot be both hidden and adopted.',
    );
  }
  const displayName = input.displayName?.trim() || null;
  const aliases = cleanAliases(input.aliases);
  return {
    tenantId,
    skillId: skill.id,
    hidden: input.hidden,
    adopted: input.adopted,
    displayName,
    aliases,
    searchKeys: displayName || aliases.length ? searchKeys(displayName ?? '', aliases) : [],
    version: previousVersion + 1,
  };
}
