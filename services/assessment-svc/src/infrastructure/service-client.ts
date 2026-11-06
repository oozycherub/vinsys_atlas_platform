import { ServiceRejectedError, UpstreamError } from '../application/ports';

export interface ServiceClientOptions {
  baseUrl: string;
  token: () => Promise<string>;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * One call to an internal service with a service token. 4xx problem documents (except 401) are
 * passed on as ServiceRejectedError with their code and Retry-After; 5xx, 401 and network
 * failures are dependency failures (UpstreamError → 503).
 */
export async function serviceCall<T>(
  o: ServiceClientOptions,
  service: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  timeoutMs = o.timeoutMs ?? 5000,
): Promise<T> {
  let response: Response;
  try {
    response = await (o.fetch ?? fetch)(`${o.baseUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await o.token()}`,
        'Content-Type': 'application/json',
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new UpstreamError(`${service}: ${(error as Error).name}`);
  }
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.ok) return payload as T;
  if (response.status >= 400 && response.status < 500 && response.status !== 401) {
    const retry = Number(response.headers.get('Retry-After'));
    throw new ServiceRejectedError(
      response.status,
      typeof payload['code'] === 'string' ? payload['code'] : 'SERVICE_REJECTED',
      typeof payload['detail'] === 'string' ? payload['detail'] : `${service} refused the request.`,
      Number.isFinite(retry) && retry > 0 ? retry : null,
    );
  }
  throw new UpstreamError(`${service}: HTTP ${response.status}`);
}
