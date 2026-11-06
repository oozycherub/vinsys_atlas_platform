import {
  argon2,
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** URL-safe random secret, e.g. for magic links and refresh tokens. 32 bytes = 256 bits. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** SHA-256 of a high-entropy secret. Lookup tokens are stored only as this hash (PRD §4.2). */
export function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

const SEALED_FORMAT = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM envelope: format(1) ‖ iv(12) ‖ tag(16) ‖ ciphertext. `aad` binds the ciphertext to
 * its purpose (e.g. the key id), so a sealed value cannot be swapped into another row.
 */
export function sealSecret(kek: Buffer, plaintext: Buffer, aad: string): Buffer {
  if (kek.length !== 32) throw new Error('The key-encryption key must be 32 bytes.');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', kek, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([SEALED_FORMAT]), iv, cipher.getAuthTag(), ciphertext]);
}

export function openSecret(kek: Buffer, sealed: Uint8Array, aad: string): Buffer {
  const buf = Buffer.from(sealed);
  if (buf.length <= 1 + IV_BYTES + TAG_BYTES || buf[0] !== SEALED_FORMAT) {
    throw new Error('Unsupported sealed-secret format.');
  }
  const iv = buf.subarray(1, 1 + IV_BYTES);
  const tag = buf.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', kek, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buf.subarray(1 + IV_BYTES + TAG_BYTES)), decipher.final()]);
}

interface Argon2Params {
  memory: number;
  passes: number;
  parallelism: number;
  tagLength: number;
}

/** OWASP minimum for argon2id: 19 MiB, 2 passes, 1 lane. */
const ARGON2: Argon2Params = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 };

function argon2id(message: string, nonce: Buffer, params: Argon2Params = ARGON2): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2('argon2id', { message, nonce, ...params }, (error, derived) => {
      if (error) reject(error);
      else resolve(Buffer.from(derived));
    });
  });
}

/** Hashes a client secret as a PHC string: $argon2id$v=19$m=…,t=…,p=…$salt$hash */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await argon2id(secret, salt);
  const params = `m=${ARGON2.memory},t=${ARGON2.passes},p=${ARGON2.parallelism}`;
  return `$argon2id$v=19$${params}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

/** Constant-time check of a secret against a PHC string produced by hashSecret. */
export async function verifySecret(secret: string, phc: string): Promise<boolean> {
  const match = PHC.exec(phc);
  if (!match) return false;
  const [, m, t, p, salt, hash] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const expected = Buffer.from(hash, 'base64url');
  const actual = await argon2id(secret, Buffer.from(salt, 'base64url'), {
    memory: Number(m),
    passes: Number(t),
    parallelism: Number(p),
    tagLength: expected.length,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
