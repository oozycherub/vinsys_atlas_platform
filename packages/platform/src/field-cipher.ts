import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { type Clock, systemClock } from './clock';
import { type KeyEncryption } from './key-encryption';

/** Plaintext tenant data keys, by version. Implemented by TenantKeyCache. */
export interface TenantKeys {
  active(tenantId: string): Promise<{ version: number; key: Buffer }>;
  byVersion(tenantId: string, version: number): Promise<Buffer>;
  /** Per-tenant HMAC key for blind indexes; stable across DEK rotation. */
  blindIndexKey(tenantId: string): Promise<Buffer>;
}

export class TenantKeysUnavailableError extends Error {
  constructor(tenantId: string, detail: string) {
    super(`Data keys for tenant ${tenantId} are unavailable: ${detail}`);
    this.name = 'TenantKeysUnavailableError';
  }
}

const FORMAT = 1;
const HEADER = 1 + 2; // format, dek version (u16 BE)
const IV = 12;
const TAG = 16;

/**
 * Application-level field encryption with the tenant DEK (PRD §4.2): AES-256-GCM, a fresh IV per
 * value, and AAD = `tenant_id|<record id>|<field>` so a ciphertext cannot be moved to another
 * tenant, record or column. Layout: format(1) ‖ dek_version(2) ‖ iv(12) ‖ tag(16) ‖ ciphertext.
 * The embedded version lets values written before a key rotation still decrypt.
 */
export class FieldCipher {
  constructor(private readonly keys: TenantKeys) {}

  async encrypt(
    tenantId: string,
    aad: readonly string[],
    plaintext: Buffer | string,
  ): Promise<Buffer> {
    const { version, key } = await this.keys.active(tenantId);
    const iv = randomBytes(IV);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from([tenantId, ...aad].join('|'), 'utf8'));
    const body = Buffer.concat([
      cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext),
      cipher.final(),
    ]);
    const header = Buffer.alloc(HEADER);
    header.writeUInt8(FORMAT, 0);
    header.writeUInt16BE(version, 1);
    return Buffer.concat([header, iv, cipher.getAuthTag(), body]);
  }

  async decrypt(tenantId: string, aad: readonly string[], blob: Uint8Array): Promise<Buffer> {
    const buf = Buffer.from(blob);
    if (buf.length < HEADER + IV + TAG || buf.readUInt8(0) !== FORMAT) {
      throw new Error('Unsupported field ciphertext format.');
    }
    const key = await this.keys.byVersion(tenantId, buf.readUInt16BE(1));
    const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(HEADER, HEADER + IV));
    decipher.setAAD(Buffer.from([tenantId, ...aad].join('|'), 'utf8'));
    decipher.setAuthTag(buf.subarray(HEADER + IV, HEADER + IV + TAG));
    return Buffer.concat([decipher.update(buf.subarray(HEADER + IV + TAG)), decipher.final()]);
  }

  async encryptJson(tenantId: string, aad: readonly string[], value: unknown): Promise<Buffer> {
    return this.encrypt(tenantId, aad, JSON.stringify(value));
  }

  async decryptJson<T>(tenantId: string, aad: readonly string[], blob: Uint8Array): Promise<T> {
    return JSON.parse((await this.decrypt(tenantId, aad, blob)).toString('utf8')) as T;
  }

  /** Version of the DEK a ciphertext was written with (for re-encryption jobs). */
  static keyVersion(blob: Uint8Array): number {
    return Buffer.from(blob).readUInt16BE(1);
  }

  /**
   * Keyed blind index (HMAC-SHA256) for exact-match lookups on encrypted values. The key is per
   * tenant, so equal values in two tenants never produce equal indexes. `purpose` separates
   * columns (email vs phone). Callers normalise the value first.
   */
  async blindIndex(tenantId: string, purpose: string, normalizedValue: string): Promise<Buffer> {
    const key = await this.keys.blindIndexKey(tenantId);
    return createHmac('sha256', key).update(`${purpose}\u0000${normalizedValue}`, 'utf8').digest();
  }
}

/** Wrapped DEK versions as tenant-svc serves them (GET /v1/tenants/{id}/data-keys). */
export interface WrappedTenantKey {
  version: number;
  kmsKeyRef: string;
  wrappedKey: Buffer;
  active: boolean;
}

export interface WrappedKeySource {
  fetch(tenantId: string): Promise<WrappedTenantKey[]>;
}

interface CachedKeys {
  loadedAt: number;
  keys: Map<number, Buffer>;
  activeVersion: number;
  blindIndexKey: Buffer;
}

/** Encryption context tenant-svc binds into every wrapped DEK. */
export const TENANT_DEK_CONTEXT = 'tenant-dek';
const BLIND_INDEX_INFO = 'atlas/blind-index/v1';

/**
 * Plaintext tenant DEKs for one service, unwrapped with the service's own KMS access and kept in
 * memory for at most `ttlMs` (default 15 minutes, PRD §4.2). The blind-index key is derived
 * (HKDF-SHA256) from the tenant's oldest live DEK version, so rotation does not invalidate
 * existing indexes, and purge (which destroys every version) destroys it too.
 */
export class TenantKeyCache implements TenantKeys {
  private readonly cache = new Map<string, CachedKeys>();
  private readonly loading = new Map<string, Promise<CachedKeys>>();

  constructor(
    private readonly source: WrappedKeySource,
    private readonly kms: KeyEncryption,
    private readonly options: { clock?: Clock; ttlMs?: number } = {},
  ) {}

  async active(tenantId: string): Promise<{ version: number; key: Buffer }> {
    const entry = await this.entry(tenantId);
    const key = entry.keys.get(entry.activeVersion);
    if (!key) throw new TenantKeysUnavailableError(tenantId, 'no active key');
    return { version: entry.activeVersion, key };
  }

  async byVersion(tenantId: string, version: number): Promise<Buffer> {
    let entry = await this.entry(tenantId);
    if (!entry.keys.has(version)) entry = await this.entry(tenantId, true); // rotated since load
    const key = entry.keys.get(version);
    if (!key) throw new TenantKeysUnavailableError(tenantId, `version ${version} is not available`);
    return key;
  }

  async blindIndexKey(tenantId: string): Promise<Buffer> {
    return (await this.entry(tenantId)).blindIndexKey;
  }

  /** Drops cached keys (e.g. on tenant purge or key rotation events). */
  evict(tenantId: string): void {
    const entry = this.cache.get(tenantId);
    if (entry) for (const key of [...entry.keys.values(), entry.blindIndexKey]) key.fill(0);
    this.cache.delete(tenantId);
  }

  private now(): number {
    return (this.options.clock ?? systemClock).now().getTime();
  }

  private async entry(tenantId: string, force = false): Promise<CachedKeys> {
    const cached = this.cache.get(tenantId);
    const ttl = this.options.ttlMs ?? 15 * 60 * 1000;
    if (!force && cached && this.now() - cached.loadedAt < ttl) return cached;
    let pending = this.loading.get(tenantId);
    if (!pending) {
      pending = this.load(tenantId).finally(() => this.loading.delete(tenantId));
      this.loading.set(tenantId, pending);
    }
    return pending;
  }

  private async load(tenantId: string): Promise<CachedKeys> {
    let wrapped: WrappedTenantKey[];
    try {
      wrapped = await this.source.fetch(tenantId);
    } catch (error) {
      throw new TenantKeysUnavailableError(tenantId, (error as Error).message);
    }
    if (wrapped.length === 0) throw new TenantKeysUnavailableError(tenantId, 'no keys (purged?)');
    const keys = new Map<number, Buffer>();
    for (const k of wrapped) {
      if (k.kmsKeyRef !== this.kms.keyRef) {
        throw new TenantKeysUnavailableError(
          tenantId,
          `key ${k.version} is wrapped by ${k.kmsKeyRef}, this service uses ${this.kms.keyRef}`,
        );
      }
      keys.set(k.version, await this.kms.decrypt(k.wrappedKey, TENANT_DEK_CONTEXT));
    }
    const active =
      wrapped.find((k) => k.active) ?? wrapped.reduce((a, b) => (a.version > b.version ? a : b));
    const oldest = Math.min(...keys.keys());
    const blindIndexKey = Buffer.from(
      hkdfSync(
        'sha256',
        keys.get(oldest) ?? Buffer.alloc(0),
        Buffer.alloc(0),
        BLIND_INDEX_INFO,
        32,
      ),
    );
    this.evict(tenantId);
    const entry: CachedKeys = {
      loadedAt: this.now(),
      keys,
      activeVersion: active.version,
      blindIndexKey,
    };
    this.cache.set(tenantId, entry);
    return entry;
  }
}

/** Reads wrapped DEKs from tenant-svc with a service token (scope tenant-keys:read). */
export class HttpWrappedKeySource implements WrappedKeySource {
  constructor(
    private readonly options: { baseUrl: string; token: () => Promise<string>; timeoutMs?: number },
  ) {}

  async fetch(tenantId: string): Promise<WrappedTenantKey[]> {
    const response = await fetch(
      `${this.options.baseUrl.replace(/\/$/, '')}/v1/tenants/${encodeURIComponent(tenantId)}/data-keys`,
      {
        headers: { Authorization: `Bearer ${await this.options.token()}` },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 3000),
      },
    );
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`tenant-svc answered ${response.status}`);
    const body = (await response.json()) as {
      keys: { dek_version: number; kms_key_ref: string; wrapped_key: string; active: boolean }[];
    };
    return body.keys.map((k) => ({
      version: k.dek_version,
      kmsKeyRef: k.kms_key_ref,
      wrappedKey: Buffer.from(k.wrapped_key, 'base64'),
      active: k.active,
    }));
  }
}
