import type { z } from 'zod';

/** Topic naming rule from PRD §1.2.5: `<domain>.<entity>.<past-tense-verb>.v<N>`. */
export const TOPIC_PATTERN = /^[a-z]+\.[a-z_]+\.[a-z_]+\.v[0-9]+$/;

/** What a service hands to the outbox. `tenantId` is null only for platform-wide events. */
export interface EventMessage<TPayload> {
  readonly topic: string;
  readonly tenantId: string | null;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: TPayload;
}

export interface EventDefinition<TSchema extends z.ZodTypeAny> {
  readonly topic: string;
  readonly aggregateType: string;
  readonly schema: TSchema;
  /** Validates the payload against the registered schema and builds the message. */
  build(input: {
    tenantId: string | null;
    aggregateId: string;
    payload: z.input<TSchema>;
  }): EventMessage<z.output<TSchema>>;
}

const registry = new Map<string, EventDefinition<z.ZodTypeAny>>();

export function defineEvent<TSchema extends z.ZodTypeAny>(
  topic: string,
  aggregateType: string,
  schema: TSchema,
): EventDefinition<TSchema> {
  if (!TOPIC_PATTERN.test(topic)) {
    throw new Error(`Invalid topic name "${topic}"; expected <domain>.<entity>.<verb>.v<N>`);
  }
  if (registry.has(topic)) {
    throw new Error(`Event topic "${topic}" is defined twice`);
  }
  const definition: EventDefinition<TSchema> = {
    topic,
    aggregateType,
    schema,
    build({ tenantId, aggregateId, payload }) {
      return { topic, tenantId, aggregateType, aggregateId, payload: schema.parse(payload) };
    },
  };
  registry.set(topic, definition);
  return definition;
}

/** Looks up a schema by topic, e.g. for consumers validating incoming messages. */
export function getEventDefinition(topic: string): EventDefinition<z.ZodTypeAny> | undefined {
  return registry.get(topic);
}

export function listEventTopics(): string[] {
  return [...registry.keys()].sort();
}
