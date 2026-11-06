/** Test doubles for report-svc: PDF renderer, object store, lakehouse, directory, evidence. */
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
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
} from '../../src/application/ports';

/** "PDF" = a marker plus the HTML, so tests can read which sections were rendered. */
export class FakePdfRenderer implements PdfRenderer {
  readonly html: string[] = [];
  failures = 0;
  render(html: string): Promise<Buffer> {
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(new UpstreamError('chromium crashed'));
    }
    this.html.push(html);
    return Promise.resolve(Buffer.concat([Buffer.from('%PDF-1.7 fake\n'), Buffer.from(html)]));
  }
}

export class MemoryArtifactStore implements ArtifactStore {
  readonly objects = new Map<string, { body: Buffer; contentType: string; chunks: number }>();
  readonly deleted: string[] = [];

  async put(key: string, body: Readable, contentType: string): Promise<StoredObject> {
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(Buffer.from(c as Buffer));
    const buf = Buffer.concat(chunks);
    this.objects.set(key, { body: buf, contentType, chunks: chunks.length });
    return { sizeBytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
  }

  get(key: string): Promise<Readable> {
    const o = this.objects.get(key);
    if (!o) return Promise.reject(new Error('NoSuchKey'));
    return Promise.resolve(Readable.from([o.body]));
  }

  delete(keys: string[]): Promise<void> {
    for (const k of keys) {
      this.objects.delete(k);
      this.deleted.push(k);
    }
    return Promise.resolve();
  }

  deletePrefix(prefix: string): Promise<void> {
    for (const k of [...this.objects.keys()]) if (k.startsWith(prefix)) void this.delete([k]);
    this.deleted.push(`${prefix}*`);
    return Promise.resolve();
  }

  only(prefix: string): { key: string; body: Buffer; contentType: string; chunks: number }[] {
    return [...this.objects.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, o]) => ({ key, ...o }));
  }
}

export class FakeLakehouse implements Lakehouse {
  readonly calls: { sql: string; params: LakehouseParam[] }[] = [];
  result: { columns: string[]; rows: unknown[][] } = { columns: [], rows: [] };

  query(sql: string, params: LakehouseParam[]): Promise<LakehouseResult> {
    this.calls.push({ sql, params });
    const rows = this.result.rows;
    async function* gen() {
      for (const r of rows) yield r;
    }
    return Promise.resolve({ columns: this.result.columns, rows: gen() });
  }
}

export class FakeDirectory implements Directory {
  readonly names = new Map<string, string>();
  readonly skills = new Map<string, string>();
  candidateName(_tenantId: string, candidateId: string): Promise<string | null> {
    return Promise.resolve(this.names.get(candidateId) ?? null);
  }
  skillNames(_tenantId: string, ids: string[]): Promise<Map<string, string>> {
    return Promise.resolve(
      new Map(ids.filter((i) => this.skills.has(i)).map((i) => [i, this.skills.get(i) as string])),
    );
  }
}

// 1×1 transparent PNG.
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

export class FakeEvidence implements ProctoringEvidence {
  readonly calls: string[] = [];
  flaggedFrames(_tenantId: string, sessionId: string): Promise<EvidenceFrame[]> {
    this.calls.push(sessionId);
    return Promise.resolve([
      {
        label: 'second face',
        capturedAt: '2026-11-06T09:10:00Z',
        contentType: 'image/png',
        data: PNG,
      },
      {
        label: 'odd type',
        capturedAt: '2026-11-06T09:11:00Z',
        contentType: 'image/svg+xml',
        data: Buffer.from('<svg onload=alert(1)>'),
      },
    ]);
  }
}
