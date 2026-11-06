import { z } from 'zod';
import { defineEvent } from './event';

/**
 * parsing-svc events (docs/prompts/06-parsing-svc.md §5). `profile.resume.parsed.v1` lives in
 * profile-events.ts (its consumer, profile-svc, fixed that contract first). No PII here.
 */
const uuid = z.string().uuid();
const isoTime = z.string().datetime({ offset: true });

export const PARSE_ERROR_CODES = [
  'UNREADABLE_DOCUMENT',
  'ENCRYPTED_DOCUMENT',
  'MALICIOUS_FILE',
  'LLM_UNAVAILABLE',
  'UNSUPPORTED_DOCUMENT',
  'DEPENDENCY_UNAVAILABLE',
] as const;
export type ParseErrorCode = (typeof PARSE_ERROR_CODES)[number];

/** A parse ended without a profile. `retryable` failures are the DLQ: re-parse later. */
export const ResumeParseFailed = defineEvent(
  'profile.resume.parse_failed.v1',
  'document',
  z.object({
    tenant_id: uuid,
    candidate_id: uuid,
    document_id: uuid,
    job_id: uuid,
    error_code: z.enum(PARSE_ERROR_CODES),
    retryable: z.boolean(),
    attempts: z.number().int().min(1),
    occurred_at: isoTime,
  }),
);

export const QUARANTINE_REASONS = [
  'malware',
  'zip_bomb',
  'active_content',
  'mime_mismatch',
] as const;

/** A file failed the security gate and was moved under `quarantine/`. */
export const FileQuarantined = defineEvent(
  'security.file.quarantined.v1',
  'document',
  z.object({
    tenant_id: uuid,
    candidate_id: uuid,
    document_id: uuid,
    quarantine_key: z.string(),
    reason: z.enum(QUARANTINE_REASONS),
    signature: z.string().max(200).nullable(),
    detected_by: z.string(),
    occurred_at: isoTime,
  }),
);
