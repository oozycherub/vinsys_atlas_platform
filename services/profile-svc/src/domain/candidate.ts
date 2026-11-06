import { type CandidateSource } from '@atlas/contracts';
import { ProfileDomainError } from './errors';
import { assertNoPii } from './pii';

/** Non-identifying candidate attributes. PII lives encrypted beside it (pii_enc). */
export interface Candidate {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string | null;
  readonly source: CandidateSource;
  readonly externalRef: string | null;
  readonly currentTitle: string | null;
  readonly jobProfileId: string | null;
  readonly department: string | null;
  readonly locationCountry: string | null;
  readonly totalExperienceMonths: number | null;
  readonly profile: Readonly<Record<string, unknown>>;
  readonly profileVersion: number;
  readonly marketplaceOptIn: boolean;
  readonly consent: Readonly<Record<string, unknown>>;
  readonly legalHold: boolean;
  readonly lastActivityAt: Date;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CandidateAttributes {
  userId?: string | null;
  externalRef?: string | null;
  currentTitle?: string | null;
  jobProfileId?: string | null;
  department?: string | null;
  locationCountry?: string | null;
  totalExperienceMonths?: number | null;
  marketplaceOptIn?: boolean;
  consent?: Record<string, unknown>;
  legalHold?: boolean;
}

function clean(attrs: CandidateAttributes): CandidateAttributes {
  const out: CandidateAttributes = { ...attrs };
  if (attrs.locationCountry !== undefined && attrs.locationCountry !== null) {
    const c = attrs.locationCountry.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(c)) {
      throw new ProfileDomainError(
        'validation',
        'INVALID_COUNTRY',
        'location_country must be ISO 3166-1 alpha-2.',
      );
    }
    out.locationCountry = c;
  }
  const months = attrs.totalExperienceMonths;
  if (
    months !== undefined &&
    months !== null &&
    !(Number.isInteger(months) && months >= 0 && months <= 900)
  ) {
    throw new ProfileDomainError(
      'validation',
      'INVALID_EXPERIENCE',
      'total_experience_months must be 0–900.',
    );
  }
  if (attrs.consent) assertNoPii(attrs.consent, 'consent');
  return out;
}

export function createCandidate(input: {
  id: string;
  tenantId: string;
  source: CandidateSource;
  attributes: CandidateAttributes;
  now: Date;
}): Candidate {
  const a = clean(input.attributes);
  return {
    id: input.id,
    tenantId: input.tenantId,
    userId: a.userId ?? null,
    source: input.source,
    externalRef: a.externalRef ?? null,
    currentTitle: a.currentTitle?.trim() || null,
    jobProfileId: a.jobProfileId ?? null,
    department: a.department?.trim() || null,
    locationCountry: a.locationCountry ?? null,
    totalExperienceMonths: a.totalExperienceMonths ?? null,
    profile: {},
    profileVersion: 0,
    marketplaceOptIn: a.marketplaceOptIn ?? false,
    consent: a.consent ?? {},
    legalHold: a.legalHold ?? false,
    lastActivityAt: input.now,
    version: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function patchCandidate(c: Candidate, patch: CandidateAttributes, now: Date): Candidate {
  const a = clean(patch);
  return {
    ...c,
    ...(a.userId !== undefined ? { userId: a.userId } : {}),
    ...(a.externalRef !== undefined ? { externalRef: a.externalRef } : {}),
    ...(a.currentTitle !== undefined ? { currentTitle: a.currentTitle?.trim() || null } : {}),
    ...(a.jobProfileId !== undefined ? { jobProfileId: a.jobProfileId } : {}),
    ...(a.department !== undefined ? { department: a.department?.trim() || null } : {}),
    ...(a.locationCountry !== undefined ? { locationCountry: a.locationCountry } : {}),
    ...(a.totalExperienceMonths !== undefined
      ? { totalExperienceMonths: a.totalExperienceMonths }
      : {}),
    ...(a.marketplaceOptIn !== undefined ? { marketplaceOptIn: a.marketplaceOptIn } : {}),
    ...(a.consent !== undefined ? { consent: a.consent } : {}),
    ...(a.legalHold !== undefined ? { legalHold: a.legalHold } : {}),
    lastActivityAt: now,
    version: c.version + 1,
    updatedAt: now,
  };
}

/** A parsed résumé enriches the profile; the redacted profile JSON is checked for PII again. */
export function applyParsedProfile(
  c: Candidate,
  parsed: {
    profile: Record<string, unknown>;
    currentTitle: string | null;
    totalExperienceMonths: number | null;
  },
  now: Date,
): Candidate {
  assertNoPii(parsed.profile);
  return {
    ...c,
    profile: parsed.profile,
    profileVersion: c.profileVersion + 1,
    currentTitle: parsed.currentTitle ?? c.currentTitle,
    totalExperienceMonths: parsed.totalExperienceMonths ?? c.totalExperienceMonths,
    lastActivityAt: now,
    version: c.version + 1,
    updatedAt: now,
  };
}

export function assertVersion(c: { version: number }, expected: number): void {
  if (c.version !== expected) {
    throw new ProfileDomainError(
      'precondition_failed',
      'VERSION_MISMATCH',
      `This changed since you read it (current version ${c.version}). Re-read and retry.`,
    );
  }
}
