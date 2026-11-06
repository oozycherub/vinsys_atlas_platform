import { describe, expect, it } from 'vitest';
import {
  applyParsedProfile,
  assertVersion,
  createCandidate,
  patchCandidate,
} from '../../src/domain/candidate';
import {
  assertUploadRequest,
  parseStorageKey,
  sniffMimeType,
  storageKey,
  tenantPrefix,
} from '../../src/domain/documents';
import { ProfileDomainError } from '../../src/domain/errors';
import { assertEvidence, type NewEvidence } from '../../src/domain/evidence';
import { DEFAULT_POLICY, type Evidence, fuse } from '../../src/domain/fusion';
import {
  assertNoPii,
  mergePii,
  normalizeEmail,
  normalizePhone,
  normalizePii,
} from '../../src/domain/pii';
import {
  acknowledge,
  assertErasable,
  isOverdue,
  type PrivacyRequest,
  retentionCutoff,
} from '../../src/domain/privacy';

const NOW = new Date('2026-11-05T10:00:00Z');
const MONTH = 30.4375 * 24 * 60 * 60 * 1000;
const T = '0192f0c4-0000-7000-8000-000000000001';
const D = '0192f0c4-0000-7000-8000-000000000002';

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProfileDomainError);
    return (e as ProfileDomainError).code;
  }
  return 'none';
}

const ev = (over: Partial<Evidence>): Evidence => ({
  source: 'assessment',
  proficiency: 4,
  confidence: 1,
  observedAt: NOW,
  validUntil: null,
  ...over,
});

describe('fusion (PRD §2.5(ii))', () => {
  it('matches the golden value and decays by half-life', () => {
    const fused = fuse(
      [
        ev({
          source: 'assessment',
          proficiency: 4,
          confidence: 0.9,
          observedAt: new Date(NOW.getTime() - 12 * MONTH),
        }),
        ev({
          source: 'manager',
          proficiency: 3,
          confidence: 0.8,
          observedAt: new Date(NOW.getTime() - 6 * MONTH),
        }),
        ev({ source: 'self', proficiency: 5, confidence: 1 }),
      ],
      NOW,
    );
    expect(fused).toEqual({
      proficiency: 3.93,
      isValidated: true,
      calibrationNeeded: false,
      evidenceCount: 3,
    });
    // A single source returns its own value whatever its age.
    expect(
      fuse([ev({ proficiency: 2.5, observedAt: new Date(NOW.getTime() - 48 * MONTH) })], NOW)
        ?.proficiency,
    ).toBe(2.5);
  });

  it('ignores expired evidence, validates only verified confident sources, flags calibration', () => {
    const expiredCert = ev({
      source: 'certification',
      proficiency: 5,
      validUntil: new Date(NOW.getTime() - 1),
    });
    expect(fuse([expiredCert], NOW)).toBeNull();
    expect(fuse([expiredCert, ev({ source: 'self', proficiency: 2 })], NOW)).toMatchObject({
      proficiency: 2,
      isValidated: false,
    });
    expect(fuse([ev({ source: 'manager', confidence: 0.59 })], NOW)?.isValidated).toBe(false);
    expect(fuse([ev({ source: 'resume_inference', confidence: 1 })], NOW)?.isValidated).toBe(false);
    expect(fuse([ev({ source: 'ai_interview', confidence: 0.6 })], NOW)?.isValidated).toBe(true);
    const calib = fuse(
      [ev({ source: 'assessment', proficiency: 1.5 }), ev({ source: 'self', proficiency: 3.5 })],
      NOW,
    );
    expect(calib?.calibrationNeeded).toBe(true);
    expect(fuse([ev({ confidence: 0 })], NOW)).toBeNull();
    expect(DEFAULT_POLICY.self.weight).toBe(0.3);
  });
});

describe('evidence rules', () => {
  const base: NewEvidence = {
    skillId: 's',
    source: 'self',
    proficiency: 3.456,
    confidence: 1,
    sourceRef: null,
    reason: ' because ',
    observedAt: NOW,
    validUntil: null,
  };
  it('restricts sources by actor and validates values', () => {
    expect(assertEvidence(base, 'self', NOW)).toMatchObject({
      proficiency: 3.46,
      reason: 'because',
    });
    expect(code(() => assertEvidence({ ...base, source: 'assessment' }, 'self', NOW))).toBe(
      'SOURCE_NOT_ALLOWED',
    );
    expect(code(() => assertEvidence({ ...base, source: 'manager' }, 'system', NOW))).toBe(
      'SOURCE_NOT_ALLOWED',
    );
    expect(code(() => assertEvidence({ ...base, reason: '  ' }, 'self', NOW))).toBe(
      'REASON_REQUIRED',
    );
    expect(code(() => assertEvidence({ ...base, reason: 'x'.repeat(501) }, 'self', NOW))).toBe(
      'REASON_TOO_LONG',
    );
    expect(code(() => assertEvidence({ ...base, proficiency: 5.1 }, 'self', NOW))).toBe(
      'INVALID_PROFICIENCY',
    );
    expect(code(() => assertEvidence({ ...base, confidence: -0.1 }, 'self', NOW))).toBe(
      'INVALID_CONFIDENCE',
    );
    expect(
      code(() =>
        assertEvidence({ ...base, observedAt: new Date(NOW.getTime() + 3_600_000) }, 'self', NOW),
      ),
    ).toBe('OBSERVED_IN_FUTURE');
    expect(code(() => assertEvidence({ ...base, validUntil: NOW }, 'self', NOW))).toBe(
      'INVALID_VALIDITY',
    );
    expect(
      assertEvidence({ ...base, source: 'multi_rater', reason: null }, 'manager', NOW).source,
    ).toBe('multi_rater');
  });
});

describe('PII', () => {
  it('normalises and validates', () => {
    expect(normalizeEmail(' Ada@Example.COM ')).toBe('ada@example.com');
    expect(normalizePhone('+44 (20) 7946-0958')).toBe('+442079460958');
    expect(normalizePhone('020 7946 0958')).toBe('02079460958');
    expect(code(() => normalizePhone('123'))).toBe('INVALID_PHONE');
    expect(code(() => normalizeEmail('nope'))).toBe('INVALID_EMAIL');
    expect(code(() => normalizePii({ full_name: ' ' }))).toBe('INVALID_NAME');
    expect(code(() => normalizePii({ full_name: 'A', dob: '1990-13-45' }))).toBe('INVALID_DOB');
    expect(code(() => normalizePii({ full_name: 'A', address: 'x'.repeat(501) }))).toBe(
      'INVALID_ADDRESS',
    );
    const pii = normalizePii({ full_name: ' Ada   L ', email: 'A@B.co' });
    expect(pii).toEqual({
      full_name: 'Ada L',
      email: 'a@b.co',
      phone: null,
      address: null,
      dob: null,
    });
    expect(mergePii(pii, { phone: '+1 555 010 0222' }).phone).toBe('+15550100222');
  });

  it('keeps PII out of profile JSON at any depth', () => {
    expect(code(() => assertNoPii({ skills: ['x'], years: 5 }))).toBe('none');
    expect(code(() => assertNoPii({ contact: { Email: 'x' } }))).toBe('PII_IN_PROFILE');
    expect(code(() => assertNoPii({ refs: [{ full_name: 'x' }] }))).toBe('PII_IN_PROFILE');
  });
});

describe('candidates', () => {
  const c = createCandidate({
    id: 'c',
    tenantId: T,
    source: 'referral',
    attributes: { locationCountry: 'de', currentTitle: ' Eng ' },
    now: NOW,
  });
  it('creates, patches and applies parsed profiles', () => {
    expect(c).toMatchObject({
      locationCountry: 'DE',
      currentTitle: 'Eng',
      version: 1,
      profileVersion: 0,
    });
    expect(
      code(() =>
        createCandidate({
          id: 'c',
          tenantId: T,
          source: 'referral',
          attributes: { locationCountry: 'DEU' },
          now: NOW,
        }),
      ),
    ).toBe('INVALID_COUNTRY');
    expect(code(() => patchCandidate(c, { totalExperienceMonths: 901 }, NOW))).toBe(
      'INVALID_EXPERIENCE',
    );
    expect(patchCandidate(c, { legalHold: true }, NOW)).toMatchObject({
      legalHold: true,
      version: 2,
    });
    const parsed = applyParsedProfile(
      c,
      { profile: { skills: ['x'] }, currentTitle: null, totalExperienceMonths: 12 },
      NOW,
    );
    expect(parsed).toMatchObject({
      currentTitle: 'Eng',
      totalExperienceMonths: 12,
      profileVersion: 1,
    });
    expect(
      code(() =>
        applyParsedProfile(
          c,
          { profile: { name: 'x' }, currentTitle: null, totalExperienceMonths: null },
          NOW,
        ),
      ),
    ).toBe('PII_IN_PROFILE');
    expect(code(() => assertVersion(c, 2))).toBe('VERSION_MISMATCH');
  });
});

describe('documents', () => {
  it('builds and parses storage keys', () => {
    const key = storageKey(T, D);
    expect(key).toBe(`t/${T}/resumes/${D}`);
    expect(parseStorageKey(key)).toEqual({ tenantId: T, documentId: D });
    expect(parseStorageKey(`t/${T}/other/${D}`)).toBeNull();
    expect(tenantPrefix(T)).toBe(`t/${T}/`);
  });

  it('validates upload requests', () => {
    const sha = 'a'.repeat(64);
    expect(
      assertUploadRequest({ mimeType: 'application/pdf', byteSize: 10, sha256: sha }).sha256,
    ).toHaveLength(32);
    expect(
      code(() => assertUploadRequest({ mimeType: 'text/html', byteSize: 10, sha256: sha })),
    ).toBe('UNSUPPORTED_MIME_TYPE');
    expect(
      code(() => assertUploadRequest({ mimeType: 'text/plain', byteSize: 0, sha256: sha })),
    ).toBe('DOCUMENT_TOO_LARGE');
    expect(
      code(() =>
        assertUploadRequest({ mimeType: 'text/plain', byteSize: 1, sha256: 'A'.repeat(64) }),
      ),
    ).toBe('INVALID_SHA256');
  });

  it('sniffs real content types from magic bytes', () => {
    const b = (s: string | number[]) => (typeof s === 'string' ? Buffer.from(s) : Buffer.from(s));
    expect(sniffMimeType(b('%PDF-1.7'))).toBe('application/pdf');
    expect(sniffMimeType(b([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffMimeType(b([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMimeType(b([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe(
      'application/msword',
    );
    expect(
      sniffMimeType(Buffer.concat([b([0x50, 0x4b, 0x03, 0x04]), b('....word/document.xml')])),
    ).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(sniffMimeType(b([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toBeNull();
    expect(sniffMimeType(b('Plain résumé text\nwith lines'))).toBe('text/plain');
    expect(sniffMimeType(b([0x41, 0x00, 0x42]))).toBeNull();
    expect(sniffMimeType(Buffer.alloc(0))).toBeNull();
  });
});

describe('privacy', () => {
  const req: PrivacyRequest = {
    id: 'r',
    tenantId: T,
    candidateId: 'c',
    type: 'erasure',
    reason: 'data_subject',
    status: 'awaiting_acks',
    requestedBy: 'admin',
    ackRequiredFrom: ['a', 'b'],
    acks: [],
    certificate: {
      request_id: 'r',
      candidate_id: 'c',
      reason: 'data_subject',
      requested_at: NOW.toISOString(),
      requested_by: 'admin',
      profile_deleted_at: NOW.toISOString(),
      rows_deleted: {},
      objects_deleted: 0,
      ack_required_from: ['a', 'b'],
      acks: [],
      completed_at: null,
    },
    dueAt: new Date(NOW.getTime() + 1000),
    createdAt: NOW,
    completedAt: null,
  };

  it('completes after every registered ACK, ignoring repeats and strangers', () => {
    const one = acknowledge(req, 'a', NOW);
    expect(one.status).toBe('awaiting_acks');
    expect(acknowledge(one, 'a', NOW)).toBe(one);
    expect(acknowledge(one, 'z', NOW)).toBe(one);
    const done = acknowledge(one, 'b', NOW);
    expect(done).toMatchObject({ status: 'completed', completedAt: NOW });
    expect(done.certificate?.completed_at).toBe(NOW.toISOString());
    expect(acknowledge(done, 'b', NOW)).toBe(done);
    expect(acknowledge({ ...req, type: 'access' }, 'a', NOW).acks).toEqual([]);
  });

  it('knows overdue, retention cut-off and legal holds', () => {
    expect(isOverdue(req, NOW)).toBe(false);
    expect(isOverdue(req, new Date(NOW.getTime() + 1000))).toBe(true);
    expect(retentionCutoff(NOW, 1).getTime()).toBe(NOW.getTime() - 86_400_000);
    expect(code(() => assertErasable({ legalHold: true }))).toBe('LEGAL_HOLD');
    expect(code(() => assertErasable({ legalHold: false }))).toBe('none');
  });
});
