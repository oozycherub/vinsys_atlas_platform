import { type SkillEvidenceSource } from '@atlas/contracts';
import { ProfileDomainError } from './errors';

/** Who is recording evidence, which decides the sources they may use. */
export type EvidenceActor = 'self' | 'manager' | 'system';

const ALLOWED: Readonly<Record<EvidenceActor, readonly SkillEvidenceSource[]>> = {
  self: ['self'],
  manager: ['manager', 'multi_rater'],
  system: [
    'assessment',
    'certification',
    'ai_interview',
    'multi_rater',
    'project_inference',
    'resume_inference',
    'learning_completion',
  ],
};

export interface NewEvidence {
  skillId: string;
  source: SkillEvidenceSource;
  proficiency: number;
  confidence: number;
  sourceRef: string | null;
  reason: string | null;
  observedAt: Date;
  validUntil: Date | null;
}

/** Validates one evidence record against the actor and the PRD rules. */
export function assertEvidence(input: NewEvidence, actor: EvidenceActor, now: Date): NewEvidence {
  if (!ALLOWED[actor].includes(input.source)) {
    throw new ProfileDomainError(
      'forbidden',
      'SOURCE_NOT_ALLOWED',
      `A ${actor} caller cannot record "${input.source}" evidence.`,
    );
  }
  if (!(input.proficiency >= 0 && input.proficiency <= 5)) {
    throw new ProfileDomainError(
      'validation',
      'INVALID_PROFICIENCY',
      'proficiency must be between 0 and 5.',
    );
  }
  if (!(input.confidence >= 0 && input.confidence <= 1)) {
    throw new ProfileDomainError(
      'validation',
      'INVALID_CONFIDENCE',
      'confidence must be between 0 and 1.',
    );
  }
  const reason = input.reason?.trim() || null;
  if (input.source === 'self' && !reason) {
    throw new ProfileDomainError('validation', 'REASON_REQUIRED', 'Self-ratings need a reason.');
  }
  if (reason && reason.length > 500) {
    throw new ProfileDomainError(
      'validation',
      'REASON_TOO_LONG',
      'The reason must be at most 500 characters.',
    );
  }
  if (input.observedAt.getTime() > now.getTime() + 5 * 60 * 1000) {
    throw new ProfileDomainError(
      'validation',
      'OBSERVED_IN_FUTURE',
      'observed_at is in the future.',
    );
  }
  if (input.validUntil && input.validUntil.getTime() <= input.observedAt.getTime()) {
    throw new ProfileDomainError(
      'validation',
      'INVALID_VALIDITY',
      'valid_until must be after observed_at.',
    );
  }
  return {
    ...input,
    proficiency: Math.round(input.proficiency * 100) / 100,
    confidence: Math.round(input.confidence * 100) / 100,
    reason,
  };
}
