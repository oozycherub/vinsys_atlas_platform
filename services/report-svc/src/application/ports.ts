import { type Readable } from 'node:stream';
import { type LakehouseParam } from '../domain/gallery';

export type { LakehouseParam };

/** report-svc's outbound ports (adapters in ../infrastructure). */

/** A dependency failed transiently; the job is retried. */
export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamError';
  }
}

/** HTML in, PDF out (headless Chromium in production, ADR-0010 §9). */
export interface PdfRenderer {
  render(html: string): Promise<Buffer>;
}
export const PDF_RENDERER = Symbol('PDF_RENDERER');

export interface StoredObject {
  sizeBytes: number;
  sha256: string;
}

/** Object storage for artifacts. `put` consumes a stream: exports never sit whole in memory. */
export interface ArtifactStore {
  put(key: string, body: Readable, contentType: string): Promise<StoredObject>;
  get(key: string): Promise<Readable>;
  delete(keys: string[]): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
}
export const ARTIFACT_STORE = Symbol('ARTIFACT_STORE');

export interface LakehouseResult {
  columns: string[];
  rows: AsyncIterable<unknown[]>;
}
/** Trino. Parameters are bound by the adapter, never spliced into SQL by callers. */
export interface Lakehouse {
  query(sql: string, params: LakehouseParam[]): Promise<LakehouseResult>;
}
export const LAKEHOUSE = Symbol('LAKEHOUSE');

/** Display names, which are PII and stay with their owners (profile-svc, taxonomy-svc). */
export interface Directory {
  candidateName(tenantId: string, candidateId: string): Promise<string | null>;
  skillNames(tenantId: string, skillIds: string[]): Promise<Map<string, string>>;
}
export const DIRECTORY = Symbol('DIRECTORY');

export interface EvidenceFrame {
  label: string;
  capturedAt: string;
  contentType: string;
  data: Buffer;
}
/** Flagged proctoring frames, fetched only when the report's evidence section is enabled. */
export interface ProctoringEvidence {
  flaggedFrames(tenantId: string, sessionId: string, limit: number): Promise<EvidenceFrame[]>;
}
export const PROCTORING_EVIDENCE = Symbol('PROCTORING_EVIDENCE');

export interface ReportSettings {
  /** Public base URL of report-svc behind the gateway, for signed links. */
  publicBaseUrl: string;
  /** HMAC key for signed artifact links. */
  linkKey: Buffer;
  linkTtlMs: number;
  artifactRetentionMs: number;
  batchSize: number;
  leaseMs: number;
  maxAttempts: number;
}
export const REPORT_SETTINGS = Symbol('REPORT_SETTINGS');
export const REPORT_LOGGER = Symbol('REPORT_LOGGER');
