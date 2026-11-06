import { ProfileDomainError } from './errors';

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const UPLOAD_URL_TTL_MS = 15 * 60 * 1000;

export const DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'image/png',
  'image/jpeg',
  'text/plain',
] as const;
export type DocumentMimeType = (typeof DOCUMENT_MIME_TYPES)[number];

export function storageKey(tenantId: string, documentId: string): string {
  return `t/${tenantId}/resumes/${documentId}`;
}

export function tenantPrefix(tenantId: string): string {
  return `t/${tenantId}/`;
}

/** `t/{tenant}/resumes/{document}` → ids, or null for anything else. */
export function parseStorageKey(key: string): { tenantId: string; documentId: string } | null {
  const m = /^t\/([0-9a-f-]{36})\/resumes\/([0-9a-f-]{36})$/.exec(key);
  return m?.[1] && m[2] ? { tenantId: m[1], documentId: m[2] } : null;
}

export function assertUploadRequest(input: {
  mimeType: string;
  byteSize: number;
  sha256: string;
}): {
  mimeType: DocumentMimeType;
  byteSize: number;
  sha256: Buffer;
} {
  if (!(DOCUMENT_MIME_TYPES as readonly string[]).includes(input.mimeType)) {
    throw new ProfileDomainError(
      'validation',
      'UNSUPPORTED_MIME_TYPE',
      'Upload PDF, Word, PNG, JPEG or plain text.',
    );
  }
  if (
    !Number.isInteger(input.byteSize) ||
    input.byteSize < 1 ||
    input.byteSize > MAX_DOCUMENT_BYTES
  ) {
    throw new ProfileDomainError(
      'validation',
      'DOCUMENT_TOO_LARGE',
      'Documents must be 1 byte to 10 MB.',
    );
  }
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) {
    throw new ProfileDomainError(
      'validation',
      'INVALID_SHA256',
      'sha256 must be 64 lowercase hex characters.',
    );
  }
  return {
    mimeType: input.mimeType as DocumentMimeType,
    byteSize: input.byteSize,
    sha256: Buffer.from(input.sha256, 'hex'),
  };
}

function startsWith(head: Uint8Array, bytes: readonly number[]): boolean {
  return bytes.every((b, i) => head[i] === b);
}

/**
 * The content type the bytes actually are (magic numbers), or null if they match no allowed
 * type. A declared type that the bytes contradict means the upload is quarantined.
 */
export function sniffMimeType(head: Uint8Array): DocumentMimeType | null {
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'; // %PDF-
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
    return 'application/msword';
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {
    // OOXML is a zip; a Word document carries "word/" entries near the start.
    return Buffer.from(head).includes('word/')
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : null;
  }
  const text = Buffer.from(head);
  if (text.length > 0 && !text.includes(0)) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(
        text.subarray(0, Math.max(0, text.length - 4)),
      );
      return 'text/plain';
    } catch {
      return null;
    }
  }
  return null;
}
