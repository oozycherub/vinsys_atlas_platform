import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LocalKeyEncryption } from '@atlas/platform';
import { KmsKeyManagement } from '../../src/infrastructure/kms-key-management';

describe('KmsKeyManagement', () => {
  it('returns only wrapped tenant keys that unwrap to 32 bytes, for its own key only', async () => {
    const kms = new KmsKeyManagement(new LocalKeyEncryption('prod-like', randomBytes(32)));
    expect(kms.keyRef).toBe('local:prod-like');
    const { wrappedKey } = await kms.generateDataKey(kms.keyRef);
    expect(wrappedKey.length).toBeGreaterThan(32);
    expect(await kms.unwrapDataKey(kms.keyRef, wrappedKey)).toHaveLength(32);
    await expect(kms.generateDataKey('local:other')).rejects.toThrow(/only serves/);
  });
});
