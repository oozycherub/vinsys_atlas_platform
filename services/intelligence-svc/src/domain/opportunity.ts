/** Opportunity lifecycle and application rules (PRD §2.5(c), §2.5d). */
export type OpportunityStatus = 'draft' | 'open' | 'filled' | 'closed';
export type ApplicationStatus = 'pending' | 'accepted' | 'declined' | 'withdrawn';

const MOVES: Record<OpportunityStatus, OpportunityStatus[]> = {
  draft: ['open', 'closed'],
  open: ['filled', 'closed'],
  filled: ['closed'],
  closed: [],
};

export class OpportunityRuleError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OpportunityRuleError';
  }
}

export function assertMove(from: OpportunityStatus, to: OpportunityStatus): void {
  if (!MOVES[from].includes(to))
    throw new OpportunityRuleError(
      'INVALID_TRANSITION',
      `An opportunity cannot go from ${from} to ${to}.`,
    );
}

/**
 * Who may decide a pending application: the owner accepts or declines an application, the
 * employee accepts or declines an invitation, and only whoever started it may withdraw it.
 */
export function canDecide(
  kind: 'application' | 'invitation',
  action: 'accept' | 'decline' | 'withdraw',
  actor: 'owner' | 'employee',
): boolean {
  if (action === 'withdraw') return (kind === 'application') === (actor === 'employee');
  return kind === 'application' ? actor === 'owner' : actor === 'employee';
}

export const MAX_MATCHES = 200;
/** HR records older than this make a match "stale" (PRD §2.5d). */
export const STALE_AFTER_HOURS = 24;
/** Heat-map cells with fewer employees are suppressed, so no one's gaps can be singled out. */
export const MIN_GROUP_SIZE = 3;
