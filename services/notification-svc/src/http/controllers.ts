import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { type Role } from '@atlas/contracts';
import {
  assertIdempotencyKey,
  CurrentPrincipal,
  DATABASE,
  type Database,
  isUuid,
  NotFoundError,
  parseInput,
  type Principal,
  Public,
  Roles,
  Scopes,
  ServiceUnavailableError,
} from '@atlas/platform';
import { inboxOwner, SEND_SCOPE } from '../application/access';
import { AdminService } from '../application/admin.service';
import { decodeCursor, InboxService } from '../application/inbox.service';
import { InternalService } from '../application/internal.service';
import {
  INBOX_HUB,
  type InboxHub,
  NOTIFICATION_SETTINGS,
  type NotificationSettings,
} from '../application/ports';
import { WebhooksService } from '../application/webhooks.service';
import {
  deliveriesQuery,
  domainBody,
  endpointBody,
  endpointPatchBody,
  inboxQuery,
  linkMessageBody,
  messageBody,
  preferenceBody,
  previewBody,
  recipientBody,
  reminderBody,
  remindersQuery,
  settingsBody,
  templateBody,
  templateUpdateBody,
  tenantQuery,
} from './dto';

/** Coarse gate; services apply the fine-grained rules (admin, own inbox, tenant). */
const ANYONE: Role[] = [
  'tenant_admin',
  'hiring_manager',
  'recruiter',
  'reviewer',
  'employee',
  'super_admin',
  'service',
];

interface StatusSink {
  status(code: number): unknown;
}

function id(raw: string, what: string): string {
  if (!isUuid(raw)) throw new NotFoundError(`${what}_NOT_FOUND`, 'Not found.');
  return raw.toLowerCase();
}
const tenant = (q: unknown) => parseInput(tenantQuery, q, 'query').tenant_id;

@Controller('v1')
export class InternalController {
  constructor(private readonly internal: InternalService) {}

  @Post('internal/link-messages')
  @Roles('service')
  @Scopes(SEND_SCOPE)
  async linkMessages(
    @CurrentPrincipal() p: Principal,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: StatusSink,
  ) {
    const idem = assertIdempotencyKey(key);
    const result = await this.internal.linkMessage(p, parseInput(linkMessageBody, body), idem);
    res.status(result.status);
    return result.body;
  }

  @Post('internal/messages')
  @Roles('service')
  @Scopes(SEND_SCOPE)
  async messages(
    @CurrentPrincipal() p: Principal,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: StatusSink,
  ) {
    const idem = assertIdempotencyKey(key);
    const result = await this.internal.message(p, parseInput(messageBody, body), idem);
    res.status(result.status);
    return result.body;
  }

  @Put('internal/recipients/:userId')
  @Roles('service')
  @Scopes(SEND_SCOPE)
  recipient(
    @CurrentPrincipal() p: Principal,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ) {
    if (!/^[A-Za-z0-9_.:@-]{1,200}$/.test(userId))
      throw new NotFoundError('USER_NOT_FOUND', 'Not found.');
    return this.internal.upsertRecipient(p, userId, parseInput(recipientBody, body));
  }
}

@Controller('v1')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('notification-types')
  @Roles(...ANYONE)
  types() {
    return { items: this.admin.types() };
  }

  @Get('notification-templates')
  @Roles(...ANYONE)
  async templates(@CurrentPrincipal() p: Principal, @Query() q: unknown) {
    return { items: await this.admin.listTemplates(p, tenant(q)) };
  }

  @Post('notification-templates')
  @Roles(...ANYONE)
  createTemplate(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    return this.admin.createTemplate(p, parseInput(templateBody, body));
  }

  @Post('notification-templates\\:preview')
  @Roles(...ANYONE)
  @HttpCode(200)
  preview(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    return this.admin.preview(p, parseInput(previewBody, body));
  }

  @Get('notification-templates/:id')
  @Roles(...ANYONE)
  template(@CurrentPrincipal() p: Principal, @Param('id') raw: string, @Query() q: unknown) {
    return this.admin.getTemplate(p, id(raw, 'TEMPLATE'), tenant(q));
  }

  @Put('notification-templates/:id')
  @Roles(...ANYONE)
  updateTemplate(
    @CurrentPrincipal() p: Principal,
    @Param('id') raw: string,
    @Query() q: unknown,
    @Body() body: unknown,
  ) {
    return this.admin.updateTemplate(
      p,
      id(raw, 'TEMPLATE'),
      parseInput(templateUpdateBody, body),
      tenant(q),
    );
  }

  @Delete('notification-templates/:id')
  @Roles(...ANYONE)
  @HttpCode(204)
  async deleteTemplate(
    @CurrentPrincipal() p: Principal,
    @Param('id') raw: string,
    @Query() q: unknown,
  ) {
    await this.admin.deleteTemplate(p, id(raw, 'TEMPLATE'), tenant(q));
  }

  @Get('notification-preferences')
  @Roles(...ANYONE)
  async preferences(@CurrentPrincipal() p: Principal, @Query() q: unknown) {
    return { items: await this.admin.preferences(p, tenant(q)) };
  }

  @Put('notification-preferences/:type')
  @Roles(...ANYONE)
  setPreference(
    @CurrentPrincipal() p: Principal,
    @Param('type') type: string,
    @Query() q: unknown,
    @Body() body: unknown,
  ) {
    return this.admin.setPreference(p, type, parseInput(preferenceBody, body), 'tenant', tenant(q));
  }

  @Put('me/notification-preferences/:type')
  @Roles(...ANYONE)
  setOwnPreference(
    @CurrentPrincipal() p: Principal,
    @Param('type') type: string,
    @Body() body: unknown,
  ) {
    inboxOwner(p);
    return this.admin.setPreference(p, type, parseInput(preferenceBody, body), 'self');
  }

  @Get('notification-settings')
  @Roles(...ANYONE)
  settings(@CurrentPrincipal() p: Principal, @Query() q: unknown) {
    return this.admin.getSettings(p, tenant(q));
  }

  @Put('notification-settings')
  @Roles(...ANYONE)
  putSettings(@CurrentPrincipal() p: Principal, @Query() q: unknown, @Body() body: unknown) {
    return this.admin.putSettings(p, parseInput(settingsBody, body), tenant(q));
  }

  @Get('sending-domains')
  @Roles(...ANYONE)
  async domains(@CurrentPrincipal() p: Principal, @Query() q: unknown) {
    return { items: await this.admin.listDomains(p, tenant(q)) };
  }

  @Post('sending-domains')
  @Roles(...ANYONE)
  addDomain(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    return this.admin.addDomain(p, parseInput(domainBody, body));
  }

  @Post('sending-domains/:id\\:verify')
  @Roles(...ANYONE)
  @HttpCode(200)
  verifyDomain(@CurrentPrincipal() p: Principal, @Param('id') raw: string, @Query() q: unknown) {
    return this.admin.verifyDomain(p, id(raw, 'DOMAIN'), tenant(q));
  }

  @Delete('sending-domains/:id')
  @Roles(...ANYONE)
  @HttpCode(204)
  async deleteDomain(
    @CurrentPrincipal() p: Principal,
    @Param('id') raw: string,
    @Query() q: unknown,
  ) {
    await this.admin.deleteDomain(p, id(raw, 'DOMAIN'), tenant(q));
  }

  @Post('reminders')
  @Roles(...ANYONE)
  schedule(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    return this.admin.scheduleReminder(p, parseInput(reminderBody, body));
  }

  @Get('reminders')
  @Roles(...ANYONE)
  async reminders(@CurrentPrincipal() p: Principal, @Query() q: unknown) {
    const x = parseInput(remindersQuery, q, 'query');
    return { items: await this.admin.reminders(p, x.status, x.tenant_id) };
  }

  @Post('reminders/:id\\:cancel')
  @Roles(...ANYONE)
  @HttpCode(200)
  cancel(@CurrentPrincipal() p: Principal, @Param('id') raw: string, @Query() q: unknown) {
    return this.admin.cancelReminder(p, id(raw, 'REMINDER'), tenant(q));
  }
}

@Controller('v1')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get('webhook-endpoints')
  @Roles(...ANYONE)
  async list(@CurrentPrincipal() p: Principal, @Query() q: unknown) {
    return { items: await this.webhooks.list(p, tenant(q)) };
  }

  @Post('webhook-endpoints')
  @Roles(...ANYONE)
  create(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    return this.webhooks.create(p, parseInput(endpointBody, body));
  }

  @Get('webhook-endpoints/:id')
  @Roles(...ANYONE)
  get(@CurrentPrincipal() p: Principal, @Param('id') raw: string, @Query() q: unknown) {
    return this.webhooks.get(p, id(raw, 'WEBHOOK_ENDPOINT'), tenant(q));
  }

  @Patch('webhook-endpoints/:id')
  @Roles(...ANYONE)
  update(
    @CurrentPrincipal() p: Principal,
    @Param('id') raw: string,
    @Query() q: unknown,
    @Body() body: unknown,
  ) {
    return this.webhooks.update(
      p,
      id(raw, 'WEBHOOK_ENDPOINT'),
      parseInput(endpointPatchBody, body),
      tenant(q),
    );
  }

  @Delete('webhook-endpoints/:id')
  @Roles(...ANYONE)
  @HttpCode(204)
  async remove(@CurrentPrincipal() p: Principal, @Param('id') raw: string, @Query() q: unknown) {
    await this.webhooks.remove(p, id(raw, 'WEBHOOK_ENDPOINT'), tenant(q));
  }

  @Post('webhook-endpoints/:id\\:test')
  @Roles(...ANYONE)
  @HttpCode(200)
  test(@CurrentPrincipal() p: Principal, @Param('id') raw: string, @Query() q: unknown) {
    return this.webhooks.test(p, id(raw, 'WEBHOOK_ENDPOINT'), tenant(q));
  }

  @Post('webhook-endpoints/:id\\:enable')
  @Roles(...ANYONE)
  @HttpCode(200)
  enable(@CurrentPrincipal() p: Principal, @Param('id') raw: string, @Query() q: unknown) {
    return this.webhooks.enable(p, id(raw, 'WEBHOOK_ENDPOINT'), tenant(q));
  }

  @Get('webhook-endpoints/:id/deliveries')
  @Roles(...ANYONE)
  async deliveries(
    @CurrentPrincipal() p: Principal,
    @Param('id') raw: string,
    @Query() q: unknown,
  ) {
    const x = parseInput(deliveriesQuery, q, 'query');
    return {
      items: await this.webhooks.deliveries(p, id(raw, 'WEBHOOK_ENDPOINT'), x.status, x.tenant_id),
    };
  }

  @Post('webhook-deliveries/:id\\:redeliver')
  @Roles(...ANYONE)
  @HttpCode(200)
  redeliver(@CurrentPrincipal() p: Principal, @Param('id') raw: string, @Query() q: unknown) {
    return this.webhooks.redeliver(p, id(raw, 'WEBHOOK_DELIVERY'), tenant(q));
  }
}

interface StreamRequest {
  headers: Record<string, string | string[] | undefined>;
  on(event: 'close', listener: () => void): void;
}
interface StreamResponse {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: string): boolean;
  end(): void;
}

@Controller('v1')
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    @Inject(INBOX_HUB) private readonly hub: InboxHub,
    @Inject(NOTIFICATION_SETTINGS) private readonly settings: NotificationSettings,
  ) {}

  @Get('me/notifications')
  @Roles(...ANYONE)
  list(@CurrentPrincipal() p: Principal, @Query() q: unknown) {
    return this.inbox.list(p, parseInput(inboxQuery, q, 'query'));
  }

  @Post('me/notifications/:id\\:markRead')
  @Roles(...ANYONE)
  @HttpCode(200)
  markRead(@CurrentPrincipal() p: Principal, @Param('id') raw: string) {
    return this.inbox.markRead(p, id(raw, 'NOTIFICATION'));
  }

  @Post('me/notifications\\:markAllRead')
  @Roles(...ANYONE)
  @HttpCode(200)
  markAllRead(@CurrentPrincipal() p: Principal) {
    return this.inbox.markAllRead(p);
  }

  /**
   * Server-sent events: `notification` events for new items (id = cursor, so a reconnect with
   * Last-Event-ID resumes), `unread` counts, and a comment heartbeat every 15 s.
   */
  @Get('me/notifications\\:stream')
  @Roles(...ANYONE)
  async stream(
    @CurrentPrincipal() p: Principal,
    @Req() req: StreamRequest,
    @Res() res: StreamResponse,
  ): Promise<void> {
    const { tenantId, userId } = inboxOwner(p);
    const last = req.headers['last-event-id'];
    let cursor = decodeCursor(Array.isArray(last) ? last[0] : last);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let closed = false;
    let running = Promise.resolve();
    const push = () => {
      running = running
        .then(async () => {
          if (closed) return;
          const { items, unread } = await this.inbox.since(p, cursor);
          for (const i of items) {
            const { cursor: c, ...data } = i;
            res.write(`id: ${c}\nevent: notification\ndata: ${JSON.stringify(data)}\n\n`);
            cursor = decodeCursor(c);
          }
          res.write(`event: unread\ndata: ${JSON.stringify({ unread })}\n\n`);
        })
        .catch(() => undefined);
    };
    const unsubscribe = this.hub.subscribe(tenantId, userId, push);
    const poll = setInterval(push, this.settings.ssePollMs);
    const beat = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      closed = true;
      unsubscribe();
      clearInterval(poll);
      clearInterval(beat);
      res.end();
    });
    push();
  }
}

@Controller()
export class HealthController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get('healthz')
  @Public()
  healthz(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  @Public()
  async readyz(): Promise<{ status: 'ready' }> {
    try {
      await this.db.ping();
    } catch {
      throw new ServiceUnavailableError('NOT_READY', 'The database is not reachable.');
    }
    return { status: 'ready' };
  }
}
