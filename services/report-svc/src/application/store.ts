/**
 * The persistence port of report-svc (MASTER_ORCHESTRATION_PROMPT §4.1: dependencies point inward).
 * PostgreSQL implementation: ../infrastructure/pg.store.ts.
 */
import { type InterviewSummary, type SessionFacts, type SkillScore } from '../domain/facts';
import { type Tx } from '@atlas/platform';

export interface JobRow {
  reportId: string;
  type: string;
  params: Record<string, unknown>;
  subjectId: string | null;
  requestedBy: string;
  status: string;
  attempts: number;
  error: string | null;
  artifactId: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface ArtifactRow {
  artifactId: string;
  reportId: string;
  storageKey: string;
  contentType: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  subjectId: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface Claimed {
  tenantId: string;
  id: string;
  attempts: number;
}

/** Columns a fact event may set; each upsert touches only its own. */
export type FactPatch = Partial<{
  assessment_id: string;
  assessment_version: number;
  candidate_id: string;
  attempt_no: number;
  started_at: string;
  deadline_at: string;
  submitted_at: string;
  outcome: string;
  terminated_reason: string;
  skills: SkillScore[];
  evaluated_at: string;
}>;

export const REPORT_STORE = Symbol('REPORT_STORE');

export interface ReportStore {
  sections(tx: Tx): Promise<Record<string, boolean> | null>;
  saveSections(
    tx: Tx,
    tenantId: string,
    sections: Record<string, boolean>,
    by: string,
    now: Date,
  ): Promise<void>;
  upsertFacts(
    tx: Tx,
    tenantId: string,
    sessionId: string,
    patch: FactPatch,
    now: Date,
  ): Promise<void>;
  /** Keeps only the newest revision (events can arrive out of order). */
  upsertTrust(
    tx: Tx,
    tenantId: string,
    sessionId: string,
    t: {
      assessmentId: string;
      score: number;
      band: string;
      breakdown: Record<string, number>;
      review: boolean;
      revision: number;
    },
    now: Date,
  ): Promise<void>;
  upsertInterview(
    tx: Tx,
    tenantId: string,
    sessionId: string,
    i: InterviewSummary,
    revision: number,
    now: Date,
  ): Promise<void>;
  facts(tx: Tx, sessionId: string): Promise<SessionFacts | null>;
  /** One page of an assessment's sessions in session order (keyset; exports stream page by page). */
  factsPage(
    tx: Tx,
    assessmentId: string,
    after: string | null,
    limit: number,
  ): Promise<SessionFacts[]>;
  assessmentSkillIds(tx: Tx, assessmentId: string): Promise<string[]>;
  assessmentExists(tx: Tx, assessmentId: string): Promise<boolean>;
  insertJob(
    tx: Tx,
    tenantId: string,
    j: Omit<JobRow, 'status' | 'attempts' | 'error' | 'artifactId' | 'finishedAt'>,
  ): Promise<void>;
  job(tx: Tx, id: string): Promise<JobRow | null>;
  jobs(tx: Tx, requestedBy: string | null, limit: number): Promise<JobRow[]>;
  claimJobs(tx: Tx, now: Date, leaseUntil: Date, limit: number): Promise<Claimed[]>;
  finishJob(tx: Tx, id: string, artifactId: string, now: Date): Promise<void>;
  retryJob(tx: Tx, id: string, until: Date, error: string): Promise<void>;
  failJob(tx: Tx, id: string, error: string, now: Date): Promise<void>;
  insertArtifact(tx: Tx, tenantId: string, a: ArtifactRow): Promise<void>;
  artifact(tx: Tx, id: string): Promise<ArtifactRow | null>;
  /** Erasure: the candidate's facts, jobs and artifacts; returns the storage keys to delete. */
  eraseCandidate(tx: Tx, candidateId: string): Promise<string[]>;
  purgeTenant(tx: Tx): Promise<void>;
}
export {};
