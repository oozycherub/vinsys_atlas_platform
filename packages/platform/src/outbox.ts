import { type EventMessage } from '@atlas/contracts';
import { type Tx } from './db/database';
import { newId } from './ids';
import { currentRequestContext } from './logging';

/**
 * Writes an event in the caller's transaction (transactional outbox, §4.4). The event becomes
 * visible to Debezium only if the business change commits. Returns the event id.
 */
export async function appendOutbox<TPayload>(
  tx: Tx,
  event: EventMessage<TPayload>,
): Promise<string> {
  const eventId = newId();
  const ctx = currentRequestContext();
  const headers = {
    event_id: eventId,
    ...(ctx ? { request_id: ctx.requestId } : {}),
    ...(event.tenantId ? { tenant_id: event.tenantId } : {}),
  };
  await tx.query(
    `INSERT INTO outbox_events (event_id, tenant_id, aggregate_type, aggregate_id, topic, payload, headers)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
    [
      eventId,
      event.tenantId,
      event.aggregateType,
      event.aggregateId,
      event.topic,
      JSON.stringify(event.payload),
      JSON.stringify(headers),
    ],
  );
  return eventId;
}
