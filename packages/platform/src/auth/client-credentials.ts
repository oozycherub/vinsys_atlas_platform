import { type Clock, systemClock } from '../clock';

export interface ClientCredentialsOptions {
  /** identity-svc token endpoint, e.g. https://id.atlas.app/v1/oauth/token */
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: readonly string[];
  clock?: Clock;
  timeoutMs?: number;
}

/**
 * Service-to-service bearer tokens via OAuth client credentials (identity-svc). Caches the
 * token until a minute before it expires and shares one in-flight request between callers.
 */
export class ClientCredentialsTokenProvider {
  private cached: { token: string; until: number } | null = null;
  private inFlight: Promise<string> | null = null;

  constructor(private readonly options: ClientCredentialsOptions) {}

  async token(): Promise<string> {
    const now = (this.options.clock ?? systemClock).now().getTime();
    if (this.cached && now < this.cached.until) return this.cached.token;
    this.inFlight ??= this.fetchToken(now).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async fetchToken(now: number): Promise<string> {
    const basic = Buffer.from(
      `${encodeURIComponent(this.options.clientId)}:${encodeURIComponent(this.options.clientSecret)}`,
    ).toString('base64');
    const response = await fetch(this.options.tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: this.options.scopes.join(' '),
      }).toString(),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
    });
    if (!response.ok) throw new Error(`Token request failed with HTTP ${response.status}.`);
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string') {
      throw new Error('The token response has no access_token.');
    }
    const ttl = typeof body.expires_in === 'number' ? body.expires_in : 300;
    this.cached = { token: body.access_token, until: now + Math.max(0, ttl - 60) * 1000 };
    return body.access_token;
  }
}
