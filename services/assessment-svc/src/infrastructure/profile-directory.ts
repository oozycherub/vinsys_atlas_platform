import { type ProfileDirectory, UpstreamError } from '../application/ports';

export interface ProfileDirectoryOptions {
  baseUrl: string;
  token: () => Promise<string>;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * profile-svc: the candidate behind an open invite link. Looks the email up through the blind
 * index (scope pii:read) and creates the candidate when there is none (Idempotency-Key, so a
 * retried redemption never creates two).
 */
export class HttpProfileDirectory implements ProfileDirectory {
  constructor(private readonly o: ProfileDirectoryOptions) {}

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      const response = await (this.o.fetch ?? fetch)(
        `${this.o.baseUrl.replace(/\/$/, '')}${path}`,
        {
          ...init,
          headers: {
            Authorization: `Bearer ${await this.o.token()}`,
            'Content-Type': 'application/json',
            ...(init.headers ?? {}),
          },
          signal: AbortSignal.timeout(this.o.timeoutMs ?? 5000),
        },
      );
      if (response.status === 429 || response.status >= 500)
        throw new UpstreamError(`profile-svc: HTTP ${response.status}`);
      return response;
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError(`profile-svc: ${(error as Error).name}`);
    }
  }

  async findOrCreate(
    tenantId: string,
    person: { fullName: string; email: string },
    idempotencyKey: string,
  ): Promise<string> {
    const email = person.email.trim().toLowerCase();
    const found = await this.call(
      `/v1/candidates?tenant_id=${tenantId}&email=${encodeURIComponent(email)}`,
    );
    if (found.ok) {
      const body = (await found.json()) as { items: { candidate_id: string }[] };
      if (body.items[0]) return body.items[0].candidate_id;
    }
    const created = await this.call('/v1/candidates', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({
        tenant_id: tenantId,
        source: 'external_applicant',
        pii: { full_name: person.fullName, email },
      }),
    });
    const body = (await created.json().catch(() => ({}))) as {
      candidate_id?: string;
      code?: string;
    };
    if (
      (created.status === 201 || created.status === 200 || body.code === 'CANDIDATE_EMAIL_TAKEN') &&
      body.candidate_id
    ) {
      return body.candidate_id;
    }
    throw new UpstreamError(
      `profile-svc: could not create the candidate (HTTP ${created.status} ${body.code ?? ''})`.trim(),
    );
  }
}

/** Development and tests: candidates keyed by tenant and email. */
export class MemoryProfileDirectory implements ProfileDirectory {
  readonly byEmail = new Map<string, string>();

  async findOrCreate(
    tenantId: string,
    person: { fullName: string; email: string },
  ): Promise<string> {
    const key = `${tenantId}:${person.email.trim().toLowerCase()}`;
    let id = this.byEmail.get(key);
    if (!id) {
      id = crypto.randomUUID();
      this.byEmail.set(key, id);
    }
    return id;
  }
}
