import { ProfileDomainError } from './errors';

/** Personally identifying fields. Stored only encrypted (pii_enc); never in profile JSON, events or logs. */
export interface Pii {
  full_name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  /** ISO date (YYYY-MM-DD). */
  dob: string | null;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) {
    throw new ProfileDomainError('validation', 'INVALID_EMAIL', 'The email address is invalid.');
  }
  return email;
}

/** E.164-style: keeps a leading + and digits only; 7–15 digits. */
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) {
    throw new ProfileDomainError('validation', 'INVALID_PHONE', 'The phone number is invalid.');
  }
  return trimmed.startsWith('+') ? `+${digits}` : digits;
}

export function normalizePii(input: {
  full_name: string;
  email?: string | null | undefined;
  phone?: string | null | undefined;
  address?: string | null | undefined;
  dob?: string | null | undefined;
}): Pii {
  const name = input.full_name.trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 200) {
    throw new ProfileDomainError(
      'validation',
      'INVALID_NAME',
      'full_name must be 1–200 characters.',
    );
  }
  const dob = input.dob?.trim() || null;
  if (dob && (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(Date.parse(`${dob}T00:00:00Z`)))) {
    throw new ProfileDomainError(
      'validation',
      'INVALID_DOB',
      'dob must be an ISO date (YYYY-MM-DD).',
    );
  }
  const address = input.address?.trim() || null;
  if (address && address.length > 500) {
    throw new ProfileDomainError(
      'validation',
      'INVALID_ADDRESS',
      'address must be at most 500 characters.',
    );
  }
  return {
    full_name: name,
    email: input.email ? normalizeEmail(input.email) : null,
    phone: input.phone ? normalizePhone(input.phone) : null,
    address,
    dob,
  };
}

export function mergePii(current: Pii, patch: Partial<Pii>): Pii {
  return normalizePii({ ...current, ...patch });
}

/**
 * Keys that must never appear in the non-PII `profile` JSON (it is queryable and copied into
 * read models). Parsers send a redacted profile; this is the guard at the boundary.
 */
const PII_KEYS = new Set([
  'full_name',
  'name',
  'first_name',
  'last_name',
  'email',
  'emails',
  'phone',
  'phones',
  'address',
  'dob',
  'date_of_birth',
  'photo',
]);

export function assertNoPii(profile: unknown, path = 'profile'): void {
  if (Array.isArray(profile)) {
    profile.forEach((v, i) => assertNoPii(v, `${path}[${i}]`));
    return;
  }
  if (profile && typeof profile === 'object') {
    for (const [key, value] of Object.entries(profile as Record<string, unknown>)) {
      if (PII_KEYS.has(key.toLowerCase())) {
        throw new ProfileDomainError(
          'validation',
          'PII_IN_PROFILE',
          `${path}.${key} looks like PII; send it in pii instead.`,
        );
      }
      assertNoPii(value, `${path}.${key}`);
    }
  }
}
