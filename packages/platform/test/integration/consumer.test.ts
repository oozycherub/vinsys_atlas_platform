import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantActivated } from '@atlas/contracts';
import { createConsumer, newId, PoisonEventError } from '../../src';
import { createTestDatabase, type TestDatabase } from '../../src/testing';

describe('createConsumer', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.close();
  });

  const tenantId = newId();
  const payload = {
    tenant_id: tenantId,
    from_status: 'provisioning',
    to_status: 'active',
    reason: null,
    actor: 'staff-1',
    occurred_at: new Date().toISOString(),
  };
  const event = () => ({
    eventId: newId(),
    topic: TenantActivated.topic,
    tenantId,
    aggregateId: tenantId,
    payload,
  });

  it('processes once, skips redeliveries, and runs after-commit effects', async () => {
    const seen: string[] = [];
    const effects: string[] = [];
    const consumer = createConsumer({
      name: 'test.once',
      db,
      handlers: {
        [TenantActivated.topic]: (_tx, e) => {
          seen.push(e.eventId);
          return Promise.resolve(() => {
            effects.push(e.eventId);
            return Promise.resolve();
          });
        },
      },
    });
    const e = event();
    expect(consumer.topics).toEqual([TenantActivated.topic]);
    expect(await consumer.handle(e)).toBe('processed');
    expect(await consumer.handle(e)).toBe('duplicate');
    expect(seen).toEqual([e.eventId]);
    expect(effects).toEqual([e.eventId]);
    expect(await consumer.handle({ ...e, topic: 'other.thing.happened.v1' })).toBe('ignored');
  });

  it('leaves no marker when the handler fails, so the event is retried', async () => {
    let attempts = 0;
    const consumer = createConsumer({
      name: 'test.retry',
      db,
      handlers: {
        [TenantActivated.topic]: () => {
          attempts += 1;
          return attempts === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(undefined);
        },
      },
    });
    const e = event();
    await expect(consumer.handle(e)).rejects.toThrow('boom');
    expect(await consumer.handle(e)).toBe('processed');
    expect(attempts).toBe(2);
  });

  it('rejects payloads that fail the registered schema as poison', async () => {
    const consumer = createConsumer({
      name: 'test.poison',
      db,
      handlers: { [TenantActivated.topic]: () => Promise.resolve(undefined) },
    });
    await expect(consumer.handle({ ...event(), payload: { nope: true } })).rejects.toBeInstanceOf(
      PoisonEventError,
    );
  });
});
