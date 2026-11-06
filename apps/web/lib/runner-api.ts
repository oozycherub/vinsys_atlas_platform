import { api } from './api';

/**
 * The candidate's calls (assessment-runner contract). They carry the session token
 * (`Authorization: Session ast_…`), never a user token, and distinguish "offline" from a refusal.
 */
export interface RunnerSessionView {
  session_id: string;
  status: string;
  title: string;
  navigation: 'fixed_section_order' | 'section_switch';
  question_count: number;
  started_at: string | null;
  deadline_at: string | null;
  server_time: string;
  remaining_seconds: number | null;
}

export interface RunnerQuestionView {
  index: number;
  question_id: string;
  type:
    | 'mcq'
    | 'multiple_answer'
    | 'true_false'
    | 'fill_blank'
    | 'descriptive'
    | 'coding'
    | 'ai_interview';
  prompt: string;
  options?: { id: string; text: string }[];
  marks: number;
  coding?: { languages: string[]; starter_code: Record<string, string> };
  response: unknown;
  client_rev: number;
}

export class OfflineError extends Error {}

export class RunnerApi {
  constructor(
    readonly sessionId: string,
    private readonly sessionToken: string,
  ) {}

  private headers() {
    return { Authorization: `Session ${this.sessionToken}` };
  }

  private async call<T>(
    run: () => Promise<{ data?: unknown; error?: unknown; response: Response }>,
  ): Promise<{ status: number; body: T }> {
    let r;
    try {
      r = await run();
    } catch {
      throw new OfflineError('offline');
    }
    return { status: r.response.status, body: (r.data ?? r.error) as T };
  }

  session() {
    return this.call<RunnerSessionView>(() =>
      api.assessment.GET('/v1/sessions/{sessionId}', {
        params: { path: { sessionId: this.sessionId } },
        headers: this.headers(),
      }),
    );
  }

  start() {
    return this.call<RunnerSessionView>(() =>
      api.assessment.POST('/v1/sessions/{sessionId}:start', {
        params: { path: { sessionId: this.sessionId } },
        headers: this.headers(),
      }),
    );
  }

  heartbeat() {
    return this.call<RunnerSessionView>(() =>
      api.assessment.POST('/v1/sessions/{sessionId}:heartbeat', {
        params: { path: { sessionId: this.sessionId } },
        headers: this.headers(),
      }),
    );
  }

  question(n: number) {
    return this.call<RunnerQuestionView>(() =>
      api.assessment.GET('/v1/sessions/{sessionId}/questions/{n}', {
        params: { path: { sessionId: this.sessionId, n: n as never } },
        headers: this.headers(),
      }),
    );
  }

  save(questionId: string, clientRev: number, answer: unknown) {
    return this.call<{ client_rev: number; remaining_seconds: number; code?: string }>(() =>
      api.assessment.PUT('/v1/sessions/{sessionId}/responses/{questionId}', {
        params: { path: { sessionId: this.sessionId, questionId } },
        body: { client_rev: clientRev, answer },
        headers: this.headers(),
      }),
    );
  }

  run(questionId: string, language: string, code: string, stdin: string) {
    return this.call<{ run_id: string; status: string; stdout?: string; stderr?: string }>(() =>
      api.assessment.POST('/v1/sessions/{sessionId}/questions/{questionId}/runs', {
        params: { path: { sessionId: this.sessionId, questionId } },
        body: { language, code, stdin } as never,
        headers: this.headers(),
      }),
    );
  }

  startProctoring() {
    return this.call<Record<string, unknown>>(() =>
      api.assessment.POST(
        '/v1/sessions/{sessionId}:startProctoring' as never,
        {
          params: { path: { sessionId: this.sessionId } },
          body: { consent: { biometrics: true, version: '2026-01' } },
          headers: this.headers(),
        } as never,
      ),
    );
  }

  submit() {
    return this.call<RunnerSessionView>(() =>
      api.assessment.POST('/v1/sessions/{sessionId}:submit', {
        params: { path: { sessionId: this.sessionId } },
        headers: this.headers(),
      }),
    );
  }
}
