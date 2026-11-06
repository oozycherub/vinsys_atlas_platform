import { type SkillEvidenceSource } from '@atlas/contracts';
import { type Tx } from '@atlas/platform';
import { type Candidate } from '../domain/candidate';
import { type DocumentMimeType } from '../domain/documents';
import { type Evidence, type FusedSkill, type SourcePolicy } from '../domain/fusion';
import { type PrivacyRequest } from '../domain/privacy';

/** All tables are tenant-scoped (RLS): callers run inside a tenant transaction. */

export interface StoredCandidate {
  candidate: Candidate;
  piiEnc: Buffer;
}

export interface PiiColumns {
  piiEnc: Buffer;
  emailBidx: Buffer | null;
  phoneBidx: Buffer | null;
}

export interface CandidateRepository {
  insert(tx: Tx, candidate: Candidate, pii: PiiColumns): Promise<void>;
  find(tx: Tx, id: string, options?: { forUpdate?: boolean }): Promise<StoredCandidate | null>;
  findIdByEmailIndex(tx: Tx, emailBidx: Buffer): Promise<string | null>;
  list(tx: Tx, filter: { limit: number; after?: { at: Date; id: string } }): Promise<Candidate[]>;
  /** Compare-and-set on version; `pii` undefined keeps the stored ciphertext and indexes. */
  update(tx: Tx, candidate: Candidate, expectedVersion: number, pii?: PiiColumns): Promise<boolean>;
  /** Deletes the candidate (cascade: evidence, current skills, documents). Returns rows removed per table. */
  delete(tx: Tx, id: string): Promise<Record<string, number>>;
  inactiveSince(tx: Tx, cutoff: Date, limit: number): Promise<string[]>;
}

export interface StoredEvidence extends Evidence {
  id: string;
  skillId: string;
  sourceRef: string | null;
  reason: string | null;
  recordedBy: string;
}

export interface CurrentSkill extends FusedSkill {
  skillId: string;
  computedAt: Date;
}

export interface EvidenceRepository {
  /** False when the same (skill, source, source_ref) was already recorded (redelivery). */
  insert(tx: Tx, tenantId: string, candidateId: string, evidence: StoredEvidence): Promise<boolean>;
  forSkill(tx: Tx, candidateId: string, skillId: string): Promise<StoredEvidence[]>;
  forCandidate(tx: Tx, candidateId: string): Promise<StoredEvidence[]>;
  upsertCurrent(
    tx: Tx,
    tenantId: string,
    candidateId: string,
    current: CurrentSkill,
  ): Promise<void>;
  deleteCurrent(tx: Tx, candidateId: string, skillId: string): Promise<void>;
  currentFor(tx: Tx, candidateId: string): Promise<CurrentSkill[]>;
}

export type DocumentStatus =
  | 'pending_upload'
  | 'uploaded'
  | 'parsing'
  | 'parsed'
  | 'failed'
  | 'failed_retryable'
  | 'quarantined';

export interface ResumeDocument {
  id: string;
  tenantId: string;
  candidateId: string;
  storageKey: string;
  sha256: Buffer;
  mimeType: DocumentMimeType;
  byteSize: number;
  status: DocumentStatus;
  flags: string[];
  errorCode: string | null;
  pageCount: number | null;
  language: string | null;
  parserVersion: string | null;
  uploadExpiresAt: Date;
  uploadedAt: Date | null;
  parsedAt: Date | null;
  createdAt: Date;
}

export interface DocumentRepository {
  insert(tx: Tx, doc: ResumeDocument): Promise<void>;
  find(tx: Tx, id: string, options?: { forUpdate?: boolean }): Promise<ResumeDocument | null>;
  findBySha(tx: Tx, sha256: Buffer): Promise<ResumeDocument | null>;
  delete(tx: Tx, id: string): Promise<void>;
  setStatus(
    tx: Tx,
    id: string,
    status: DocumentStatus,
    extra: { uploadedAt?: Date; errorCode?: string | null; flags?: string[] },
  ): Promise<void>;
  applyParsed(
    tx: Tx,
    id: string,
    parsed: {
      parserVersion: string;
      language: string | null;
      pageCount: number | null;
      flags: string[];
      parsedJson: Record<string, unknown>;
      parsedAt: Date;
    },
  ): Promise<void>;
  keysForCandidate(tx: Tx, candidateId: string): Promise<string[]>;
  forCandidate(tx: Tx, candidateId: string): Promise<ResumeDocument[]>;
}

export interface PrivacyRepository {
  insert(tx: Tx, request: PrivacyRequest, exportEnc: Buffer | null): Promise<void>;
  find(
    tx: Tx,
    id: string,
    options?: { forUpdate?: boolean },
  ): Promise<{ request: PrivacyRequest; exportEnc: Buffer | null } | null>;
  update(tx: Tx, request: PrivacyRequest): Promise<void>;
  overdue(tx: Tx, now: Date): Promise<PrivacyRequest[]>;
}

export interface PurgeRepository {
  purgeTenant(tx: Tx): Promise<Record<string, number>>;
}

/** Résumé storage (S3 in production; prefix t/{tenant_id}/resumes/). */
export interface ObjectStorage {
  /** A PUT URL bound to the content type and the declared SHA-256 (S3 rejects a mismatch). */
  presignUpload(input: {
    key: string;
    contentType: string;
    byteSize: number;
    sha256: Buffer;
    expiresInSec: number;
  }): Promise<{ url: string; headers: Record<string, string> }>;
  head(key: string): Promise<{ size: number } | null>;
  /** First `bytes` of the object, for MIME sniffing. */
  readHead(key: string, bytes: number): Promise<Buffer>;
  delete(keys: readonly string[]): Promise<number>;
  deletePrefix(prefix: string): Promise<number>;
}

/** Skill ids from taxonomy-svc, as one tenant sees them: active id (successor if deprecated) or null. */
export interface SkillCatalog {
  resolve(tenantId: string, skillIds: readonly string[]): Promise<Map<string, string | null>>;
}

export interface ProfileSettings {
  /** Services that must acknowledge an erasure (privacy.erasure.acknowledged.v1). */
  erasureConsumers: readonly string[];
  /** Default retention for inactive non-employee candidates (tenant policy: see README). */
  retentionInactiveDays: number;
  fusionPolicy: Readonly<Record<SkillEvidenceSource, SourcePolicy>>;
}

export const CANDIDATE_REPOSITORY = Symbol('CANDIDATE_REPOSITORY');
export const EVIDENCE_REPOSITORY = Symbol('EVIDENCE_REPOSITORY');
export const DOCUMENT_REPOSITORY = Symbol('DOCUMENT_REPOSITORY');
export const PRIVACY_REPOSITORY = Symbol('PRIVACY_REPOSITORY');
export const PURGE_REPOSITORY = Symbol('PURGE_REPOSITORY');
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');
export const SKILL_CATALOG = Symbol('SKILL_CATALOG');
export const FIELD_CIPHER = Symbol('FIELD_CIPHER');
export const PROFILE_SETTINGS = Symbol('PROFILE_SETTINGS');
export const PROFILE_LOGGER = Symbol('PROFILE_LOGGER');
