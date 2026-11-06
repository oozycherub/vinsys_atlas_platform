import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { type Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { type Browser } from 'playwright-core';
import {
  type ArtifactStore,
  type Directory,
  type EvidenceFrame,
  type Lakehouse,
  type LakehouseParam,
  type LakehouseResult,
  type PdfRenderer,
  type ProctoringEvidence,
  type StoredObject,
  UpstreamError,
} from '../application/ports';

/** Counts and hashes bytes as they stream past. */
function meter(): { stream: Transform; result: () => StoredObject } {
  const hash = createHash('sha256');
  let size = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk);
      size += chunk.length;
      done(null, chunk);
    },
  });
  return { stream, result: () => ({ sizeBytes: size, sha256: hash.digest('hex') }) };
}

// --- PDF ------------------------------------------------------------------------------------

/**
 * Headless Chromium (ADR-0010 §9): one browser, at most `concurrency` pages at a time. Pages run
 * with JavaScript off and every network request refused: the HTML is self-contained.
 */
export class ChromiumPdfRenderer implements PdfRenderer {
  private browser: Promise<Browser> | null = null;
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly launch: () => Promise<Browser>,
    private readonly concurrency = 4,
    private readonly timeoutMs = 10_000,
  ) {}

  private async acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active -= 1;
  }

  private async browserOnce(): Promise<Browser> {
    if (!this.browser) {
      this.browser = this.launch().then((b) => {
        b.on('disconnected', () => (this.browser = null));
        return b;
      });
      this.browser.catch(() => (this.browser = null));
    }
    return this.browser;
  }

  async render(html: string): Promise<Buffer> {
    await this.acquire();
    try {
      const browser = await this.browserOnce();
      const context = await browser.newContext({ javaScriptEnabled: false, offline: true });
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(this.timeoutMs);
        await page.route('**/*', (route) => route.abort());
        await page.setContent(html, { waitUntil: 'load', timeout: this.timeoutMs });
        return await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
      } finally {
        await context.close();
      }
    } finally {
      this.release();
    }
  }

  async close(): Promise<void> {
    const b = await this.browser?.catch(() => null);
    await b?.close();
  }
}

// --- Storage --------------------------------------------------------------------------------

/** Local disk (development and single-node installs). Keys are confined to the root. */
export class FsArtifactStore implements ArtifactStore {
  constructor(private readonly root: string) {}

  private file(key: string): string {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep))
      throw new Error('invalid storage key');
    return full;
  }

  async put(key: string, body: Readable): Promise<StoredObject> {
    const file = this.file(key);
    await mkdir(path.dirname(file), { recursive: true });
    const m = meter();
    await pipeline(body, m.stream, createWriteStream(file));
    return m.result();
  }

  get(key: string): Promise<Readable> {
    return Promise.resolve(createReadStream(this.file(key)));
  }

  async delete(keys: string[]): Promise<void> {
    for (const k of keys) await unlink(this.file(k)).catch(() => undefined);
  }

  async deletePrefix(prefix: string): Promise<void> {
    await rm(this.file(prefix.replace(/\/$/, '')), { recursive: true, force: true });
  }
}

/** S3 with multipart streaming uploads (no full buffering) and server-side encryption. */
export class S3ArtifactStore implements ArtifactStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    private readonly kmsKeyId?: string,
  ) {}

  async put(key: string, body: Readable, contentType: string): Promise<StoredObject> {
    const m = meter();
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: body.pipe(m.stream),
        ContentType: contentType,
        ...(this.kmsKeyId ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: this.kmsKeyId } : {}),
      },
    });
    await upload.done();
    return m.result();
  }

  async get(key: string): Promise<Readable> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return out.Body as Readable;
  }

  async delete(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      const keys = (page.Contents ?? []).map((o) => o.Key).filter((k): k is string => !!k);
      if (keys.length) await this.delete(keys);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
}

// --- Trino ----------------------------------------------------------------------------------

export function trinoLiteral(p: LakehouseParam): string {
  if (p.kind === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.value)) throw new Error('invalid date parameter');
    return `DATE '${p.value}'`;
  }
  return `'${p.value.replace(/'/g, "''")}'`;
}

interface TrinoResponse {
  nextUri?: string;
  columns?: { name: string }[];
  data?: unknown[][];
  error?: { message?: string; errorName?: string };
}

/**
 * Trino's REST protocol (`POST /v1/statement`, then follow `nextUri`). Parameters are bound with
 * `EXECUTE IMMEDIATE … USING`, never concatenated into the query text.
 */
export class TrinoLakehouse implements Lakehouse {
  constructor(
    private readonly o: {
      baseUrl: string;
      user: string;
      catalog: string;
      fetch?: typeof fetch;
      timeoutMs?: number;
    },
  ) {}

  private async step(url: string, init: RequestInit): Promise<TrinoResponse> {
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(url, {
        ...init,
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
      });
    } catch (error) {
      throw new UpstreamError(`trino: ${(error as Error).name}`);
    }
    if (res.status === 429 || res.status === 503)
      throw new UpstreamError(`trino: HTTP ${res.status}`);
    if (!res.ok) throw new Error(`trino: HTTP ${res.status}`);
    const body = (await res.json()) as TrinoResponse;
    if (body.error)
      throw new Error(
        `trino: ${body.error.errorName ?? 'error'}: ${body.error.message ?? ''}`.trim(),
      );
    return body;
  }

  async query(sql: string, params: LakehouseParam[]): Promise<LakehouseResult> {
    const statement = params.length
      ? `EXECUTE IMMEDIATE '${sql.replace(/'/g, "''")}' USING ${params.map(trinoLiteral).join(', ')}`
      : sql;
    let page = await this.step(`${this.o.baseUrl.replace(/\/$/, '')}/v1/statement`, {
      method: 'POST',
      headers: {
        'X-Trino-User': this.o.user,
        'X-Trino-Catalog': this.o.catalog,
        'Content-Type': 'text/plain',
      },
      body: statement,
    });
    const headers = { 'X-Trino-User': this.o.user };
    // Columns arrive with the first page that has them; the data streams in later pages.
    const buffered: unknown[][] = [...(page.data ?? [])];
    while (!page.columns && page.nextUri) {
      page = await this.step(page.nextUri, { headers });
      buffered.push(...(page.data ?? []));
    }
    const columns = (page.columns ?? []).map((c) => c.name);
    let next = page.nextUri;
    const step = (u: string) => this.step(u, { headers });
    async function* rows(): AsyncGenerator<unknown[]> {
      yield* buffered;
      while (next) {
        const p = await step(next);
        yield* p.data ?? [];
        next = p.nextUri;
      }
    }
    return { columns, rows: rows() };
  }
}

// --- Directory and evidence ---------------------------------------------------------------

export interface HttpOptions {
  baseUrl: string;
  token: () => Promise<string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

async function get(o: HttpOptions, pathAndQuery: string): Promise<Response> {
  try {
    const res = await (o.fetch ?? fetch)(`${o.baseUrl.replace(/\/$/, '')}${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${await o.token()}` },
      signal: AbortSignal.timeout(o.timeoutMs ?? 5000),
    });
    if (res.status === 429 || res.status >= 500)
      throw new UpstreamError(`${pathAndQuery.split('?')[0]}: HTTP ${res.status}`);
    return res;
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError(`${pathAndQuery.split('?')[0]}: ${(error as Error).name}`);
  }
}

/**
 * Names from profile-svc and taxonomy-svc. A missing name renders as an id; a failing service
 * fails the job (it is retried) rather than producing a report with gaps.
 */
export class HttpDirectory implements Directory {
  constructor(
    private readonly profiles: HttpOptions,
    private readonly taxonomy: HttpOptions,
  ) {}

  async candidateName(tenantId: string, candidateId: string): Promise<string | null> {
    const res = await get(this.profiles, `/v1/candidates/${candidateId}?tenant_id=${tenantId}`);
    if (!res.ok) return null;
    return ((await res.json()) as { full_name?: string }).full_name ?? null;
  }

  async skillNames(tenantId: string, skillIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const id of skillIds) {
      const res = await get(this.taxonomy, `/v1/skills/${id}?tenant_id=${tenantId}`);
      if (res.ok) out.set(id, ((await res.json()) as { name: string }).name);
    }
    return out;
  }
}

/** proctoring-svc's evidence timeline: flagged rows with signed frame URLs (15 min). */
export class HttpProctoringEvidence implements ProctoringEvidence {
  constructor(
    private readonly o: HttpOptions,
    private readonly maxFrameBytes = 2_000_000,
  ) {}

  async flaggedFrames(
    tenantId: string,
    sessionId: string,
    limit: number,
  ): Promise<EvidenceFrame[]> {
    const res = await get(
      this.o,
      `/v1/proctoring/sessions/${sessionId}/timeline?tenant_id=${tenantId}`,
    );
    if (res.status === 404) return [];
    if (!res.ok) throw new UpstreamError(`timeline: HTTP ${res.status}`);
    const timeline = (await res.json()) as {
      entries: { event_type: string; severity: number; occurred_at: string; frame_url?: string }[];
    };
    const flagged = timeline.entries.filter((e) => e.frame_url && e.severity > 0).slice(0, limit);
    const frames: EvidenceFrame[] = [];
    for (const e of flagged) {
      const img = await (this.o.fetch ?? fetch)(e.frame_url as string, {
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 5000),
      });
      const type = img.headers.get('content-type') ?? '';
      const data = Buffer.from(await img.arrayBuffer());
      if (!img.ok || !type.startsWith('image/') || data.length > this.maxFrameBytes) continue;
      frames.push({
        label: e.event_type.replace(/_/g, ' '),
        capturedAt: e.occurred_at,
        contentType: type.split(';')[0] as string,
        data,
      });
    }
    return frames;
  }
}

export function s3Client(region: string, endpoint?: string): S3Client {
  return new S3Client({ region, ...(endpoint ? { endpoint, forcePathStyle: true } : {}) });
}
