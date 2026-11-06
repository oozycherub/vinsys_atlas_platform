import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, expect, it } from 'vitest';
import { EmailSendError, InboxHub, WebhookTransportError } from '../../src/application/ports';
import { loadNotificationSvcConfig } from '../../src/config';
import { defaultTemplate } from '../../src/domain/default-templates';
import {
  emailRetryDelayMs,
  inQuietHours,
  isValidTimeZone,
  localMinutes,
  nextSendTime,
  nextUnderCap,
} from '../../src/domain/scheduling';
import {
  escapeHtml,
  fill,
  htmlToText,
  placeholdersIn,
  renderEmail,
  TemplateError,
  UnsafeOutputError,
  validateTemplate,
} from '../../src/domain/templates';
import { allowedPlaceholders, isNotificationType, TYPE_NAMES } from '../../src/domain/types';
import {
  checkEndpointUrl,
  isPublicAddress,
  retryDelayMs,
  signPayload,
  verifySignature,
  webhookTypeOf,
} from '../../src/domain/webhooks';
import {
  HttpWebhookTransport,
  LogEmailSender,
  SendGridEmailSender,
  SesEmailSender,
} from '../../src/infrastructure/adapters';

const mail = {
  from: 'Corp <no-reply@corp.test>',
  to: 'a@b.test',
  subject: 'S',
  html: '<p>h</p>',
  text: 't',
  headers: { 'X-Atlas-Notification-Id': 'n1' },
};

describe('templates', () => {
  it('every built-in template validates', async () => {
    for (const type of TYPE_NAMES)
      for (const channel of ['email', 'in_app'] as const) {
        const t = defaultTemplate(type, channel);
        if (t) await validateTemplate(type, channel, t.subject, t.source);
      }
    expect(defaultTemplate('invitation', 'in_app')).toBeNull();
  });

  it('lists every problem at once', async () => {
    const err = await validateTemplate(
      'report_ready',
      'in_app',
      'x {URL}',
      'a {URL} {Nope} <script>',
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TemplateError);
    const messages = (err as TemplateError).issues.map((i) => `${i.path}:${i.message}`);
    expect(messages).toEqual(
      expect.arrayContaining([
        'subject:unknown placeholder {URL}',
        'subject:{URL} may only be a link target',
        'source:unknown placeholder {Nope}',
        'source:<script> is not allowed',
      ]),
    );
  });

  it('accepts {URL} only as a whole href, and only https values', async () => {
    const ok =
      '<mjml><mj-body><mj-section><mj-column><mj-button href="{URL}">Go</mj-button></mj-column></mj-section></mj-body></mjml>';
    await expect(validateTemplate('magic_link', 'email', 'Sign in', ok)).resolves.toBeUndefined();
    await expect(
      validateTemplate(
        'magic_link',
        'email',
        'Sign in',
        ok.replace('"{URL}"', '"https://x/{URL}"'),
      ),
    ).rejects.toThrow('href');
    await expect(
      validateTemplate('self_rating_reminder', 'in_app', 'x', 'go {URL}'),
    ).rejects.toThrow('email links only');
    await expect(renderEmail('s', ok, { URL: 'javascript:alert(1)' })).rejects.toBeInstanceOf(
      UnsafeOutputError,
    );
    await expect(renderEmail('s', ok, { URL: '' })).resolves.toMatchObject({ subject: 's' });
  });

  it('refuses rendered output with active content', async () => {
    const raw = '<mjml><mj-body><mj-raw><div onclick="x()">x</div></mj-raw></mj-body></mjml>';
    await expect(renderEmail('s', raw, {})).rejects.toThrow('active content');
  });

  it('substitutes once and escapes', () => {
    expect(fill('{A} {B} {C}', { A: '<x>', B: '{A}' }, true)).toBe('&lt;x&gt; {A} ');
    expect(fill('{A}', { A: 'one\r\ntwo' }, false)).toBe('one two');
    expect(fill('{constructor}{toString}', {}, false)).toBe('');
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
    expect(placeholdersIn('{A} {b} { C } {D_1}')).toEqual(['A', 'b', 'D_1']);
  });

  it('builds a plain-text alternative', () => {
    expect(
      htmlToText(
        '<html><head><style>p{}</style></head><body><!-- c --><p>Hi &amp; <b>you</b></p><a href="https://x.test">Go</a><br>&lt;ok&gt;&nbsp;&quot;&#39;</body></html>',
      ),
    ).toBe('Hi & you\nGo (https://x.test)\n<ok> "\'');
  });

  it('knows its types', () => {
    expect(isNotificationType('invitation')).toBe(true);
    expect(isNotificationType('constructor')).toBe(false);
    expect(allowedPlaceholders('invitation')).toEqual(['Recipient_Name', 'URL', 'Expires_At']);
  });
});

describe('webhook signatures', () => {
  const body = '{"id":"e1"}';
  it('round-trips and rejects old, future, tampered or malformed signatures', () => {
    const header = signPayload('whsec_x', 1_000_000, body);
    expect(header).toMatch(/^t=1000000,v1=[0-9a-f]{64}$/);
    expect(verifySignature(header, 'whsec_x', body, 1_000_000 + 300)).toBe(true);
    expect(verifySignature(header, 'whsec_x', body, 1_000_000 + 301)).toBe(false);
    expect(verifySignature(header, 'whsec_x', body, 1_000_000 - 301)).toBe(false);
    expect(verifySignature(header, 'whsec_y', body, 1_000_000)).toBe(false);
    expect(verifySignature(header, 'whsec_x', `${body} `, 1_000_000)).toBe(false);
    expect(verifySignature('t=abc,v1=00', 'whsec_x', body, 1_000_000)).toBe(false);
    expect(verifySignature('t=1000000,v1=zz', 'whsec_x', body, 1_000_000)).toBe(false);
    expect(verifySignature('t=1000000', 'whsec_x', body, 1_000_000)).toBe(false);
  });

  it('backs off exponentially from one minute', () => {
    expect([1, 2, 3, 8].map(retryDelayMs)).toEqual([60_000, 120_000, 240_000, 7_680_000]);
    expect(retryDelayMs(0)).toBe(60_000);
    expect(emailRetryDelayMs(3)).toBe(240_000);
  });

  it('maps topics to public event names', () => {
    expect(webhookTypeOf('assessment.session.submitted.v1')).toBe('assessment.session.submitted');
    expect(webhookTypeOf('identity.user.invited.v1')).toBeNull();
  });
});

describe('SSRF guard', () => {
  it.each([
    ['8.8.8.8', true],
    ['1.1.1.1', true],
    ['10.1.2.3', false],
    ['127.0.0.1', false],
    ['0.0.0.0', false],
    ['169.254.169.254', false],
    ['172.16.0.1', false],
    ['172.31.255.255', false],
    ['172.32.0.1', true],
    ['192.168.1.1', false],
    ['100.64.0.1', false],
    ['100.128.0.1', true],
    ['192.0.0.8', false],
    ['192.0.2.1', false],
    ['198.18.0.1', false],
    ['198.51.100.1', false],
    ['203.0.113.9', false],
    ['224.0.0.1', false],
    ['::1', false],
    ['::', false],
    ['fd00::1', false],
    ['fe80::1', false],
    ['ff02::1', false],
    ['::ffff:10.0.0.1', false],
    ['::ffff:8.8.8.8', true],
    ['64:ff9b::1', false],
    ['2001:db8::1', false],
    ['2606:4700::1111', true],
    ['not-an-ip', false],
  ])('%s public=%s', (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected);
  });

  it('checks endpoint URLs', () => {
    expect(checkEndpointUrl('https://hooks.example.com/x')).toBeNull();
    expect(checkEndpointUrl('https://[::1]/x')).toBe('must not point at a private address');
    expect(checkEndpointUrl('https://api.internal/x')).toBe('must not point at an internal host');
    expect(checkEndpointUrl('https://a.localhost/x')).toBe('must not point at an internal host');
  });
});

describe('quiet hours and the cap', () => {
  const quiet = { startMin: 20 * 60, endMin: 8 * 60, timeZone: 'UTC' };
  it('handles windows across midnight and within a day', () => {
    expect(inQuietHours(new Date('2026-11-06T21:00:00Z'), quiet)).toBe(true);
    expect(inQuietHours(new Date('2026-11-06T07:59:00Z'), quiet)).toBe(true);
    expect(inQuietHours(new Date('2026-11-06T08:00:00Z'), quiet)).toBe(false);
    const day = { startMin: 12 * 60, endMin: 13 * 60, timeZone: 'UTC' };
    expect(inQuietHours(new Date('2026-11-06T12:30:00Z'), day)).toBe(true);
    expect(inQuietHours(new Date('2026-11-06T13:00:00Z'), day)).toBe(false);
    expect(inQuietHours(new Date('2026-11-06T12:30:00Z'), { ...day, endMin: day.startMin })).toBe(
      false,
    );
  });

  it('defers to the end of the window in the recipient zone', () => {
    const at = new Date('2026-11-06T18:30:45Z');
    expect(nextSendTime(at, null)).toBe(at);
    expect(nextSendTime(at, quiet)).toBe(at);
    expect(nextSendTime(at, { ...quiet, timeZone: 'Asia/Dubai' }).toISOString()).toBe(
      '2026-11-07T04:00:00.000Z',
    );
    expect(localMinutes(at, 'Nowhere/Invalid')).toBe(18 * 60 + 30);
    expect(isValidTimeZone('Europe/Paris')).toBe(true);
    expect(isValidTimeZone('Nowhere/Invalid')).toBe(false);
  });

  it('caps sends in any 24 hours', () => {
    const now = new Date('2026-11-07T12:00:00Z');
    const t = (h: number) => new Date(now.getTime() - h * 3_600_000);
    expect(nextUnderCap(now, [t(1)], 2)).toBe(now);
    expect(nextUnderCap(now, [t(1), t(5), t(30)], 2).toISOString()).toBe(
      new Date(t(5).getTime() + 86_400_000).toISOString(),
    );
  });
});

describe('InboxHub', () => {
  it('wakes subscribers of one inbox only', () => {
    const hub = new InboxHub();
    let a = 0;
    let b = 0;
    const offA = hub.subscribe('t', 'a', () => (a += 1));
    hub.subscribe('t', 'b', () => (b += 1));
    hub.publish('t', 'a');
    expect([a, b]).toEqual([1, 0]);
    offA();
    hub.publish('t', 'a');
    expect(a).toBe(1);
    expect(hub.size).toBe(1);
  });
});

describe('email adapters', () => {
  it('SES: sends, and classifies errors', async () => {
    const ses = mockClient(SESv2Client);
    ses
      .on(SendEmailCommand)
      .resolvesOnce({ MessageId: 'm-1' })
      .resolvesOnce({})
      .rejectsOnce(Object.assign(new Error('x'), { name: 'MessageRejected' }))
      .rejectsOnce(
        Object.assign(new Error('x'), {
          name: 'TooManyRequestsException',
          $metadata: { httpStatusCode: 429 },
        }),
      )
      .rejectsOnce(Object.assign(new Error('x'), { name: '', $metadata: { httpStatusCode: 500 } }));
    const sender = new SesEmailSender(new SESv2Client({ region: 'eu-west-1' }), 'cfg');
    expect(await sender.send(mail)).toEqual({ messageId: 'm-1' });
    expect(await sender.send(mail)).toEqual({ messageId: 'ses' });
    const input = ses.commandCalls(SendEmailCommand)[0]?.args[0].input;
    expect(input).toMatchObject({
      FromEmailAddress: mail.from,
      ConfigurationSetName: 'cfg',
      Destination: { ToAddresses: ['a@b.test'] },
    });
    await expect(sender.send(mail)).rejects.toMatchObject({ permanent: true });
    await expect(sender.send(mail)).rejects.toMatchObject({ permanent: false });
    await expect(sender.send(mail)).rejects.toMatchObject({
      permanent: false,
      message: 'SESError',
    });
    ses.restore();
  });

  it('SendGrid: posts mail/send and classifies status codes', async () => {
    const calls: { url: string; body: string }[] = [];
    const responses = [
      new Response(null, { status: 202, headers: { 'x-message-id': 'sg-1' } }),
      new Response(null, { status: 202 }),
      new Response('bad', { status: 400 }),
      new Response('slow', { status: 429 }),
    ];
    const fake = ((url: string, init: RequestInit) => {
      calls.push({ url, body: init.body as string });
      return Promise.resolve(responses.shift() as Response);
    }) as unknown as typeof fetch;
    const sg = new SendGridEmailSender('key', fake, 'https://sg.test');
    expect(await sg.send(mail)).toEqual({ messageId: 'sg-1' });
    expect(await sg.send({ ...mail, from: 'plain@corp.test' })).toEqual({ messageId: 'sendgrid' });
    await expect(sg.send(mail)).rejects.toMatchObject({ permanent: true, message: 'HTTP 400' });
    await expect(sg.send(mail)).rejects.toMatchObject({ permanent: false });
    expect(calls[0]?.url).toBe('https://sg.test/v3/mail/send');
    expect(JSON.parse(calls[0]?.body as string).from).toEqual({
      email: 'no-reply@corp.test',
      name: 'Corp',
    });
    expect(JSON.parse(calls[1]?.body as string).from).toEqual({ email: 'plain@corp.test' });
    const down = new SendGridEmailSender('key', (() =>
      Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch);
    await expect(down.send(mail)).rejects.toBeInstanceOf(EmailSendError);
  });

  it('log sender never logs the body', async () => {
    const lines: unknown[] = [];
    const logger = { info: (o: unknown) => lines.push(o) } as never;
    const out = await new LogEmailSender(logger).send({ ...mail, html: 'SECRET' });
    expect(out.messageId).toMatch(/^log-/);
    expect(JSON.stringify(lines)).not.toContain('SECRET');
  });
});

describe('HttpWebhookTransport', () => {
  const ok = (() =>
    Promise.resolve(new Response('fine', { status: 204 }))) as unknown as typeof fetch;
  it('posts to public hosts only, without following redirects', async () => {
    let init: RequestInit | undefined;
    const spy = ((_u: string, i: RequestInit) => {
      init = i;
      return Promise.resolve(new Response(null, { status: 302 }));
    }) as unknown as typeof fetch;
    const t = new HttpWebhookTransport(1000, () => Promise.resolve([{ address: '8.8.8.8' }]), spy);
    expect(await t.post('https://hooks.example.com/x', '{}', {})).toEqual({ status: 302 });
    expect(init?.redirect).toBe('manual');
    const rebinding = new HttpWebhookTransport(
      1000,
      () => Promise.resolve([{ address: '8.8.8.8' }, { address: '10.0.0.1' }]),
      ok,
    );
    await expect(rebinding.post('https://hooks.example.com/x', '{}', {})).rejects.toThrow(
      'non-public',
    );
    const none = new HttpWebhookTransport(1000, () => Promise.resolve([]), ok);
    await expect(none.post('https://hooks.example.com/x', '{}', {})).rejects.toThrow('non-public');
    const nxdomain = new HttpWebhookTransport(
      1000,
      () => Promise.reject(new Error('ENOTFOUND')),
      ok,
    );
    await expect(nxdomain.post('https://nope.example.com/x', '{}', {})).rejects.toThrow(
      'DNS lookup failed',
    );
    await expect(
      new HttpWebhookTransport().post('http://hooks.example.com/x', '{}', {}),
    ).rejects.toBeInstanceOf(WebhookTransportError);
  });

  it('reports timeouts and connection errors', async () => {
    const resolve = () => Promise.resolve([{ address: '8.8.8.8' }]);
    const timeout = new HttpWebhookTransport(1000, resolve, (() =>
      Promise.reject(
        Object.assign(new Error('t'), { name: 'TimeoutError' }),
      )) as unknown as typeof fetch);
    await expect(timeout.post('https://h.example.com', '{}', {})).rejects.toThrow('timeout');
    const refused = new HttpWebhookTransport(1000, resolve, (() =>
      Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch);
    await expect(refused.post('https://h.example.com', '{}', {})).rejects.toThrow(
      'connection failed',
    );
  });
});

describe('config', () => {
  const base = {
    ATLAS_DATABASE_URL: 'postgres://u:p@localhost:5432/atlas',
    ATLAS_AUTH_ISSUER: 'https://id.atlas.test',
    ATLAS_AUTH_AUDIENCE: 'atlas',
    ATLAS_AUTH_SHARED_SECRET: 'x'.repeat(32),
    ATLAS_NOTIFICATION_SECRET_KEY: Buffer.alloc(32, 1).toString('base64'),
  };
  it('defaults to the log provider on port 8093', () => {
    const c = loadNotificationSvcConfig(base);
    expect(c).toMatchObject({ ATLAS_NOTIFICATION_PORT: 8093, ATLAS_EMAIL_PROVIDER: 'log' });
  });
  it('refuses unsafe or incomplete production settings', () => {
    expect(() =>
      loadNotificationSvcConfig({ ...base, ATLAS_NOTIFICATION_SECRET_KEY: 'c2hvcnQ=' }),
    ).toThrow();
    expect(() => loadNotificationSvcConfig({ ...base, ATLAS_EMAIL_PROVIDER: 'ses' })).toThrow(
      /ATLAS_SES_REGION/,
    );
    expect(() => loadNotificationSvcConfig({ ...base, ATLAS_EMAIL_PROVIDER: 'sendgrid' })).toThrow(
      /ATLAS_SENDGRID_API_KEY/,
    );
    expect(() =>
      loadNotificationSvcConfig({ ...base, ATLAS_NOTIFICATION_EVENT_SOURCE: 'kafka' }),
    ).toThrow(/ATLAS_KAFKA_BROKERS/);
    expect(() =>
      loadNotificationSvcConfig({ ...base, ATLAS_AUTH_SHARED_SECRET: undefined }),
    ).toThrow(/JWKS/);
    expect(() => loadNotificationSvcConfig({ ...base, NODE_ENV: 'production' })).toThrow(
      /shared-secret|log provider|without events/,
    );
    expect(
      loadNotificationSvcConfig({
        ...base,
        ATLAS_AUTH_SHARED_SECRET: undefined,
        ATLAS_AUTH_JWKS_URL: 'https://id.atlas.test/jwks',
        NODE_ENV: 'production',
        ATLAS_EMAIL_PROVIDER: 'ses',
        ATLAS_SES_REGION: 'eu-west-1',
        ATLAS_NOTIFICATION_EVENT_SOURCE: 'kafka',
        ATLAS_KAFKA_BROKERS: 'k1:9092, k2:9092',
      }).ATLAS_KAFKA_BROKERS,
    ).toEqual(['k1:9092', 'k2:9092']);
  });
});
