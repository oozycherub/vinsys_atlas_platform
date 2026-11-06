/** One assessment session as report-svc knows it from the owners' events (ADR-0010 §6). */
export interface SkillScore {
  skillId: string;
  score: number;
  confidence: number;
}

export interface InterviewSummary {
  recommendation: 'advance' | 'hold' | 'do_not_advance' | null;
  outcome: string | null;
  needsReview: boolean;
  competencies: { skillId: string; weight: number; score: number | null }[];
}

export interface SessionFacts {
  sessionId: string;
  assessmentId: string | null;
  assessmentVersion: number | null;
  candidateId: string | null;
  attemptNo: number | null;
  startedAt: Date | null;
  deadlineAt: Date | null;
  submittedAt: Date | null;
  outcome: string | null;
  terminatedReason: string | null;
  skills: SkillScore[] | null;
  evaluatedAt: Date | null;
  trustScore: number | null;
  trustBand: string | null;
  trustBreakdown: Record<string, number> | null;
  trustReview: boolean | null;
  interview: InterviewSummary | null;
}

/** Overall score: the confidence-weighted mean of skill scores (0–5), or null without scores. */
export function overallScore(skills: readonly SkillScore[] | null): number | null {
  if (!skills || skills.length === 0) return null;
  const weight = skills.reduce((s, k) => s + (k.confidence > 0 ? k.confidence : 0), 0);
  if (weight === 0) return skills.reduce((s, k) => s + k.score, 0) / skills.length;
  return skills.reduce((s, k) => s + k.score * Math.max(0, k.confidence), 0) / weight;
}

export function status(f: SessionFacts): string {
  if (f.terminatedReason) return 'terminated';
  if (f.submittedAt) return f.outcome ?? 'submitted';
  if (f.startedAt) return 'in_progress';
  return 'unknown';
}
