/**
 * Candidate report sections (PRD feature inventory §3.2 "Report Settings", Component Prompt 13 §6).
 * Mandatory sections are always present; proctoring images appear only when their section is on.
 */
export const SECTIONS = {
  summary: { mandatory: true, default: true, title: 'Summary' },
  skill_scores: { mandatory: true, default: true, title: 'Skill scores' },
  integrity: { mandatory: false, default: true, title: 'Integrity (Trust Score)' },
  proctoring_evidence: { mandatory: false, default: false, title: 'Proctoring evidence' },
  ai_interview: { mandatory: false, default: true, title: 'AI interview' },
} as const;

export type SectionKey = keyof typeof SECTIONS;
export const SECTION_KEYS = Object.keys(SECTIONS) as SectionKey[];

export type SectionConfig = Record<SectionKey, boolean>;

export function defaultSections(): SectionConfig {
  return Object.fromEntries(SECTION_KEYS.map((k) => [k, SECTIONS[k].default])) as SectionConfig;
}

/** The tenant's stored config, normalised: unknown keys dropped, mandatory forced on. */
export function normaliseSections(stored: Partial<Record<string, boolean>> | null): SectionConfig {
  const out = defaultSections();
  for (const k of SECTION_KEYS) {
    const v = stored?.[k];
    if (typeof v === 'boolean') out[k] = v;
    if (SECTIONS[k].mandatory) out[k] = true;
  }
  return out;
}

/**
 * Sections for one report: the tenant's config, optionally narrowed by the request. A request can
 * leave optional sections out; it cannot add one the tenant has switched off, nor drop a mandatory one.
 */
export function effectiveSections(
  tenant: SectionConfig,
  requested: readonly string[] | null,
): SectionConfig {
  const out = { ...tenant };
  if (requested) {
    const wanted = new Set(requested);
    for (const k of SECTION_KEYS) if (!SECTIONS[k].mandatory && !wanted.has(k)) out[k] = false;
  }
  return out;
}
