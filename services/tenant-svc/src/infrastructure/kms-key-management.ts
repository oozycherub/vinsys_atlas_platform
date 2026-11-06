import { type KeyEncryption } from '@atlas/platform';
import { type KeyManagementPort } from '../application/ports';

/** Purpose bound into every tenant DEK (KMS encryption context). */
export const TENANT_DEK_CONTEXT = 'tenant-dek';

/** Tenant data keys from a cloud KMS (production). Only the wrapped key ever leaves this class. */
export class KmsKeyManagement implements KeyManagementPort {
  constructor(private readonly keys: KeyEncryption) {}

  get keyRef(): string {
    return this.keys.keyRef;
  }

  async generateDataKey(kmsKeyRef: string): Promise<{ wrappedKey: Uint8Array }> {
    this.assertKeyRef(kmsKeyRef);
    const { plaintext, wrapped } = await this.keys.generateDataKey(TENANT_DEK_CONTEXT);
    plaintext.fill(0);
    return { wrappedKey: new Uint8Array(wrapped) };
  }

  async unwrapDataKey(kmsKeyRef: string, wrappedKey: Uint8Array): Promise<Buffer> {
    this.assertKeyRef(kmsKeyRef);
    return this.keys.decrypt(wrappedKey, TENANT_DEK_CONTEXT);
  }

  private assertKeyRef(kmsKeyRef: string): void {
    if (kmsKeyRef !== this.keys.keyRef) {
      throw new Error(`This key manager only serves ${this.keys.keyRef}.`);
    }
  }
}
