import { type ProctoringGateway } from '../application/ports';
import { serviceCall, type ServiceClientOptions } from './service-client';

/** proctoring-svc: starts (or resumes) proctoring for a session (ADR-0007). */
export class HttpProctoringGateway implements ProctoringGateway {
  constructor(private readonly o: ServiceClientOptions) {}

  start(tenantId: string, sessionId: string, body: Parameters<ProctoringGateway['start']>[2]) {
    return serviceCall<Record<string, unknown>>(
      this.o,
      'proctoring-svc',
      'PUT',
      `/v1/proctoring/sessions/${sessionId}?tenant_id=${tenantId}`,
      body,
    );
  }
}

/** Development and tests: records starts and returns a token like proctoring-svc. */
export class MemoryProctoringGateway implements ProctoringGateway {
  readonly starts: {
    tenantId: string;
    sessionId: string;
    body: Parameters<ProctoringGateway['start']>[2];
  }[] = [];

  start(tenantId: string, sessionId: string, body: Parameters<ProctoringGateway['start']>[2]) {
    this.starts.push({ tenantId, sessionId, body });
    return Promise.resolve({
      proctor_token: `apt_${sessionId}`,
      session_key: 'a2V5',
      key_epoch: this.starts.filter((s) => s.sessionId === sessionId).length,
      next_seq: 1,
      prev_hash: '',
      rules: body.rules ?? {},
    });
  }
}
