import {
  DecryptCommand,
  EncryptCommand,
  GenerateDataKeyCommand,
  type KMSClient,
} from '@aws-sdk/client-kms';
import { randomBytes } from 'node:crypto';
import { openSecret, sealSecret } from './secrets';

/**
 * Envelope encryption behind one interface (PRD §4.2). `context` binds a ciphertext to its
 * purpose (AES-GCM AAD locally, the KMS encryption context in AWS); decrypting with a different
 * context fails.
 */
export interface KeyEncryption {
  /** Identifies the key-encryption key, e.g. `local:dev` or a KMS key ARN. Stored next to ciphertexts. */
  readonly keyRef: string;
  encrypt(plaintext: Buffer, context: string): Promise<Buffer>;
  decrypt(ciphertext: Uint8Array, context: string): Promise<Buffer>;
  /** A fresh 256-bit data key, returned in plaintext and wrapped. Callers zero the plaintext after use. */
  generateDataKey(context: string): Promise<{ plaintext: Buffer; wrapped: Buffer }>;
}

/** Development/test KEK held in process memory. Every service's config refuses it in production. */
export class LocalKeyEncryption implements KeyEncryption {
  readonly keyRef: string;

  constructor(
    keyName: string,
    private readonly kek: Buffer,
  ) {
    if (kek.length !== 32)
      throw new Error('The local key-encryption key must be exactly 32 bytes.');
    this.keyRef = `local:${keyName}`;
  }

  // async so failures surface as rejected promises, like the KMS adapter's.
  async encrypt(plaintext: Buffer, context: string): Promise<Buffer> {
    return sealSecret(this.kek, plaintext, context);
  }

  async decrypt(ciphertext: Uint8Array, context: string): Promise<Buffer> {
    return openSecret(this.kek, ciphertext, context);
  }

  async generateDataKey(context: string): Promise<{ plaintext: Buffer; wrapped: Buffer }> {
    const plaintext = randomBytes(32);
    return { plaintext, wrapped: await this.encrypt(plaintext, context) };
  }
}

/**
 * AWS KMS. The key never leaves KMS; `context` becomes the encryption context
 * `{ purpose: context }`, which CloudTrail records on every call.
 */
export class AwsKmsKeyEncryption implements KeyEncryption {
  constructor(
    private readonly client: Pick<KMSClient, 'send'>,
    readonly keyRef: string,
  ) {
    if (!/^(arn:aws[a-z-]*:kms:|alias\/)/.test(keyRef)) {
      throw new Error('The KMS key must be a key ARN or alias/<name>.');
    }
  }

  async encrypt(plaintext: Buffer, context: string): Promise<Buffer> {
    const out = await this.client.send(
      new EncryptCommand({
        KeyId: this.keyRef,
        Plaintext: plaintext,
        EncryptionContext: { purpose: context },
      }),
    );
    if (!out.CiphertextBlob) throw new Error('KMS returned no ciphertext.');
    return Buffer.from(out.CiphertextBlob);
  }

  async decrypt(ciphertext: Uint8Array, context: string): Promise<Buffer> {
    const out = await this.client.send(
      new DecryptCommand({
        KeyId: this.keyRef,
        CiphertextBlob: ciphertext,
        EncryptionContext: { purpose: context },
      }),
    );
    if (!out.Plaintext) throw new Error('KMS returned no plaintext.');
    return Buffer.from(out.Plaintext);
  }

  async generateDataKey(context: string): Promise<{ plaintext: Buffer; wrapped: Buffer }> {
    const out = await this.client.send(
      new GenerateDataKeyCommand({
        KeyId: this.keyRef,
        KeySpec: 'AES_256',
        EncryptionContext: { purpose: context },
      }),
    );
    if (!out.Plaintext || !out.CiphertextBlob) throw new Error('KMS returned no data key.');
    return { plaintext: Buffer.from(out.Plaintext), wrapped: Buffer.from(out.CiphertextBlob) };
  }
}
