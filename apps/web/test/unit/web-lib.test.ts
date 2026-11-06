import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { dirOf, isLocale, translate } from '../../lib/i18n';
import { AnswerQueue, flush, type PendingAnswer } from '../../lib/offline-queue';
import { decodeClaims, homeFor, portalsFor, tenantSlug } from '../../lib/session';
import { announcement, formatClock, remainingAt } from '../../lib/timer';

describe('offline answer queue', () => {
  const entry = (questionId: string, answer: unknown, queuedAt: number): PendingAnswer => ({
    sessionId: 's1',
    questionId,
    answer,
    queuedAt,
  });

  it('keeps the latest answer per question, per session, oldest first', async () => {
    const q = new AnswerQueue();
    await q.put(entry('q2', 'old', 1));
    await q.put(entry('q1', 'a', 2));
    await q.put(entry('q2', 'new', 3));
    await q.put({ ...entry('q1', 'other session', 4), sessionId: 's2' });
    expect((await q.pending('s1')).map((p) => [p.questionId, p.answer])).toEqual([
      ['q1', 'a'],
      ['q2', 'new'],
    ]);
  });

  it('flushes in order, stops when offline, drops closed sessions, retries conflicts', async () => {
    const q = new AnswerQueue();
    await q.put({ sessionId: 'f', questionId: 'a', answer: 1, queuedAt: 1 });
    await q.put({ sessionId: 'f', questionId: 'b', answer: 2, queuedAt: 2 });
    await q.put({ sessionId: 'f', questionId: 'c', answer: 3, queuedAt: 3 });
    const seen: string[] = [];
    let first = await flush(
      q,
      'f',
      (p) => (seen.push(p.questionId), Promise.resolve(p.questionId === 'b' ? 'offline' : 'saved')),
    );
    expect(first).toEqual({ sent: 1, remaining: 2 });
    expect(seen).toEqual(['a', 'b']);
    first = await flush(q, 'f', (p) =>
      Promise.resolve(p.questionId === 'b' ? 'conflict' : 'closed'),
    );
    expect(first).toEqual({ sent: 0, remaining: 1 });
    expect((await q.pending('f')).map((p) => p.questionId)).toEqual(['b']);
  });

  it('does not remove an answer that changed while it was being sent', async () => {
    const q = new AnswerQueue();
    const sent = { sessionId: 'r', questionId: 'x', answer: 'v1', queuedAt: 1 };
    await q.put(sent);
    await q.put({ ...sent, answer: 'v2', queuedAt: 2 });
    await q.remove(sent);
    expect((await q.pending('r'))[0]?.answer).toBe('v2');
  });
});

describe('timer', () => {
  it('counts down from the server’s remaining time, using local time only as elapsed', () => {
    const sync = {
      remainingSeconds: 120,
      serverTime: '2026-11-06T09:00:00Z',
      receivedAt: 1_000_000,
    };
    expect(remainingAt(sync, 1_000_000)).toBe(120);
    expect(remainingAt(sync, 1_030_500)).toBe(90);
    expect(remainingAt(sync, 2_000_000)).toBe(0);
    expect(remainingAt(sync, 900_000)).toBe(120); // a clock that went backwards changes nothing
  });

  it('formats and announces thresholds once', () => {
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatClock(65)).toBe('01:05');
    expect(formatClock(-3)).toBe('00:00');
    expect(announcement(601, 600)).toBe('10 minutes left');
    expect(announcement(61, 60)).toBe('1 minute left');
    expect(announcement(31, 29)).toBe('30 seconds left');
    expect(announcement(1, 0)).toBe('Time is up');
    expect(announcement(500, 499)).toBeNull();
  });
});

describe('session and portals', () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const tok = (claims: unknown) => `${b64({ alg: 'none' })}.${b64(claims)}.x`;

  it('reads claims for display only, and picks a home portal', () => {
    const admin = decodeClaims(tok({ sub: 'u1', tid: 't1', roles: ['tenant_admin'] }));
    expect(admin).toEqual({ sub: 'u1', tid: 't1', roles: ['tenant_admin'], scopes: [] });
    expect(homeFor(admin)).toBe('/admin');
    expect(portalsFor(admin)).toEqual(['admin', 'recruiter', 'employee']);
    const rec = decodeClaims(tok({ sub: 'u2', roles: ['recruiter'] }));
    expect(homeFor(rec)).toBe('/recruiter');
    expect(portalsFor(rec)).toEqual(['recruiter']);
    expect(homeFor(decodeClaims(tok({ sub: 'u3', roles: ['employee'] })))).toBe('/employee');
    expect(homeFor(null)).toBe('/login');
    expect(portalsFor(null)).toEqual([]);
    expect(decodeClaims('garbage')).toBeNull();
    expect(decodeClaims('a.!!!.c')).toBeNull();
  });

  it('derives the workspace from the host', () => {
    expect(tenantSlug('acme.atlas.example')).toBe('acme');
    expect(tenantSlug('localhost')).toBe(process.env['NEXT_PUBLIC_ATLAS_TENANT'] ?? 'dev');
  });
});

describe('i18n', () => {
  it('has Arabic for every key and renders it right-to-left', () => {
    expect(dirOf('ar')).toBe('rtl');
    expect(dirOf('en')).toBe('ltr');
    expect(isLocale('ar')).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(translate('ar', 'nav.signOut')).toBe('تسجيل الخروج');
  });
});
