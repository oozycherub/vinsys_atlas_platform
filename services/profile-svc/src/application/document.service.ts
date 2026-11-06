import { Inject, Injectable } from '@nestjs/common';
import { ResumeUploaded } from '@atlas/contracts';
import {
  appendOutbox,
  CLOCK,
  type Clock,
  ConflictError,
  DATABASE,
  type Database,
  ForbiddenError,
  isUuid,
  newId,
  NotFoundError,
  type Principal,
  withTenantTx,
} from '@atlas/platform';
import { type Logger } from 'pino';
import {
  assertUploadRequest,
  MAX_DOCUMENT_BYTES,
  parseStorageKey,
  sniffMimeType,
  storageKey,
  UPLOAD_URL_TTL_MS,
} from '../domain/documents';
import { canReadPii, tenantOf, translate } from './access';
import { CandidateService } from './candidate.service';
import {
  DOCUMENT_REPOSITORY,
  type DocumentRepository,
  OBJECT_STORAGE,
  type ObjectStorage,
  PROFILE_LOGGER,
} from './ports';
import { toDocumentView } from './views';

const SNIFF_BYTES = 8192;

/**
 * Résumé intake: presigned upload (bound to type and SHA-256), de-duplication by hash, and the
 * storage notification that verifies size and real content type before parsing starts.
 */
@Injectable()
export class DocumentService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PROFILE_LOGGER) private readonly logger: Logger | null,
    private readonly candidates: CandidateService,
  ) {}

  async initiateUpload(
    principal: Principal,
    input: { candidateId: string; mimeType: string; byteSize: number; sha256: string },
    tenantHint?: string,
  ) {
    const tenantId = tenantOf(principal, tenantHint);
    const request = await translate(() => Promise.resolve(assertUploadRequest(input)));
    const documentId = newId();
    const key = storageKey(tenantId, documentId);
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + UPLOAD_URL_TTL_MS);
    await withTenantTx(this.db, tenantId, async (tx) => {
      const { candidate } = await this.candidates.load(tx, principal, input.candidateId);
      if (!canReadPii(principal, candidate) && !principal.roles.includes('service')) {
        throw new ForbiddenError(
          'Uploading documents requires access to the candidate’s personal data.',
        );
      }
      const existing = await this.documents.findBySha(tx, request.sha256);
      if (existing) {
        // An upload that was started but never finished does not block the same file forever.
        if (
          existing.status === 'pending_upload' &&
          existing.uploadExpiresAt.getTime() <= now.getTime()
        ) {
          await this.documents.delete(tx, existing.id);
        } else {
          throw new ConflictError('DOCUMENT_DUPLICATE', 'This document was already uploaded.', {
            document_id: existing.id,
          });
        }
      }
      await this.documents.insert(tx, {
        id: documentId,
        tenantId,
        candidateId: input.candidateId,
        storageKey: key,
        sha256: request.sha256,
        mimeType: request.mimeType,
        byteSize: request.byteSize,
        status: 'pending_upload',
        flags: [],
        errorCode: null,
        pageCount: null,
        language: null,
        parserVersion: null,
        uploadExpiresAt: expiresAt,
        uploadedAt: null,
        parsedAt: null,
        createdAt: now,
      });
    });
    const upload = await this.storage.presignUpload({
      key,
      contentType: request.mimeType,
      byteSize: request.byteSize,
      sha256: request.sha256,
      expiresInSec: UPLOAD_URL_TTL_MS / 1000,
    });
    return {
      document_id: documentId,
      upload_url: upload.url,
      upload_headers: upload.headers,
      expires_at: expiresAt.toISOString(),
    };
  }

  async get(principal: Principal, id: string, tenantHint?: string) {
    const tenantId = tenantOf(principal, tenantHint);
    return withTenantTx(this.db, tenantId, async (tx) => {
      const doc = isUuid(id) ? await this.documents.find(tx, id) : null;
      if (!doc) throw new NotFoundError('DOCUMENT_NOT_FOUND', 'Document not found.');
      await this.candidates.load(tx, principal, doc.candidateId);
      return toDocumentView(doc);
    });
  }

  /**
   * Storage notification (S3 ObjectCreated): checks the object really is what was declared, then
   * hands it to parsing. Repeated notifications are no-ops. Returns the resulting status.
   */
  async objectCreated(key: string): Promise<string> {
    const ids = parseStorageKey(key);
    if (!ids) return 'ignored';
    const head = await this.storage.head(key);
    const bytes = head ? await this.storage.readHead(key, SNIFF_BYTES) : Buffer.alloc(0);
    return withTenantTx(this.db, ids.tenantId, async (tx) => {
      const doc = await this.documents.find(tx, ids.documentId, { forUpdate: true });
      if (!doc || doc.status !== 'pending_upload') return doc?.status ?? 'ignored';
      const sniffed = sniffMimeType(bytes);
      const problem = !head
        ? 'object_missing'
        : head.size !== doc.byteSize || head.size > MAX_DOCUMENT_BYTES
          ? 'size_mismatch'
          : sniffed !== doc.mimeType
            ? 'mime_mismatch'
            : null;
      if (problem) {
        await this.documents.setStatus(tx, doc.id, 'quarantined', {
          errorCode: problem,
          flags: [problem],
        });
        this.logger?.warn(
          { tenant_id: ids.tenantId, document_id: doc.id, reason: problem },
          'upload quarantined',
        );
        return 'quarantined';
      }
      const now = this.clock.now();
      await this.documents.setStatus(tx, doc.id, 'uploaded', { uploadedAt: now });
      await appendOutbox(
        tx,
        ResumeUploaded.build({
          tenantId: ids.tenantId,
          aggregateId: doc.id,
          payload: {
            tenant_id: ids.tenantId,
            candidate_id: doc.candidateId,
            document_id: doc.id,
            storage_key: doc.storageKey,
            mime_type: doc.mimeType,
            sha256: doc.sha256.toString('hex'),
            byte_size: doc.byteSize,
            occurred_at: now.toISOString(),
          },
        }),
      );
      return 'uploaded';
    });
  }
}
