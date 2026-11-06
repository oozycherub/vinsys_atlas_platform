import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, type JWK, type KeyLike, SignJWT } from 'jose';

interface PendingCode {
  clientId: string;
  redirectUri: string;
  nonce: string;
  codeChallenge: string;
  email: string;
  name: string;
}

/**
 * Minimal OpenID Provider for tests: discovery, JWKS and a token endpoint that enforces client
 * authentication (Basic) and PKCE, then signs an ID token. `authorize()` stands in for the
 * user signing in at the IdP and returns the redirect back to Atlas.
 */
export class FakeOidcProvider {
  issuer = '';
  readonly clientId = 'atlas-at-idp';
  readonly clientSecret = `secret-${randomBytes(8).toString('hex')}`;
  /** Overrides applied to the next ID token (e.g. a wrong nonce). */
  tamper: Record<string, unknown> = {};
  private server: Server | null = null;
  private key!: KeyLike;
  private jwk!: JWK;
  private readonly codes = new Map<string, PendingCode>();

  async start(): Promise<void> {
    const pair = await generateKeyPair('ES256');
    this.key = pair.privateKey;
    this.jwk = { ...(await exportJWK(pair.publicKey)), kid: 'idp-1', alg: 'ES256', use: 'sig' };
    this.server = createServer((req, res) => {
      void this.handle(req.method ?? 'GET', req.url ?? '/', req.headers['authorization'], req, res);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** The user signs in at the IdP as `email`; returns the URL the IdP redirects the browser to. */
  authorize(authorizeUrl: string, email: string, name = 'Federated User'): string {
    const url = new URL(authorizeUrl);
    const p = url.searchParams;
    if (p.get('client_id') !== this.clientId) throw new Error('unexpected client_id');
    if (p.get('code_challenge_method') !== 'S256') throw new Error('PKCE missing');
    const code = randomBytes(16).toString('hex');
    this.codes.set(code, {
      clientId: p.get('client_id')!,
      redirectUri: p.get('redirect_uri')!,
      nonce: p.get('nonce')!,
      codeChallenge: p.get('code_challenge')!,
      email,
      name,
    });
    const back = new URL(p.get('redirect_uri')!);
    back.searchParams.set('code', code);
    back.searchParams.set('state', p.get('state')!);
    return back.toString();
  }

  private async handle(
    method: string,
    path: string,
    authorization: string | undefined,
    req: NodeJS.ReadableStream,
    res: ServerResponse,
  ): Promise<void> {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (path === '/.well-known/openid-configuration') {
      return send(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
      });
    }
    if (path === '/jwks') return send(200, { keys: [this.jwk] });
    if (path === '/token' && method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += String(chunk);
      const form = new URLSearchParams(raw);
      const expected = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`;
      if (authorization !== expected) return send(401, { error: 'invalid_client' });
      const pending = this.codes.get(form.get('code') ?? '');
      this.codes.delete(form.get('code') ?? '');
      const challenge = createHash('sha256')
        .update(form.get('code_verifier') ?? '')
        .digest('base64url');
      if (
        !pending ||
        pending.redirectUri !== form.get('redirect_uri') ||
        challenge !== pending.codeChallenge
      ) {
        return send(400, { error: 'invalid_grant' });
      }
      const idToken = await new SignJWT({
        email: pending.email,
        email_verified: true,
        name: pending.name,
        nonce: pending.nonce,
        ...this.tamper,
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'idp-1' })
        .setIssuer(this.issuer)
        .setAudience(this.clientId)
        .setSubject(`idp|${pending.email}`)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(this.key);
      this.tamper = {};
      return send(200, { access_token: 'idp-at', token_type: 'Bearer', id_token: idToken });
    }
    return send(404, { error: 'not_found' });
  }
}
