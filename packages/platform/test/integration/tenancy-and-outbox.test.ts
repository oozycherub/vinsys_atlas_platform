import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineEvent } from '@atlas/contracts';
import { z } from 'zod';
import {
  appendOutbox,
  hashRequest,
  newId,
  runIdempotent,
  TenantContextError,
  withSystemTx,
  withTenantTx,
} from '@atlas/platform';
import { createTestDatabase, type TestDatabase } from '@atlas/platform/testing';

const SampleEvent = defineEvent(
  'platform.sample.happened.v1',
  'sample',
  z.object({ value: z.number().int() }),
);

describe('foundation migration, RLS and outbox', () => {
  let db: TestDatabase;
  const tenantA = newId();
  const tenantB = newId();

  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.close();
  });

  it('applies migrations in order and records them', async () => {
    expect(db.migrations.applied[0]).toBe('0001_foundation');
    const { rows } = await db.owner.query<{ version: number }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    expect(rows.map((r) => r.version)).toEqual(db.migrations.applied.map((_, i) => i + 1));
  });

  it('runs application transactions as a role subject to RLS', async () => {
    const { rows } = await db.transaction((tx) =>
      tx.query<{ role: string }>('SELECT current_user AS role'),
    );
    expect(rows[0]?.role).toBe('atlas_app');
  });

  it('isolates outbox rows by tenant', async () => {
    await withTenantTx(db, tenantA, (tx) =>
      appendOutbox(
        tx,
        SampleEvent.build({ tenantId: tenantA, aggregateId: newId(), payload: { value: 1 } }),
      ),
    );
    await withTenantTx(db, tenantB, (tx) =>
      appendOutbox(
        tx,
        SampleEvent.build({ tenantId: tenantB, aggregateId: newId(), payload: { value: 2 } }),
      ),
    );

    const seenByA = await withTenantTx(db, tenantA, (tx) =>
      tx.query<{ tenant_id: string }>('SELECT tenant_id FROM outbox_events'),
    );
    expect(seenByA.rows.map((r) => r.tenant_id)).toEqual([tenantA]);
  });

  it('rejects writing another tenant’s event', async () => {
    await expect(
      withTenantTx(db, tenantA, (tx) =>
        appendOutbox(
          tx,
          SampleEvent.build({ tenantId: tenantB, aggregateId: newId(), payload: { value: 3 } }),
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('fails closed when no tenant context is set', async () => {
    const { rows } = await db.transaction((tx) => tx.query('SELECT * FROM outbox_events'));
    expect(rows).toHaveLength(0);
  });

  it('allows platform-wide events only in a system transaction', async () => {
    const event = SampleEvent.build({
      tenantId: null,
      aggregateId: newId(),
      payload: { value: 4 },
    });
    await expect(withTenantTx(db, tenantA, (tx) => appendOutbox(tx, event))).rejects.toThrow(
      /row-level security/,
    );
    await expect(withSystemTx(db, (tx) => appendOutbox(tx, event))).resolves.toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it('refuses a non-UUID tenant id before touching the database', async () => {
    await expect(withTenantTx(db, "x' OR 1=1 --", async () => 1)).rejects.toBeInstanceOf(
      TenantContextError,
    );
  });

  it('validates event payloads against the contract', () => {
    expect(() =>
      SampleEvent.build({ tenantId: tenantA, aggregateId: newId(), payload: { value: 1.5 } }),
    ).toThrow();
  });
});

describe('runIdempotent', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.close();
  });

  const scope = 'test:platform:alice';

  it('executes once and replays the stored response', async () => {
    let calls = 0;
    const request = { scope, key: 'key-0001', requestHash: hashRequest('POST', '/x', { a: 1 }) };
    const work = async () => {
      calls += 1;
      return { status: 201, body: { id: 'abc' } };
    };
    const first = await runIdempotent(db, request, work);
    const second = await runIdempotent(db, request, work);
    expect(first).toEqual({ status: 201, body: { id: 'abc' }, replayed: false });
    expect(second).toEqual({ status: 201, body: { id: 'abc' }, replayed: true });
    expect(calls).toBe(1);
  });

  it('rejects the same key with a different request', async () => {
    const work = async () => ({ status: 201, body: {} });
    await runIdempotent(
      db,
      { scope, key: 'key-0002', requestHash: hashRequest('POST', '/x', { a: 1 }) },
      work,
    );
    await expect(
      runIdempotent(
        db,
        { scope, key: 'key-0002', requestHash: hashRequest('POST', '/x', { a: 2 }) },
        work,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 422 });
  });

  it('does not store a key when the work fails, so the client can retry', async () => {
    const request = { scope, key: 'key-0003', requestHash: hashRequest('POST', '/x', {}) };
    await expect(
      runIdempotent(db, request, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const retry = await runIdempotent(db, request, async () => ({
      status: 200,
      body: { ok: true },
    }));
    expect(retry.replayed).toBe(false);
  });

  it('hashes bodies canonically regardless of key order', () => {
    expect(hashRequest('post', '/x', { a: 1, b: { c: 2, d: 3 } })).toBe(
      hashRequest('POST', '/x', { b: { d: 3, c: 2 }, a: 1 }),
    );
  });
});
