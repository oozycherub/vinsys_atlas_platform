import { randomUUID } from 'node:crypto';
import {
  type SandboxBundle,
  type SandboxExecution,
  type SandboxGateway,
  ServiceRejectedError,
  UpstreamError,
} from '../application/ports';
import { serviceCall, type ServiceClientOptions } from './service-client';

export type SandboxGatewayOptions = ServiceClientOptions;

/**
 * sandbox-svc's internal API (ADR-0006). 4xx problem documents are passed on to the candidate or
 * author as they are (e.g. RUN_THROTTLED with Retry-After); 5xx and network failures are
 * dependency failures (503).
 */
export class HttpSandboxGateway implements SandboxGateway {
  constructor(private readonly o: SandboxGatewayOptions) {}

  private call<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    timeoutMs?: number,
  ): Promise<T> {
    return serviceCall<T>(this.o, 'sandbox-svc', method, path, body, headers, timeoutMs);
  }

  registerBundle(tenantId: string, questionId: string, version: number, bundle: SandboxBundle) {
    return this.call<{ status: string; status_detail: string | null }>(
      'PUT',
      `/v1/test-case-bundles/${questionId}/versions/${version}?tenant_id=${tenantId}`,
      bundle,
      {},
      15000,
    );
  }

  run(tenantId: string, sessionId: string, questionId: string, body: SandboxExecution) {
    return this.call<{ run_id: string }>(
      'POST',
      `/v1/sessions/${sessionId}/questions/${questionId}/runs?tenant_id=${tenantId}`,
      body,
    );
  }

  getRun(tenantId: string, runId: string, waitSeconds: number) {
    return this.call<Record<string, unknown>>(
      'GET',
      `/v1/runs/${runId}?tenant_id=${tenantId}&wait=${waitSeconds}`,
      undefined,
      {},
      (waitSeconds + 5) * 1000,
    );
  }

  submit(
    tenantId: string,
    sessionId: string,
    questionId: string,
    body: SandboxExecution,
    idempotencyKey: string,
  ) {
    return this.call<{ submission_id: string }>(
      'POST',
      `/v1/sessions/${sessionId}/questions/${questionId}/submissions?tenant_id=${tenantId}`,
      body,
      { 'Idempotency-Key': idempotencyKey },
    );
  }

  getSubmission(tenantId: string, submissionId: string) {
    return this.call<Record<string, unknown>>(
      'GET',
      `/v1/submissions/${submissionId}?tenant_id=${tenantId}`,
    );
  }
}

/**
 * Development and tests: records calls; bundles are verified unless the reference solution says
 * PENDING, FLAKY or WRONG; a submission per idempotency key, like sandbox-svc.
 */
export class MemorySandboxGateway implements SandboxGateway {
  readonly bundles = new Map<string, SandboxBundle>();
  readonly runs = new Map<
    string,
    { tenantId: string; sessionId: string; questionId: string; body: SandboxExecution }
  >();
  readonly submissions = new Map<
    string,
    { tenantId: string; sessionId: string; questionId: string; body: SandboxExecution; key: string }
  >();
  failing = false;
  rejectNext: ServiceRejectedError | null = null;

  private guard(): void {
    if (this.failing) throw new UpstreamError('sandbox-svc: HTTP 503');
    const rejected = this.rejectNext;
    if (rejected) {
      this.rejectNext = null;
      throw rejected;
    }
  }

  async registerBundle(
    tenantId: string,
    questionId: string,
    version: number,
    bundle: SandboxBundle,
  ) {
    this.guard();
    this.bundles.set(`${tenantId}/${questionId}@${version}`, bundle);
    const ref = bundle.reference_solution.source;
    const status = ref.includes('PENDING')
      ? 'pending'
      : ref.includes('FLAKY')
        ? 'flaky'
        : ref.includes('WRONG')
          ? 'reference_failed'
          : 'verified';
    return Promise.resolve({
      status,
      status_detail:
        status === 'flaky'
          ? 'RESULTS_DIFFER: test 1'
          : status === 'reference_failed'
            ? 'wrong_answer: test 1'
            : null,
    });
  }

  async run(tenantId: string, sessionId: string, questionId: string, body: SandboxExecution) {
    this.guard();
    const id = randomUUID();
    this.runs.set(id, { tenantId, sessionId, questionId, body });
    return Promise.resolve({ run_id: id });
  }

  async getRun(tenantId: string, runId: string) {
    this.guard();
    const r = this.runs.get(runId);
    if (!r || r.tenantId !== tenantId)
      throw new ServiceRejectedError(404, 'RUN_NOT_FOUND', 'No such run.', null);
    return Promise.resolve({
      run_id: runId,
      session_id: r.sessionId,
      question_id: r.questionId,
      status: 'accepted',
      stdout: r.body.stdin ?? '',
      cases: [],
    });
  }

  async submit(
    tenantId: string,
    sessionId: string,
    questionId: string,
    body: SandboxExecution,
    key: string,
  ) {
    this.guard();
    for (const [id, s] of this.submissions)
      if (s.tenantId === tenantId && s.key === key) return Promise.resolve({ submission_id: id });
    const id = randomUUID();
    this.submissions.set(id, { tenantId, sessionId, questionId, body, key });
    return Promise.resolve({ submission_id: id });
  }

  async getSubmission(tenantId: string, submissionId: string) {
    this.guard();
    const s = this.submissions.get(submissionId);
    if (!s || s.tenantId !== tenantId)
      throw new ServiceRejectedError(404, 'SUBMISSION_NOT_FOUND', 'No such submission.', null);
    return Promise.resolve({
      submission_id: submissionId,
      session_id: s.sessionId,
      question_id: s.questionId,
      status: 'queued',
      cases: [],
    });
  }
}
