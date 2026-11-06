import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { type ObjectStorage } from '../application/ports';

/**
 * S3 (or MinIO). The presigned PUT signs Content-Type, Content-Length and the SHA-256 checksum,
 * so S3 itself rejects an upload whose bytes differ from what the client declared.
 */
export class S3ObjectStorage implements ObjectStorage {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  async presignUpload(input: {
    key: string;
    contentType: string;
    byteSize: number;
    sha256: Buffer;
    expiresInSec: number;
  }): Promise<{ url: string; headers: Record<string, string> }> {
    const checksum = input.sha256.toString('base64');
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      ContentType: input.contentType,
      ContentLength: input.byteSize,
      ChecksumSHA256: checksum,
      ServerSideEncryption: 'aws:kms',
    });
    const url = await getSignedUrl(this.s3, command, {
      expiresIn: input.expiresInSec,
      signableHeaders: new Set(['content-type', 'content-length']),
      // Keep these as signed headers the client must send (the presigner would otherwise move
      // them into the query string, which is also signed but less explicit).
      unhoistableHeaders: new Set(['x-amz-checksum-sha256', 'x-amz-server-side-encryption']),
    });
    return {
      url,
      headers: {
        'Content-Type': input.contentType,
        'Content-Length': String(input.byteSize),
        'x-amz-checksum-sha256': checksum,
        'x-amz-server-side-encryption': 'aws:kms',
      },
    };
  }

  async head(key: string): Promise<{ size: number } | null> {
    try {
      const out = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: Number(out.ContentLength ?? 0) };
    } catch (error) {
      if ((error as { name?: string }).name === 'NotFound') return null;
      throw error;
    }
  }

  async readHead(key: string, bytes: number): Promise<Buffer> {
    const out = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${bytes - 1}` }),
    );
    const body = await out.Body?.transformToByteArray();
    return Buffer.from(body ?? new Uint8Array());
  }

  async delete(keys: readonly string[]): Promise<number> {
    let deleted = 0;
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      if (chunk.length === 0) continue;
      const out = await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      if (out.Errors?.length)
        throw new Error(`S3 could not delete ${out.Errors.length} object(s).`);
      deleted += chunk.length;
    }
    return deleted;
  }

  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    let token: string | undefined;
    do {
      const page = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      deleted += await this.delete((page.Contents ?? []).flatMap((o) => (o.Key ? [o.Key] : [])));
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return deleted;
  }
}

/** In-memory storage for development and tests. `put` stands in for the browser's upload. */
export class MemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, Buffer>();

  put(key: string, content: Buffer): void {
    this.objects.set(key, content);
  }

  presignUpload(input: {
    key: string;
    contentType: string;
    byteSize: number;
    sha256: Buffer;
    expiresInSec: number;
  }): Promise<{ url: string; headers: Record<string, string> }> {
    return Promise.resolve({
      url: `memory://upload/${encodeURIComponent(input.key)}?expires=${input.expiresInSec}`,
      headers: {
        'Content-Type': input.contentType,
        'x-amz-checksum-sha256': input.sha256.toString('base64'),
      },
    });
  }

  head(key: string): Promise<{ size: number } | null> {
    const o = this.objects.get(key);
    return Promise.resolve(o ? { size: o.length } : null);
  }

  readHead(key: string, bytes: number): Promise<Buffer> {
    return Promise.resolve((this.objects.get(key) ?? Buffer.alloc(0)).subarray(0, bytes));
  }

  delete(keys: readonly string[]): Promise<number> {
    let n = 0;
    for (const k of keys) if (this.objects.delete(k)) n += 1;
    return Promise.resolve(n);
  }

  deletePrefix(prefix: string): Promise<number> {
    return this.delete([...this.objects.keys()].filter((k) => k.startsWith(prefix)));
  }
}
