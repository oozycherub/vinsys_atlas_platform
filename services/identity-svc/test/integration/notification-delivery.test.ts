import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '@atlas/platform';
import { MemoryLogStream } from '@atlas/platform/testing';
import { NotificationLinkDelivery } from '../../src/infrastructure/notification-link-delivery';

describe('NotificationLinkDelivery', () => {
  let server: Server;
  let baseUrl = '';
  const received: { headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
  let script: number[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += String(c)));
      req.on('end', () => {
        received.push({ headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> });
        res.writeHead(script.shift() ?? 202);
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const message = {
    kind: 'invitation' as const,
    tenantId: '0192f0c4-0000-7000-8000-0000000000bb',
    email: 'ada@corp.test',
    url: 'https://acme.atlas.test/invite?token=SECRET-TOKEN',
    expiresAt: new Date('2026-11-08T00:00:00Z'),
  };

  function delivery(logs?: MemoryLogStream) {
    return new NotificationLinkDelivery({
      baseUrl,
      token: () => Promise.resolve('svc-token'),
      backoffMs: 1,
      ...(logs ? { logger: createLogger({ service: 't', level: 'info', destination: logs }) } : {}),
    });
  }

  it('retries 5xx with the same idempotency key, authenticated as a service', async () => {
    received.length = 0;
    script = [503, 502, 202];
    await delivery().send(message);
    expect(received).toHaveLength(3);
    expect(new Set(received.map((r) => r.headers['idempotency-key'])).size).toBe(1);
    expect(received[0]!.headers['authorization']).toBe('Bearer svc-token');
    expect(received[0]!.body).toEqual({
      kind: 'invitation',
      tenant_id: message.tenantId,
      email: 'ada@corp.test',
      url: message.url,
      expires_at: '2026-11-08T00:00:00.000Z',
    });
  });

  it('does not retry client errors, and logs failures without the link', async () => {
    received.length = 0;
    script = [400];
    const logs = new MemoryLogStream();
    await delivery(logs).send(message);
    expect(received).toHaveLength(1);
    const text = JSON.stringify(logs.lines);
    expect(text).toContain('link delivery failed');
    expect(text).not.toContain('SECRET-TOKEN');
  });
});
