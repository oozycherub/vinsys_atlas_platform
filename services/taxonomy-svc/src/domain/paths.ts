import { type SkillNodeType } from '@atlas/contracts';
import { TaxonomyDomainError } from './errors';

const LABEL = /^[a-z0-9_]{1,64}$/;
export const DEPTH: Readonly<Record<SkillNodeType, number>> = {
  domain: 1,
  subdomain: 2,
  cluster: 3,
  skill: 4,
};
const PARENT_TYPE: Readonly<Record<SkillNodeType, SkillNodeType | null>> = {
  domain: null,
  subdomain: 'domain',
  cluster: 'subdomain',
  skill: 'cluster',
};

/**
 * Validates an ltree path for a node type: lower-case labels of [a-z0-9_], and the depth the
 * hierarchy Domain → Sub-domain → Cluster → Skill fixes for that type.
 */
export function assertPath(path: string, nodeType: SkillNodeType): string[] {
  const labels = path.split('.');
  if (labels.some((l) => !LABEL.test(l))) {
    throw new TaxonomyDomainError(
      'validation',
      'INVALID_PATH',
      'Path labels must be 1–64 characters of a-z, 0-9 or _, separated by dots.',
    );
  }
  if (labels.length !== DEPTH[nodeType]) {
    throw new TaxonomyDomainError(
      'validation',
      'PATH_DEPTH_MISMATCH',
      `A ${nodeType} sits at depth ${DEPTH[nodeType]}; "${path}" has depth ${labels.length}.`,
    );
  }
  return labels;
}

export function parentPath(path: string): string | null {
  const i = path.lastIndexOf('.');
  return i < 0 ? null : path.slice(0, i);
}

export function parentType(nodeType: SkillNodeType): SkillNodeType | null {
  return PARENT_TYPE[nodeType];
}

/** "Cash flow analysis" → "cash_flow_analysis" (for imports that omit a label). */
export function slugLabel(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\+/g, 'plus')
    .replace(/#/g, 'sharp')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}
