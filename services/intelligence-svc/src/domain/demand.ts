/**
 * Capture Demand (PRD §2.5(iv)): an uploaded sheet of open demands. One row per demand line:
 *
 *   title, account_id, external_ref, job_profile_id, skills, headcount, allocation_pct,
 *   start_date, end_date, location
 *
 * `skills` is `skill_id:weight:target[:must]` items separated by `;`. A row needs skills or a job
 * profile (whose requirements are used). Invalid rows are reported with their line number and
 * never half-loaded.
 */
import { type SkillRequirement } from './readiness';

export const MAX_ROWS = 5000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface DemandInput {
  title: string;
  account_id: string | null;
  external_ref: string | null;
  job_profile_id: string | null;
  skills: (SkillRequirement & { must_have: boolean })[];
  headcount: number;
  allocation_pct: number;
  start_date: string;
  end_date: string | null;
  location: string | null;
}

export interface RowError {
  /** 1-based data row (the header is row 0). */
  row: number;
  message: string;
}

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF, an optional BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Header-keyed records (case-insensitive headers; unknown columns are ignored). */
export function records(table: readonly (readonly string[])[]): Record<string, string>[] {
  const [header, ...body] = table;
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

function validDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function parseSkills(raw: string): DemandInput['skills'] {
  if (!raw) return [];
  return raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      const [id = '', w = '', t = '', must = ''] = item.split(':').map((x) => x.trim());
      const weight = Number(w);
      const target = Number(t);
      if (!UUID.test(id)) throw new Error(`"${id}" is not a skill id`);
      if (!(weight > 0 && weight <= 1)) throw new Error(`the weight of ${id} must be in (0, 1]`);
      if (!(target >= 0 && target <= 5)) throw new Error(`the target of ${id} must be 0-5`);
      return {
        skill_id: id.toLowerCase(),
        weight,
        target_proficiency: target,
        must_have: /^(must|true|yes|1)$/i.test(must),
      };
    });
}

export function parseDemandRows(rows: readonly Record<string, string>[]): {
  demands: DemandInput[];
  errors: RowError[];
} {
  const demands: DemandInput[] = [];
  const errors: RowError[] = [];
  if (rows.length > MAX_ROWS) {
    return { demands, errors: [{ row: 0, message: `At most ${MAX_ROWS} rows per upload.` }] };
  }
  const refs = new Set<string>();
  rows.forEach((r, index) => {
    const row = index + 1;
    const fail = (message: string) => {
      errors.push({ row, message });
    };
    const title = r['title'] ?? '';
    if (!title || title.length > 200) return fail('title is required (at most 200 characters)');
    const profile = r['job_profile_id'] || null;
    if (profile && !UUID.test(profile)) return fail('job_profile_id is not a UUID');
    let skills: DemandInput['skills'];
    try {
      skills = parseSkills(r['skills'] ?? '');
    } catch (error) {
      return fail(`skills: ${(error as Error).message}`);
    }
    if (skills.length === 0 && !profile) return fail('skills or job_profile_id is required');
    const headcount = Number(r['headcount'] || '1');
    if (!Number.isInteger(headcount) || headcount < 1 || headcount > 1000)
      return fail('headcount must be a whole number from 1 to 1000');
    const allocation = Number(r['allocation_pct'] || '100');
    if (!Number.isInteger(allocation) || allocation < 1 || allocation > 100)
      return fail('allocation_pct must be a whole number from 1 to 100');
    const start = r['start_date'] ?? '';
    if (!validDate(start)) return fail('start_date must be a date (YYYY-MM-DD)');
    const end = r['end_date'] || null;
    if (end !== null && (!validDate(end) || end < start))
      return fail('end_date must be a date on or after start_date');
    const account = r['account_id'] || null;
    const ref = r['external_ref'] || null;
    if (ref) {
      const key = `${account ?? ''}|${ref}`;
      if (refs.has(key)) return fail(`external_ref "${ref}" appears twice for this account`);
      refs.add(key);
    }
    demands.push({
      title,
      account_id: account,
      external_ref: ref,
      job_profile_id: profile ? profile.toLowerCase() : null,
      skills,
      headcount,
      allocation_pct: allocation,
      start_date: start,
      end_date: end,
      location: r['location'] || null,
    });
  });
  return { demands, errors };
}
