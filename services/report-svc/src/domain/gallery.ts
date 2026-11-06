/** A bound lakehouse parameter (the adapter turns it into a typed literal). */
export type LakehouseParam = { kind: 'varchar'; value: string } | { kind: 'date'; value: string };

/**
 * The skills-intelligence report gallery (Component Prompt 13 §2): fixed lakehouse queries with
 * bound parameters (ADR-0010 consequences). The tenant is always the first parameter, from the
 * caller's token, never from the request.
 */
export interface GalleryParam {
  name: string;
  kind: 'date';
  required: boolean;
  description: string;
}

export interface GalleryReport {
  key: string;
  title: string;
  description: string;
  params: GalleryParam[];
  sql: string;
}

const FROM = {
  name: 'from',
  kind: 'date',
  required: true,
  description: 'First day (YYYY-MM-DD)',
} as const;
const TO = {
  name: 'to',
  kind: 'date',
  required: true,
  description: 'Last day (YYYY-MM-DD)',
} as const;

export const GALLERY: readonly GalleryReport[] = [
  {
    key: 'skill_supply_by_department',
    title: 'Skill supply by department',
    description: 'Employees holding each skill per department, with their mean proficiency.',
    params: [],
    sql: `SELECT department, skill_name, count(*) AS employees, round(avg(proficiency), 2) AS mean_proficiency
FROM intelligence.employee_skills WHERE tenant_id = ?
GROUP BY department, skill_name ORDER BY department, employees DESC`,
  },
  {
    key: 'skill_gap_by_role',
    title: 'Skill gaps by role',
    description: 'Mean role gap per job profile and its share of High gaps.',
    params: [],
    sql: `SELECT job_profile, count(*) AS employees, round(avg(role_gap_pct), 3) AS mean_gap,
  round(avg(CASE WHEN band = 'high' THEN 1.0 ELSE 0.0 END), 3) AS high_share
FROM intelligence.employee_role_gaps WHERE tenant_id = ?
GROUP BY job_profile ORDER BY mean_gap DESC`,
  },
  {
    key: 'assessment_outcomes',
    title: 'Assessment outcomes',
    description: 'Sessions, completion and mean score per assessment over a period.',
    params: [FROM, TO],
    sql: `SELECT assessment_id, count(*) AS sessions,
  count(*) FILTER (WHERE outcome IN ('submitted', 'expired')) AS completed,
  round(avg(overall_score), 2) AS mean_score
FROM assessment.sessions WHERE tenant_id = ? AND submitted_at >= ? AND submitted_at < ? + INTERVAL '1' DAY
GROUP BY assessment_id ORDER BY sessions DESC`,
  },
  {
    key: 'hiring_funnel',
    title: 'Hiring funnel',
    description: 'Candidates per requisition stage over a period.',
    params: [FROM, TO],
    sql: `SELECT requisition_id, stage, count(*) AS candidates
FROM matching.pipeline_stages WHERE tenant_id = ? AND entered_at >= ? AND entered_at < ? + INTERVAL '1' DAY
GROUP BY requisition_id, stage ORDER BY requisition_id, stage`,
  },
];

export function galleryReport(key: string): GalleryReport | undefined {
  return GALLERY.find((g) => g.key === key);
}

/** Binds the tenant and the report's declared parameters in order; anything else is refused. */
export function bindGallery(
  report: GalleryReport,
  tenantId: string,
  params: Record<string, unknown>,
): { params: LakehouseParam[]; problems: string[] } {
  const problems: string[] = [];
  const bound: LakehouseParam[] = [{ kind: 'varchar', value: tenantId }];
  for (const p of report.params) {
    const v = params[p.name];
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
      problems.push(`${p.name}: a date (YYYY-MM-DD) is required`);
      continue;
    }
    bound.push({ kind: 'date', value: v });
  }
  for (const k of Object.keys(params))
    if (!report.params.some((p) => p.name === k))
      problems.push(`${k}: not a parameter of this report`);
  return { params: bound, problems };
}
