/**
 * The candidate read model (what scoring needs), built from profile events. Everything comes
 * from the REDACTED parsed profile, so names never reach lexical scoring or explanations.
 */

export interface CandidateSkillFeature {
  skill_id: string;
  proficiency: number;
  is_validated: boolean;
}

export interface CandidateFeatures {
  tenantId: string;
  candidateId: string;
  skills: CandidateSkillFeature[];
  evidence: Record<string, string>;
  totalExperienceMonths: number | null;
  currentTitle: string | null;
  profileText: string;
}

interface Role {
  title?: string | null;
  employer?: string | null;
  responsibilities?: string[];
  skills_mentioned?: string[];
}

interface ParsedSkill {
  raw?: string;
  skill_id?: string | null;
  context?: string;
}

const MAX_TEXT = 50_000;
const MAX_SNIPPET = 240;

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** Lexical text: summary, roles, projects, education, certifications and skills. */
export function profileText(profile: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof profile['summary'] === 'string') parts.push(profile['summary']);
  for (const role of (profile['work_history'] as Role[] | undefined) ?? []) {
    parts.push([role.title, role.employer].filter(Boolean).join(' '));
    parts.push(...strings(role.responsibilities), ...strings(role.skills_mentioned));
  }
  for (const key of ['projects', 'education', 'certifications'] as const) {
    for (const item of (profile[key] as Record<string, unknown>[] | undefined) ?? []) {
      parts.push(...Object.values(item).filter((v): v is string => typeof v === 'string'));
    }
  }
  for (const s of (profile['skills'] as ParsedSkill[] | undefined) ?? [])
    if (s.raw) parts.push(s.raw);
  return parts.filter(Boolean).join('\n').slice(0, MAX_TEXT);
}

/** One short supporting snippet per mapped skill: the role line that mentions it, if any. */
export function evidenceSnippets(profile: Record<string, unknown>): Record<string, string> {
  const roles = (profile['work_history'] as Role[] | undefined) ?? [];
  const out: Record<string, string> = {};
  for (const s of (profile['skills'] as ParsedSkill[] | undefined) ?? []) {
    if (!s.skill_id || !s.raw || out[s.skill_id]) continue;
    const needle = s.raw.toLowerCase();
    let snippet: string | undefined;
    for (const role of roles) {
      const hit = strings(role.responsibilities).find((r) => r.toLowerCase().includes(needle));
      if (hit) {
        snippet = `${[role.title, role.employer].filter(Boolean).join(' at ')}: ${hit}`;
        break;
      }
    }
    out[s.skill_id] = (snippet ?? `Listed skill: ${s.raw}`).slice(0, MAX_SNIPPET);
  }
  return out;
}

export function yearsOf(features: Pick<CandidateFeatures, 'totalExperienceMonths'>): number | null {
  return features.totalExperienceMonths === null ? null : features.totalExperienceMonths / 12;
}
