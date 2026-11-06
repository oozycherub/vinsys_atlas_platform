import { type InterviewGateway } from '../application/ports';
import { serviceCall, type ServiceClientOptions } from './service-client';

type StartBody = Parameters<InterviewGateway['start']>[2];
type Started = Awaited<ReturnType<InterviewGateway['start']>>;

/** interview-svc: starts an AI interview for a question of a session (ADR-0008). */
export class HttpInterviewGateway implements InterviewGateway {
  constructor(private readonly o: ServiceClientOptions) {}

  start(tenantId: string, interviewId: string, body: StartBody): Promise<Started> {
    return serviceCall<Started>(
      this.o,
      'interview-svc',
      'POST',
      `/v1/interviews/${interviewId}/sessions`,
      {
        tenant_id: tenantId,
        ...body,
      },
    );
  }
}

/** Development and tests: one interview session per (session, question), like interview-svc. */
export class MemoryInterviewGateway implements InterviewGateway {
  readonly starts: { tenantId: string; interviewId: string; body: StartBody }[] = [];

  start(tenantId: string, interviewId: string, body: StartBody): Promise<Started> {
    this.starts.push({ tenantId, interviewId, body });
    const n = this.starts.findIndex(
      (s) =>
        s.body.assessment_session_id === body.assessment_session_id &&
        s.body.question_id === body.question_id,
    );
    const sessionId = `0192f0c1-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
    return Promise.resolve({
      session_id: sessionId,
      interview_token: `ivt_${this.starts.length}`,
      mode: 'text',
      status: 'created',
      join_path: `/v1/interview-sessions/${sessionId}:join`,
    });
  }
}
