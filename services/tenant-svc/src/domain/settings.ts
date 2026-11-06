import { TenantDomainError } from './errors';

export interface MatchingWeights {
  sem: number;
  cov: number;
  exp: number;
  lex: number;
}

/** Tenant-tunable behaviour (PRD §1.2.3 limits, §2.1 matching weights, §4.1 jurisdictions). */
export interface TenantSettings {
  limits: { api_rps: number; parse_concurrency: number; sandbox_concurrency: number };
  matching: { weights: MatchingWeights };
  features: Record<string, boolean>;
  compliance: { jurisdictions: string[] };
  locale: string;
}

/** Days to keep each data class before the retention pipeline erases it (PRD §4.2). */
export interface RetentionPolicy {
  candidate_inactive_days: number;
  proctoring_frames_days: number;
  interview_audio_days: number;
  assessment_reports_days: number;
}

export const DEFAULT_SETTINGS: TenantSettings = {
  limits: { api_rps: 50, parse_concurrency: 10, sandbox_concurrency: 50 },
  matching: { weights: { sem: 0.4, cov: 0.35, exp: 0.15, lex: 0.1 } },
  features: {},
  compliance: { jurisdictions: [] },
  locale: 'en',
};

export const DEFAULT_RETENTION: RetentionPolicy = {
  candidate_inactive_days: 730,
  proctoring_frames_days: 30,
  interview_audio_days: 180,
  assessment_reports_days: 1095,
};

const FEATURE_KEY = /^[a-z_]+\.[a-z_]+\.[a-z_]+$/;
const WEIGHT_TOLERANCE = 1e-6;

/** Cross-field rules a schema cannot express on its own. */
export function assertSettingsInvariants(settings: TenantSettings): TenantSettings {
  const w = settings.matching.weights;
  const sum = w.sem + w.cov + w.exp + w.lex;
  if (Math.abs(sum - 1) > WEIGHT_TOLERANCE) {
    throw new TenantDomainError(
      'validation',
      'INVALID_SETTINGS',
      `matching.weights must sum to 1 (got ${sum.toFixed(6)}).`,
    );
  }
  const badFeature = Object.keys(settings.features).find((key) => !FEATURE_KEY.test(key));
  if (badFeature !== undefined) {
    throw new TenantDomainError(
      'validation',
      'INVALID_SETTINGS',
      `Feature flag "${badFeature}" must be named <module>.<feature>.<variant>.`,
    );
  }
  return settings;
}

/** JSON with object keys sorted, so `{a, b}` and `{b, a}` compare equal. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/** Top-level keys whose value differs (ignoring key order), for the settings_updated event. */
export function changedKeys(before: object, after: object): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter(
      (key) =>
        canonical((before as Record<string, unknown>)[key]) !==
        canonical((after as Record<string, unknown>)[key]),
    )
    .sort();
}

/**
 * Sections only platform staff may change: `limits` are capacity and cost controls, and
 * `features` gate paid modules. A tenant admin may resend them unchanged (the PUT carries the
 * full document) but not alter them.
 */
export const PLATFORM_MANAGED_SETTINGS = ['features', 'limits'] as const;

export function assertMayChangeSettings(
  before: TenantSettings,
  after: TenantSettings,
  isPlatformStaff: boolean,
): void {
  if (isPlatformStaff) return;
  const blocked = changedKeys(before, after).filter((key) =>
    (PLATFORM_MANAGED_SETTINGS as readonly string[]).includes(key),
  );
  if (blocked.length > 0) {
    throw new TenantDomainError(
      'forbidden',
      'PLATFORM_MANAGED_SETTING',
      `Only platform staff can change: ${blocked.join(', ')}.`,
    );
  }
}
