import { ProfileDomainError } from './errors';

export const ERASURE_ACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type PrivacyStatus = 'completed' | 'awaiting_acks' | 'overdue';

export interface ErasureAck {
  service: string;
  at: string;
}

export interface ErasureCertificate {
  request_id: string;
  candidate_id: string;
  reason: 'data_subject' | 'retention';
  requested_at: string;
  requested_by: string;
  profile_deleted_at: string;
  rows_deleted: Record<string, number>;
  objects_deleted: number;
  ack_required_from: string[];
  acks: ErasureAck[];
  completed_at: string | null;
}

export interface PrivacyRequest {
  readonly id: string;
  readonly tenantId: string;
  readonly candidateId: string;
  readonly type: 'access' | 'erasure';
  readonly reason: 'data_subject' | 'retention';
  readonly status: PrivacyStatus;
  readonly requestedBy: string;
  readonly ackRequiredFrom: readonly string[];
  readonly acks: readonly ErasureAck[];
  readonly certificate: ErasureCertificate | null;
  readonly dueAt: Date | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export function assertErasable(candidate: { legalHold: boolean }): void {
  if (candidate.legalHold) {
    throw new ProfileDomainError(
      'conflict',
      'LEGAL_HOLD',
      'This candidate is under legal hold and cannot be erased.',
    );
  }
}

/**
 * Records one consumer's acknowledgement. The request completes (and the certificate is final)
 * once every required service has acknowledged; unknown or repeated ACKs change nothing.
 */
export function acknowledge(request: PrivacyRequest, service: string, at: Date): PrivacyRequest {
  if (request.type !== 'erasure' || request.status === 'completed') return request;
  if (!request.ackRequiredFrom.includes(service) || request.acks.some((a) => a.service === service))
    return request;
  const acks = [...request.acks, { service, at: at.toISOString() }];
  const done = request.ackRequiredFrom.every((s) => acks.some((a) => a.service === s));
  return {
    ...request,
    acks,
    status: done ? 'completed' : request.status,
    completedAt: done ? at : null,
    certificate: request.certificate
      ? { ...request.certificate, acks, completed_at: done ? at.toISOString() : null }
      : null,
  };
}

export function isOverdue(request: PrivacyRequest, now: Date): boolean {
  return (
    request.status === 'awaiting_acks' &&
    request.dueAt !== null &&
    request.dueAt.getTime() <= now.getTime()
  );
}

/** Candidates inactive longer than the retention period are erased unless held or employees. */
export function retentionCutoff(now: Date, inactiveDays: number): Date {
  return new Date(now.getTime() - inactiveDays * 24 * 60 * 60 * 1000);
}
