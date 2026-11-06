import { getEventDefinition } from '@atlas/contracts';
import { type Logger } from 'pino';
import { type Database, type Tx, withSystemTx } from './db/database';
import { isUuid } from './ids';

/** One event as delivered by the transport (Kafka via the Debezium outbox router). */
export interface ConsumedEvent {
  eventId: string;
  topic: string;
  tenantId: string | null;
  aggregateId: string;
  payload: unknown;
}

/** Side effect to run only after the handler's transaction commits (e.g. sending an email). */
export type AfterCommit = () => Promise<void>;

/**
 * Handles one event inside the de-duplication transaction. Tenant-owned tables need the tenant
 * context: call setTenantContext(tx, event.tenantId) before touching them. A handler may return
 * an AfterCommit callback for effects that must not happen if the transaction rolls back.
 */
export type EventHandler = (tx: Tx, event: ConsumedEvent) => Promise<AfterCommit | undefined>;

export type ConsumeOutcome = 'processed' | 'duplicate' | 'ignored';

export interface Consumer {
  readonly name: string;
  readonly topics: readonly string[];
  handle(event: ConsumedEvent): Promise<ConsumeOutcome>;
}

/** A payload that fails its registered schema. Transports send these to the dead-letter topic. */
export class PoisonEventError extends Error {
  constructor(
    readonly event: ConsumedEvent,
    detail: string,
  ) {
    super(`Event ${event.eventId} on ${event.topic} is invalid: ${detail}`);
    this.name = 'PoisonEventError';
  }
}

export interface ConsumerOptions {
  /** Stable consumer name; the de-duplication key is (name, event_id). */
  name: string;
  db: Database;
  handlers: Readonly<Record<string, EventHandler>>;
  logger?: Logger;
}

/**
 * At-least-once delivery, exactly-once effects (MASTER_ORCHESTRATION_PROMPT §4.4): the
 * processed_events marker and the handler's writes commit in ONE transaction, so a redelivered
 * event is skipped and a failed handler leaves no marker (the transport retries).
 */
export function createConsumer(options: ConsumerOptions): Consumer {
  const topics = Object.keys(options.handlers).sort();
  return {
    name: options.name,
    topics,
    async handle(event: ConsumedEvent): Promise<ConsumeOutcome> {
      const handler = options.handlers[event.topic];
      if (!handler) return 'ignored';
      const definition = getEventDefinition(event.topic);
      const parsed = definition?.schema.safeParse(event.payload);
      if (parsed && !parsed.success) {
        throw new PoisonEventError(event, parsed.error.issues.map((i) => i.message).join('; '));
      }
      const typed: ConsumedEvent = parsed ? { ...event, payload: parsed.data } : event;

      const { outcome, after } = await withSystemTx(options.db, async (tx) => {
        const marked = await tx.query(
          `INSERT INTO processed_events (consumer, event_id) VALUES ($1, $2)
           ON CONFLICT (consumer, event_id) DO NOTHING RETURNING event_id`,
          [options.name, event.eventId],
        );
        if (marked.rowCount === 0) return { outcome: 'duplicate' as const, after: undefined };
        return { outcome: 'processed' as const, after: (await handler(tx, typed)) ?? undefined };
      });
      // At-most-once for the side effect: a crash here loses it (e.g. an email), never repeats it.
      if (after) {
        try {
          await after();
        } catch (error) {
          options.logger?.error(
            { err: error, consumer: options.name, event_id: event.eventId },
            'after-commit effect failed',
          );
        }
      }
      options.logger?.info(
        { consumer: options.name, topic: event.topic, event_id: event.eventId, outcome },
        'event consumed',
      );
      return outcome;
    },
  };
}

/** A Kafka record as produced by the Debezium outbox EventRouter (infra/debezium). */
export interface OutboxRecord {
  topic: string;
  key: string | Buffer | null;
  value: string | Buffer | null;
  headers: Readonly<Record<string, string | Buffer | undefined>>;
}

function text(value: string | Buffer | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return typeof value === 'string' ? value : value.toString('utf8');
}

/**
 * Maps a Debezium outbox record to a ConsumedEvent. The router puts `payload` in the value,
 * `aggregate_id` in the key, and `event_id` / `tenant_id` in headers.
 */
export function parseOutboxRecord(record: OutboxRecord): ConsumedEvent {
  const eventId = text(record.headers['event_id']);
  const tenantId = text(record.headers['tenant_id']) ?? null;
  const aggregateId = text(record.key);
  const raw = text(record.value);
  const fail = (detail: string): never => {
    throw new PoisonEventError(
      {
        eventId: eventId ?? 'unknown',
        topic: record.topic,
        tenantId,
        aggregateId: '',
        payload: raw,
      },
      detail,
    );
  };
  if (!eventId || !isUuid(eventId)) return fail('missing or invalid event_id header');
  if (tenantId !== null && !isUuid(tenantId)) return fail('invalid tenant_id header');
  if (!aggregateId || !isUuid(aggregateId)) return fail('missing or invalid key');
  if (raw === undefined) return fail('empty value');
  let payload: unknown;
  try {
    // Debezium may JSON-encode the jsonb column as a string; unwrap once if so.
    payload = JSON.parse(raw);
    if (typeof payload === 'string') payload = JSON.parse(payload);
  } catch {
    return fail('value is not JSON');
  }
  return { eventId, topic: record.topic, tenantId, aggregateId, payload };
}
