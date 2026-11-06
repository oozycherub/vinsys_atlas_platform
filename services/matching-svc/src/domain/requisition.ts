/** Job requisitions: lifecycle, calibration snapshot and the text used for retrieval. */
import { type Requirement } from '@atlas/scoring';

export const REQUISITION_STATUSES = ['open', 'on_hold', 'closed'] as const;
export type RequisitionStatus = (typeof REQUISITION_STATUSES)[number];
export type CalibrationStatus = 'uncalibrated' | 'calibrated' | 'stale';

export interface CalibrationSkill {
  skill_id: string;
  name: string | null;
  weight: number;
  target: number;
  must_have: boolean;
  related: { skill_id: string; rho: number }[];
}

export interface Calibration {
  source: 'job_profile' | 'manual';
  job_profile_version: number | null;
  skills: CalibrationSkill[];
  embedding_model: string;
  /** Text embedded as ē_j, and the BM25 query. */
  embedded_text: string;
  lexical_query: string;
}

export interface Requisition {
  tenantId: string;
  id: string;
  title: string;
  description: string;
  openings: number;
  location: string | null;
  hiringManagerId: string | null;
  jobProfileId: string | null;
  minExperienceYears: number | null;
  keywords: string[];
  status: RequisitionStatus;
  calibrationStatus: CalibrationStatus;
  calibration: Calibration | null;
  calibrationVersion: number;
  calibratedAt: Date | null;
  version: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export type RequisitionPatch = Partial<
  Pick<
    Requisition,
    | 'title'
    | 'description'
    | 'openings'
    | 'location'
    | 'hiringManagerId'
    | 'jobProfileId'
    | 'minExperienceYears'
    | 'keywords'
    | 'status'
  >
>;

/** Fields that change what the requisition asks for; editing them makes a calibration stale. */
const SCORING_FIELDS: (keyof RequisitionPatch)[] = [
  'title',
  'description',
  'jobProfileId',
  'minExperienceYears',
  'keywords',
];

export function applyPatch(r: Requisition, patch: RequisitionPatch): Requisition {
  const next: Requisition = { ...r, ...patch };
  const scoringChanged = SCORING_FIELDS.some(
    (k) => k in patch && JSON.stringify(patch[k]) !== JSON.stringify(r[k]),
  );
  if (scoringChanged && r.calibrationStatus === 'calibrated') next.calibrationStatus = 'stale';
  return next;
}

export function requirements(c: Calibration): Requirement[] {
  return c.skills.map((s) => ({
    skillId: s.skill_id,
    weight: s.weight,
    target: s.target,
    mustHave: s.must_have,
    related: s.related.map((x) => ({ skillId: x.skill_id, rho: x.rho })),
  }));
}

/** ē_j input: the job description plus the required-skill text (PRD §2.1(b)). */
export function embeddedText(r: Requisition, skills: CalibrationSkill[]): string {
  const named = skills.map((s) => s.name).filter((n): n is string => Boolean(n));
  return [
    r.title,
    r.description,
    named.length ? `Required skills: ${named.join(', ')}` : '',
    r.keywords.length ? `Keywords: ${r.keywords.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 8000);
}

export function lexicalQuery(r: Requisition, skills: CalibrationSkill[]): string {
  const terms = [r.title, ...r.keywords, ...skills.map((s) => s.name ?? '')]
    .flatMap((t) => t.split(/[^\p{L}\p{N}+#.]+/u))
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  return [...new Set(terms.map((t) => t.toLowerCase()))].slice(0, 64).join(' ');
}

/** A requisition that has a calibration snapshot (and so can be scored). */
export type Calibrated = Requisition & { calibration: Calibration };

export function isCalibrated(r: Requisition): r is Calibrated {
  return r.calibration !== null;
}

export function isScorable(r: Requisition): r is Calibrated {
  return r.status !== 'closed' && isCalibrated(r);
}
