import { Inject, Injectable, Optional } from '@nestjs/common';
import { type Logger } from 'pino';
import { NotificationDeliveryFailed } from '@atlas/contracts';
import {
  type AfterCommit,
  appendOutbox,
  CLOCK,
  type Clock,
  DATABASE,
  type Database,
  NotFoundError,
  newId,
  openSecret,
  type Principal,
  randomToken,
  sealSecret,
  type Tx,
  ValidationError,
  withSystemTx,
  withTenantTx,
} from '@atlas/platform';
import {
  checkEndpointUrl,
  DISABLE_AFTER_FAILURES,
  MAX_DELIVERY_ATTEMPTS,
  retryDelayMs,
  SIGNATURE_HEADER,
  signPayload,
  WEBHOOK_EVENT_TYPES,
  type WebhookEventType,
} from '../domain/webhooks';
import {
  type Claimed,
  type DeliveryRow,
  type EndpointRow,
  type NotificationStore,
  NOTIFICATION_STORE,
} from './store';
import { ADMINS, requireRole, tenantOf } from './access';
import { chainAfter, Dispatcher } from './dispatcher';
import {
  NOTIFICATION_LOGGER,
  NOTIFICATION_SETTINGS,
  type NotificationSettings,
  WEBHOOK_TRANSPORT,
  WebhookTransportError,
  type WebhookTransport,
} from './ports';

export interface EndpointView {
  endpoint_id: string;
  url: string;
  description: string | null;
  event_types: string[];
  enabled: boolean;
  consecutive_failures: number;
  disabled_at: string | null;
  disabled_reason: string | null;
  created_at: string;
}

export interface DeliveryView {
  delivery_id: string;
  endpoint_id: string;
  event_type: string;
  event_id: string;
  status: string;
  attempts: number;
  next_attempt_at: string | null;
  last_status: number | null;
  last_error: string | null;
  delivered_at: string | null;
  created_at: string;
}

const viewEndpoint = (e: EndpointRow): EndpointView => ({
  endpoint_id: e.endpointId,
  url: e.url,
  description: e.description,
  event_types: e.eventTypes,
  enabled: e.enabled,
  consecutive_failures: e.consecutiveFailures,
  disabled_at: e.disabledAt?.toISOString() ?? null,
  disabled_reason: e.disabledReason,
  created_at: e.createdAt.toISOString(),
});

const viewDelivery = (d: DeliveryRow): DeliveryView => ({
  delivery_id: d.deliveryId,
  endpoint_id: d.endpointId,
  event_type: d.eventType,
  event_id: d.eventId,
  status: d.status,
  attempts: d.attempts,
  next_attempt_at: d.status === 'pending' ? d.availableAt.toISOString() : null,
  last_status: d.lastStatus,
  last_error: d.lastError,
  delivered_at: d.deliveredAt?.toISOString() ?? null,
  created_at: d.createdAt.toISOString(),
});

function badUrl(url: string): void {
  const problem = checkEndpointUrl(url);
  if (problem)
    throw new ValidationError(`Invalid webhook URL: ${problem}.`, [
      { path: 'url', message: problem },
    ]);
}

/** Webhook endpoints, fan-out from events, signed delivery with retries and a DLQ (ADR-0010 §5). */
@Injectable()
export class WebhooksService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WEBHOOK_TRANSPORT) private readonly transport: WebhookTransport,
    @Inject(NOTIFICATION_SETTINGS) private readonly settings: NotificationSettings,
    @Inject(NOTIFICATION_STORE) private readonly store: NotificationStore,
    private readonly dispatcher: Dispatcher,
    @Optional() @Inject(NOTIFICATION_LOGGER) private readonly logger: Logger | null,
  ) {}

  private aad(tenantId: string, endpointId: string): string {
    return `webhook:${tenantId}:${endpointId}`;
  }

  private secretOf(tenantId: string, e: EndpointRow): string {
    return openSecret(
      this.settings.secretKek,
      e.secretSealed,
      this.aad(tenantId, e.endpointId),
    ).toString('utf8');
  }

  // --- Endpoints ----------------------------------------------------------------------------

  async create(
    p: Principal,
    input: {
      tenant_id?: string | undefined;
      url: string;
      description?: string | null | undefined;
      event_types: WebhookEventType[];
    },
  ): Promise<EndpointView & { secret: string }> {
    requireRole(p, ADMINS);
    const tenantId = tenantOf(p, input.tenant_id);
    badUrl(input.url);
    const endpointId = newId();
    const secret = `whsec_${randomToken(24)}`;
    const now = this.clock.now();
    return withTenantTx(this.db, tenantId, async (tx) => {
      await this.store.insertEndpoint(
        tx,
        tenantId,
        {
          endpointId,
          url: input.url,
          description: input.description ?? null,
          eventTypes: [...new Set(input.event_types)],
          secretSealed: sealSecret(
            this.settings.secretKek,
            Buffer.from(secret),
            this.aad(tenantId, endpointId),
          ),
          createdAt: now,
        },
        p.subject,
      );
      const e = await this.store.endpoint(tx, endpointId);
      // The secret is shown once; afterwards only its holder can verify signatures.
      return { ...viewEndpoint(e as EndpointRow), secret };
    });
  }

  async list(p: Principal, tenant?: string): Promise<EndpointView[]> {
    requireRole(p, ADMINS);
    const tenantId = tenantOf(p, tenant);
    return withTenantTx(this.db, tenantId, async (tx) =>
      (await this.store.endpoints(tx)).map(viewEndpoint),
    );
  }

  private async load(tx: Tx, id: string, lock = false): Promise<EndpointRow> {
    const e = await this.store.endpoint(tx, id, lock);
    if (!e) throw new NotFoundError('WEBHOOK_ENDPOINT_NOT_FOUND', 'Webhook endpoint not found.');
    return e;
  }

  async get(p: Principal, id: string, tenant?: string): Promise<EndpointView> {
    requireRole(p, ADMINS);
    return withTenantTx(this.db, tenantOf(p, tenant), async (tx) =>
      viewEndpoint(await this.load(tx, id)),
    );
  }

  async update(
    p: Principal,
    id: string,
    patch: {
      url?: string | undefined;
      description?: string | null | undefined;
      event_types?: WebhookEventType[] | undefined;
    },
    tenant?: string,
  ): Promise<EndpointView> {
    requireRole(p, ADMINS);
    if (patch.url !== undefined) badUrl(patch.url);
    return withTenantTx(this.db, tenantOf(p, tenant), async (tx) => {
      await this.load(tx, id);
      const updated = await this.store.updateEndpoint(tx, id, {
        ...(patch.url !== undefined ? { url: patch.url } : {}),
        ...('description' in patch ? { description: patch.description ?? null } : {}),
        ...(patch.event_types ? { eventTypes: [...new Set(patch.event_types)] } : {}),
      });
      return viewEndpoint(updated as EndpointRow);
    });
  }

  async remove(p: Principal, id: string, tenant?: string): Promise<void> {
    requireRole(p, ADMINS);
    await withTenantTx(this.db, tenantOf(p, tenant), async (tx) => {
      if (!(await this.store.deleteEndpoint(tx, id)))
        throw new NotFoundError('WEBHOOK_ENDPOINT_NOT_FOUND', 'Webhook endpoint not found.');
    });
  }

  /** Re-enables a disabled endpoint; its pending deliveries resume. */
  async enable(p: Principal, id: string, tenant?: string): Promise<EndpointView> {
    requireRole(p, ADMINS);
    return withTenantTx(this.db, tenantOf(p, tenant), async (tx) => {
      await this.load(tx, id);
      await this.store.setEndpointEnabled(tx, id, true, this.clock.now(), null);
      return viewEndpoint(await this.load(tx, id));
    });
  }

  async deliveries(
    p: Principal,
    id: string,
    status: string | undefined,
    tenant?: string,
  ): Promise<DeliveryView[]> {
    requireRole(p, ADMINS);
    return withTenantTx(this.db, tenantOf(p, tenant), async (tx) => {
      await this.load(tx, id);
      return (await this.store.deliveries(tx, id, status ?? null, 100)).map(viewDelivery);
    });
  }

  /** Moves a dead delivery (the DLQ) back to the queue. */
  async redeliver(p: Principal, deliveryId: string, tenant?: string): Promise<DeliveryView> {
    requireRole(p, ADMINS);
    return withTenantTx(this.db, tenantOf(p, tenant), async (tx) => {
      const d = await this.store.delivery(tx, deliveryId);
      if (!d) throw new NotFoundError('WEBHOOK_DELIVERY_NOT_FOUND', 'Delivery not found.');
      if (!(await this.store.redeliver(tx, deliveryId, this.clock.now())))
        throw new ValidationError('Only dead deliveries can be redelivered.', [
          { path: 'status', message: `is ${d.status}` },
        ]);
      return viewDelivery((await this.store.delivery(tx, deliveryId)) as DeliveryRow);
    });
  }

  /** `:test`: sends a signed `ping` now and reports the response. Not stored, not counted. */
  async test(
    p: Principal,
    id: string,
    tenant?: string,
  ): Promise<{ ok: boolean; status: number | null; error: string | null }> {
    requireRole(p, ADMINS);
    const tenantId = tenantOf(p, tenant);
    const e = await withTenantTx(this.db, tenantId, (tx) => this.load(tx, id));
    const body = JSON.stringify({
      id: newId(),
      type: 'ping',
      created_at: this.clock.now().toISOString(),
      tenant_id: tenantId,
      data: { endpoint_id: e.endpointId },
    });
    try {
      const res = await this.transport.post(
        e.url,
        body,
        this.headers(this.secretOf(tenantId, e), body, newId()),
      );
      return { ok: res.status >= 200 && res.status < 300, status: res.status, error: null };
    } catch (error) {
      return {
        ok: false,
        status: null,
        error: error instanceof WebhookTransportError ? error.reason : 'request failed',
      };
    }
  }

  private headers(secret: string, body: string, deliveryId: string): Record<string, string> {
    const t = Math.floor(this.clock.now().getTime() / 1000);
    return {
      'Content-Type': 'application/json',
      'User-Agent': 'Atlas-Webhooks/1',
      [SIGNATURE_HEADER]: signPayload(secret, t, body),
      'Atlas-Delivery-Id': deliveryId,
    };
  }

  // --- Fan-out and delivery -----------------------------------------------------------------

  /** Queues one delivery per subscribed, enabled endpoint (idempotent per endpoint and event). */
  async fanOut(
    tx: Tx,
    tenantId: string,
    type: WebhookEventType,
    eventId: string,
    data: unknown,
  ): Promise<number> {
    let queued = 0;
    const now = this.clock.now();
    for (const e of await this.store.subscribedEndpoints(tx, type)) {
      const payload = {
        id: eventId,
        type,
        created_at: now.toISOString(),
        tenant_id: tenantId,
        data,
      };
      if (
        await this.store.insertDelivery(
          tx,
          tenantId,
          {
            deliveryId: newId(),
            endpointId: e.endpointId,
            eventType: type,
            eventId,
            payload: payload as Record<string, unknown>,
          },
          now,
        )
      )
        queued += 1;
    }
    return queued;
  }

  async runOnce(): Promise<number> {
    const now = this.clock.now();
    const claimed = await withSystemTx(this.db, (tx) =>
      this.store.claimDeliveries(
        tx,
        now,
        new Date(now.getTime() + this.settings.leaseMs),
        this.settings.batchSize,
      ),
    );
    for (const c of claimed) await this.deliver(c);
    return claimed.length;
  }

  private async deliver(c: Claimed): Promise<void> {
    const loaded = await withTenantTx(this.db, c.tenantId, async (tx) => {
      const d = await this.store.delivery(tx, c.id);
      const e = d ? await this.store.endpoint(tx, d.endpointId) : null;
      return d && e && d.status === 'pending' && e.enabled ? { d, e } : null;
    });
    if (!loaded) return;
    const { d, e } = loaded;
    const body = JSON.stringify(d.payload);
    let status: number | null = null;
    let error: string | null = null;
    try {
      status = (
        await this.transport.post(
          e.url,
          body,
          this.headers(this.secretOf(c.tenantId, e), body, d.deliveryId),
        )
      ).status;
      if (status < 200 || status >= 300) error = `HTTP ${status}`;
    } catch (err) {
      error = err instanceof WebhookTransportError ? err.reason : 'request failed';
    }
    const after = await withTenantTx(this.db, c.tenantId, (tx) =>
      this.record(tx, c, d, e, status, error),
    );
    await after?.();
  }

  private async record(
    tx: Tx,
    c: Claimed,
    d: DeliveryRow,
    e: EndpointRow,
    status: number | null,
    error: string | null,
  ): Promise<AfterCommit | undefined> {
    const now = this.clock.now();
    if (error === null) {
      await this.store.finishDelivery(tx, d.deliveryId, {
        status: 'delivered',
        httpStatus: status as number,
        at: now,
      });
      await this.store.recordEndpointOutcome(tx, e.endpointId, true);
      return undefined;
    }
    const callbacks: (AfterCommit | undefined)[] = [];
    if (c.attempts >= MAX_DELIVERY_ATTEMPTS) {
      await this.store.finishDelivery(tx, d.deliveryId, {
        status: 'dead',
        httpStatus: status,
        error,
      });
      await this.failedEvent(
        tx,
        c.tenantId,
        d.deliveryId,
        e.endpointId,
        'retries_exhausted',
        c.attempts,
        d.eventType,
      );
    } else {
      await this.store.finishDelivery(tx, d.deliveryId, {
        status: 'pending',
        httpStatus: status,
        error,
        until: new Date(now.getTime() + retryDelayMs(c.attempts)),
      });
    }
    const failures = await this.store.recordEndpointOutcome(tx, e.endpointId, false);
    if (failures >= DISABLE_AFTER_FAILURES) {
      const current = await this.store.endpoint(tx, e.endpointId, true);
      if (current?.enabled) {
        await this.store.setEndpointEnabled(
          tx,
          e.endpointId,
          false,
          now,
          `${failures} consecutive failed attempts`,
        );
        await this.failedEvent(
          tx,
          c.tenantId,
          d.deliveryId,
          e.endpointId,
          'endpoint_disabled',
          c.attempts,
          d.eventType,
        );
        for (const admin of await this.store.recipientsWith(tx, ['tenant_admin'], [])) {
          const out = await this.dispatcher.dispatch(tx, {
            tenantId: c.tenantId,
            type: 'webhook_disabled',
            to: { userId: admin.userId },
            values: {
              Endpoint_Url: e.url,
              Failures: String(failures),
              Link_Path: `/admin/webhooks/${e.endpointId}`,
            },
            dedupeKey: `webhook_disabled:${e.endpointId}:${now.toISOString()}:${admin.userId}`,
          });
          callbacks.push(out.after);
        }
        this.logger?.warn(
          { tenant_id: c.tenantId, endpoint_id: e.endpointId, failures },
          'webhook endpoint disabled',
        );
      }
    }
    return chainAfter(callbacks);
  }

  private async failedEvent(
    tx: Tx,
    tenantId: string,
    deliveryId: string,
    endpointId: string,
    reason: 'retries_exhausted' | 'endpoint_disabled',
    attempts: number,
    type: string,
  ): Promise<void> {
    await appendOutbox(
      tx,
      NotificationDeliveryFailed.build({
        tenantId,
        aggregateId: deliveryId,
        payload: {
          tenant_id: tenantId,
          notification_id: deliveryId,
          channel: 'webhook',
          type,
          recipient_user_id: null,
          endpoint_id: endpointId,
          reason,
          attempts: Math.max(1, attempts),
          occurred_at: this.clock.now().toISOString(),
        },
      }),
    );
  }
}

export { WEBHOOK_EVENT_TYPES };
