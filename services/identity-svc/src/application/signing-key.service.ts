import { Inject, Injectable } from '@nestjs/common';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  importJWK,
  type JWK,
  jwtVerify,
  type KeyLike,
  SignJWT,
} from 'jose';
import {
  CLOCK,
  type Clock,
  DATABASE,
  type Database,
  newId,
  type Principal,
  randomToken,
  ServiceUnavailableError,
  tokenClaimsSchema,
  type TokenVerifier,
  UnauthorizedError,
  withSystemTx,
} from '@atlas/platform';
import {
  isRotationDue,
  planRotation,
  publishedKeys,
  selectSigningKey,
} from '../domain/signing-keys';
import { ACCESS_TOKEN_TTL_SEC } from '../domain/tokens';
import {
  IDENTITY_SETTINGS,
  type IdentitySettings,
  SIGNING_KEY_REPOSITORY,
  type SigningKeyRepository,
  type StoredSigningKey,
} from './ports';

export interface AccessTokenClaims {
  subject: string;
  tenantId: string | null;
  roles: readonly string[];
  businessUnitIds: readonly string[];
  scopes: readonly string[];
  /** Authentication methods (RFC 8176), e.g. ["email"] for magic links. */
  amr: readonly string[];
}

export interface JsonWebKeySet {
  keys: JWK[];
}

/**
 * Owns the platform's token-signing keys: ES256, rotated every 30 days, private halves sealed
 * with the platform KEK. Also verifies tokens for identity-svc's own protected routes.
 */
@Injectable()
export class SigningKeyService implements TokenVerifier {
  private readonly privateKeys = new Map<string, KeyLike | Uint8Array>();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SIGNING_KEY_REPOSITORY) private readonly keys: SigningKeyRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(IDENTITY_SETTINGS) private readonly settings: IdentitySettings,
  ) {}

  /** Creates the first key, or rotates when the current one is 30 days old. Safe on every replica. */
  async ensureCurrent(): Promise<void> {
    const keys = await withSystemTx(this.db, (tx) => this.keys.list(tx));
    if (isRotationDue(keys, this.clock.now())) await this.rotate({ onlyIfDue: true });
  }

  /** Adds a successor key (pre-published) and schedules the current key's retirement. */
  async rotate(options: { onlyIfDue?: boolean } = {}): Promise<{ kid: string; activatesAt: Date }> {
    const { publicJwk, privateJwk } = await this.generate();
    // Sealed outside the transaction: a KMS round trip should not hold the rotation lock.
    const kid = `k${randomToken(12)}`;
    const privateKeyCiphertext = await this.settings.keys.encrypt(
      Buffer.from(JSON.stringify(privateJwk)),
      sealContext(kid),
    );
    return withSystemTx(this.db, async (tx) => {
      await this.keys.lockForRotation(tx);
      const existing = await this.keys.list(tx);
      const now = this.clock.now();
      if (options.onlyIfDue && !isRotationDue(existing, now)) {
        const open = existing.find((k) => k.retiresAt === null);
        if (open) return { kid: open.kid, activatesAt: open.activatesAt };
      }
      const plan = planRotation(existing, now);
      if (plan.retire) {
        await this.keys.retire(
          tx,
          plan.retire.kid,
          plan.retire.retiresAt,
          plan.retire.publishUntil,
        );
      }
      const key: StoredSigningKey = {
        kid,
        createdAt: now,
        activatesAt: plan.activatesAt,
        retiresAt: null,
        publishUntil: null,
        publicJwk: { ...publicJwk, kid, alg: 'ES256', use: 'sig' },
        privateKeyCiphertext,
        kekRef: this.settings.keys.keyRef,
      };
      await this.keys.insert(tx, key);
      return { kid, activatesAt: plan.activatesAt };
    });
  }

  async jwks(): Promise<JsonWebKeySet> {
    const keys = await withSystemTx(this.db, (tx) => this.keys.list(tx));
    return {
      keys: publishedKeys(keys, this.clock.now()).map((k) => k.publicJwk as unknown as JWK),
    };
  }

  async sign(claims: AccessTokenClaims): Promise<{ token: string; expiresIn: number }> {
    const now = this.clock.now();
    let keys = await withSystemTx(this.db, (tx) => this.keys.list(tx));
    if (isRotationDue(keys, now)) {
      await this.rotate({ onlyIfDue: true });
      keys = await withSystemTx(this.db, (tx) => this.keys.list(tx));
    }
    const meta = selectSigningKey(keys, now);
    const stored = meta ? keys.find((k) => k.kid === meta.kid) : undefined;
    if (!stored) throw new ServiceUnavailableError('NO_SIGNING_KEY', 'No signing key is active.');

    const iat = Math.floor(now.getTime() / 1000);
    const token = await new SignJWT({
      tid: claims.tenantId,
      roles: [...claims.roles],
      bu: [...claims.businessUnitIds],
      scopes: [...claims.scopes],
      amr: [...claims.amr],
    })
      .setProtectedHeader({ alg: 'ES256', kid: stored.kid, typ: 'at+jwt' })
      .setSubject(claims.subject)
      .setIssuer(this.settings.issuer)
      .setAudience(this.settings.audience)
      .setIssuedAt(iat)
      .setExpirationTime(iat + ACCESS_TOKEN_TTL_SEC)
      .setJti(newId())
      .sign(await this.privateKey(stored));
    return { token, expiresIn: ACCESS_TOKEN_TTL_SEC };
  }

  /** TokenVerifier for identity-svc's own routes: verifies against the keys it publishes. */
  async verify(token: string): Promise<Principal> {
    let payload: unknown;
    try {
      const result = await jwtVerify(token, createLocalJWKSet(await this.jwks()), {
        issuer: this.settings.issuer,
        audience: this.settings.audience,
        algorithms: ['ES256'],
        clockTolerance: 30,
        currentDate: this.clock.now(),
      });
      payload = result.payload;
    } catch {
      throw new UnauthorizedError('The bearer token is invalid or expired.');
    }
    const claims = tokenClaimsSchema.safeParse(payload);
    if (!claims.success)
      throw new UnauthorizedError('The bearer token is missing required claims.');
    return {
      subject: claims.data.sub,
      tenantId: claims.data.tid ?? null,
      roles: claims.data.roles,
      scopes: claims.data.scopes,
    };
  }

  private async generate(): Promise<{ publicJwk: JWK; privateJwk: JWK }> {
    const pair = await generateKeyPair('ES256', { extractable: true });
    return {
      publicJwk: await exportJWK(pair.publicKey),
      privateJwk: await exportJWK(pair.privateKey),
    };
  }

  private async privateKey(stored: StoredSigningKey): Promise<KeyLike | Uint8Array> {
    const cached = this.privateKeys.get(stored.kid);
    if (cached) return cached;
    const plaintext = await this.settings.keys.decrypt(
      stored.privateKeyCiphertext,
      sealContext(stored.kid),
    );
    const jwk = JSON.parse(plaintext.toString('utf8')) as JWK;
    plaintext.fill(0);
    const key = await importJWK(jwk, 'ES256');
    this.privateKeys.set(stored.kid, key);
    return key;
  }
}

/** Binds each sealed private key to its key id (AES-GCM AAD / KMS encryption context). */
function sealContext(kid: string): string {
  return `identity-signing-key:${kid}`;
}
