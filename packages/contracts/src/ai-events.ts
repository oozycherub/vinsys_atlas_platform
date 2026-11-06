import { z } from 'zod';
import { defineEvent } from './event';

/** llm-gateway events (docs/prompts/05-llm-gateway.md §5). Metrics only: no prompt or output text. */
const uuid = z.string().uuid();
const isoTime = z.string().datetime({ offset: true });

export const AiBudgetThresholdCrossed = defineEvent(
  'ai.budget.threshold_crossed.v1',
  'ai_budget',
  z.object({
    tenant_id: uuid,
    period: z.string().regex(/^\d{4}-\d{2}$/),
    level: z.enum(['soft', 'hard']),
    resource: z.enum(['tokens', 'gpu_seconds']),
    used: z.number().min(0),
    limit: z.number().min(0),
    occurred_at: isoTime,
  }),
);

export const AiCallCompleted = defineEvent(
  'ai.call.completed.v1',
  'ai_call',
  z.object({
    tenant_id: uuid,
    call_id: uuid,
    kind: z.enum(['messages', 'stream', 'embeddings']),
    purpose: z.string(),
    prompt_id: z.string().nullable(),
    prompt_version: z.number().int().nullable(),
    model: z.string().nullable(),
    status: z.string(),
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
    latency_ms: z.number().int().min(0),
    failover: z.boolean(),
    cache_hit: z.boolean(),
    occurred_at: isoTime,
  }),
);
