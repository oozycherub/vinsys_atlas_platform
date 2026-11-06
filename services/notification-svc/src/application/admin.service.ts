import { Inject, Injectable } from '@nestjs/common';
import {
  CLOCK,
  type Clock,
  ConflictError,
  DATABASE,
  type Database,
  DomainRuleError,
  NotFoundError,
  newId,
  type Principal,
  randomToken,
  ValidationError,
  withTenantTx,
} from '@atlas/platform';
import { defaultTemplate } from '../domain/default-templates';
import { isValidTimeZone } from '../domain/scheduling';
import {
  isHttpsUrl,
  renderEmail,
  renderText,
  sampleValues,
  TemplateError,
  validateTemplate,
} from '../domain/templates';
import {
  allowedPlaceholders,
  type Channel,
  isNotificationType,
  NOTIFICATION_TYPES,
  type NotificationType,
  specOf,
  TYPE_NAMES,
} from '../domain/types';
import {
  type DomainRow,
  type NotificationStore,
  NOTIFICATION_STORE,
  type ReminderRow,
  type TemplateRow,
  type TenantSettings,
} from './store';
import { ADMINS, requireRole, tenantOf } from './access';
import {
  DNS_RESOLVER,
  type DnsResolver,
  NOTIFICATION_SETTINGS,
  type NotificationSettings,
} from './ports';

function typeOf(raw: string): NotificationType {
  if (!isNotificationType(raw))
    throw new ValidationError('Unknown notification type.', [{ path: 'type', message: raw }]);
  return raw;
}

async function checked<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof TemplateError)
      throw new ValidationError(
        'The template is not valid.',
        error.issues.map((i) => ({ path: i.path, message: i.message })),
      );
    throw error;
  }
}

const viewTemplate = (t: TemplateRow) => ({
  template_id: t.templateId,
  type: t.type,
  channel: t.channel,
  locale: t.locale,
  subject: t.subject,
  source: t.source,
  version: t.version,
  updated_by: t.updatedBy,
  updated_at: t.updatedAt,
});

/** The admin portal's notification settings (Component Prompt 13 §2, §4). */
@Injectable()
export class AdminService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(DNS_RESOLVER) private readonly dns: DnsResolver,
    @Inject(NOTIFICATION_SETTINGS) private readonly settings: NotificationSettings,
    @Inject(NOTIFICATION_STORE) private readonly store: NotificationStore,
  ) {}

  types() {
    return TYPE_NAMES.map((type) => ({
      type,
      placeholders: allowedPlaceholders(type),
      transactional: NOTIFICATION_TYPES[type].transactional,
      channels: [...NOTIFICATION_TYPES[type].channels],
    }));
  }

  // --- Templates ----------------------------------------------------------------------------

  async listTemplates(p: Principal, tenant?: string) {
    requireRole(p, ADMINS);
    return withTenantTx(this.db, tenantOf(p, tenant), async (tx) =>
      (await this.store.templates(tx)).map(viewTemplate),
    );
  }

  async getTemplate(p: Principal, id: string, tenant?: string) {
    requireRole(p, ADMINS);
    return withTenantTx(this.db, tenantOf(p, tenant), async (tx) => {
      const t = await this.store.template(tx, id);
      if (!t) throw new NotFoundError('TEMPLATE_NOT_FOUND', 'Template not found.');
      return viewTemplate(t);
    });
  }

  async createTemplate(
    p: Principal,
    input: {
      tenant_id?: string | undefined;
      type: string;
      channel: Channel;
      locale: string;
      subject: string;
      source: string;
    },
  ) {
    requireRole(p, ADMINS);
    const tenantId = tenantOf(p, input.tenant_id);
    const type = typeOf(input.type);
    if (!specOf(type).channels.includes(input.channel))
      throw new ValidationError('This type is not sent on that channel.', [
        { path: 'channel', message: input.channel },
      ]);
    await checked(() => validateTemplate(type, input.channel, input.subject, input.source));
    const row: TemplateRow = {
      templateId: newId(),
      type,
      channel: input.channel,
      locale: input.locale,
      subject: input.subject,
      source: input.source,
      version: 1,
      updatedBy: p.subject,
      updatedAt: this.clock.now().toISOString(),
    };
    return withTenantTx(this.db, tenantId, async (tx) => {
      if (!(await this.store.insertTemplate(tx, tenantId, row)))
        throw new ConflictError(
          'TEMPLATE_EXISTS',
          'A template for this type, channel and locale exists; update it.',
        );
      return viewTemplate(row);
    });
  }

  async updateTemplate(
    p: Principal,
    id: string,
    input: { subject: string; source: string },
    tenant?: string,
  ) {
    requireRole(p, ADMINS);
    return withTenantTx(this.db, tenantOf(p, tenant), async (tx) => {
      const t = await this.store.template(tx, id);
      if (!t) throw new NotFoundError('TEMPLATE_NOT_FOUND', 'Template not found.');
      await checked(() => validateTemplate(typeOf(t.type), t.channel, input.subject, input.source));
      return viewTemplate(
        (await this.store.updateTemplate(
          tx,
          id,
          input.subject,
          input.source,
          p.subject,
          this.clock.now(),
        )) as TemplateRow,
      );
    });
  }

  async deleteTemplate(p: Principal, id: string, tenant?: string): Promise<void> {
    requireRole(p, ADMINS);
    await withTenantTx(this.db, tenantOf(p, tenant), async (tx) => {
      if (!(await this.store.deleteTemplate(tx, id)))
        throw new NotFoundError('TEMPLATE_NOT_FOUND', 'Template not found.');
    });
  }

  /** Validates and renders with sample (or given) values; nothing is stored or sent. */
  async preview(
    p: Principal,
    input: {
      type: string;
      channel: Channel;
      subject?: string | undefined;
      source?: string | undefined;
      values?: Record<string, string> | undefined;
    },
  ) {
    requireRole(p, ADMINS);
    const type = typeOf(input.type);
    const fallback = defaultTemplate(type, input.channel);
    const subject = input.subject ?? fallback?.subject ?? '';
    const source = input.source ?? fallback?.source ?? '';
    await checked(() => validateTemplate(type, input.channel, subject, source));
    const values = { ...sampleValues(type), ...(input.values ?? {}) };
    if (values['URL'] !== undefined && !isHttpsUrl(values['URL']))
      throw new ValidationError('URL must be https.', [
        { path: 'values.URL', message: 'must be https' },
      ]);
    if (input.channel === 'in_app')
      return { subject: renderText(subject, values), text: renderText(source, values), html: null };
    const r = await renderEmail(subject, source, values);
    return { subject: r.subject, text: r.text, html: r.html };
  }

  // --- Preferences and settings -------------------------------------------------------------

  async preferences(p: Principal, tenant?: string) {
    requireRole(p, ADMINS);
    return withTenantTx(this.db, tenantOf(p, tenant), async (tx) => {
      const rows = (await this.store.preferences(tx, null, null)).filter((r) => r.userId === '*');
      return TYPE_NAMES.map((type) => {
        const row = rows.find((r) => r.type === type);
        const transactional = NOTIFICATION_TYPES[type].transactional;
        return {
          type,
          transactional,
          enabled: transactional || (row?.enabled ?? true),
          email: transactional || (row?.email ?? true),
          in_app: transactional || (row?.inApp ?? true),
        };
      });
    });
  }

  async setPreference(
    p: Principal,
    rawType: string,
    input: { enabled: boolean; email: boolean; in_app: boolean },
    userScope: 'tenant' | 'self',
    tenant?: string,
  ) {
    const type = typeOf(rawType);
    if (userScope === 'tenant') requireRole(p, ADMINS);
    if (NOTIFICATION_TYPES[type].transactional)
      throw new DomainRuleError(
        'TRANSACTIONAL_TYPE',
        'Transactional notifications cannot be turned off.',
      );
    const tenantId = tenantOf(p, tenant);
    const userId = userScope === 'tenant' ? '*' : p.subject;
    await withTenantTx(this.db, tenantId, (tx) =>
      this.store.savePreference(
        tx,
        tenantId,
        { type, userId, enabled: input.enabled, email: input.email, inApp: input.in_app },
        this.clock.now(),
      ),
    );
    return {
      type,
      scope: userScope,
      enabled: input.enabled,
      email: input.email,
      in_app: input.in_app,
    };
  }

  async getSettings(p: Principal, tenant?: string) {
    requireRole(p, ADMINS);
    return withTenantTx(this.db, tenantOf(p, tenant), async (tx) =>
      viewSettings(await this.store.settings(tx)),
    );
  }

  async putSettings(
    p: Principal,
    input: {
      quiet_hours: { start: string; end: string } | null;
      time_zone: string;
      max_per_day: number;
      from_name: string | null;
    },
    tenant?: string,
  ) {
    requireRole(p, ADMINS);
    const tenantId = tenantOf(p, tenant);
    if (!isValidTimeZone(input.time_zone))
      throw new ValidationError('Unknown time zone.', [
        { path: 'time_zone', message: input.time_zone },
      ]);
    const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
    const s: TenantSettings = {
      quietStartMin: input.quiet_hours ? minutes(input.quiet_hours.start) : null,
      quietEndMin: input.quiet_hours ? minutes(input.quiet_hours.end) : null,
      timeZone: input.time_zone,
      maxPerDay: input.max_per_day,
      fromName: input.from_name,
    };
    await withTenantTx(this.db, tenantId, (tx) =>
      this.store.saveSettings(tx, tenantId, s, this.clock.now()),
    );
    return viewSettings(s);
  }

  // --- Sending domains ----------------------------------------------------------------------

  private viewDomain(d: DomainRow) {
    return {
      domain_id: d.domainId,
      domain: d.domain,
      status: d.status,
      spf_verified: d.spfVerified,
      dkim_verified: d.dkimVerified,
      checked_at: d.checkedAt?.toISOString() ?? null,
      dns_records: [
        {
          type: 'TXT',
          name: `_atlas-verify.${d.domain}`,
          value: `atlas-verification=${d.verificationToken}`,
        },
        { type: 'TXT', name: d.domain, value: `v=spf1 include:${this.settings.spfInclude} ~all` },
        {
          type: 'CNAME',
          name: `${d.dkimSelector}._domainkey.${d.domain}`,
          value: `${d.dkimSelector}.${this.settings.dkimTarget}`,
        },
      ],
    };
  }

  async addDomain(p: Principal, input: { tenant_id?: string | undefined; domain: string }) {
    requireRole(p, ADMINS);
    const tenantId = tenantOf(p, input.tenant_id);
    const row: DomainRow = {
      domainId: newId(),
      domain: input.domain.toLowerCase(),
      verificationToken: randomToken(18),
      dkimSelector: `atlas${randomToken(4)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')}`,
      spfVerified: false,
      dkimVerified: false,
      status: 'pending',
      checkedAt: null,
      createdAt: this.clock.now(),
    };
    return withTenantTx(this.db, tenantId, async (tx) => {
      if (!(await this.store.insertDomain(tx, tenantId, row)))
        throw new ConflictError('DOMAIN_EXISTS', 'This domain is already registered.');
      return this.viewDomain(row);
    });
  }

  async listDomains(p: Principal, tenant?: string) {
    requireRole(p, ADMINS);
    return withTenantTx(this.db, tenantOf(p, tenant), async (tx) =>
      (await this.store.domains(tx)).map((d) => this.viewDomain(d)),
    );
  }

  async deleteDomain(p: Principal, id: string, tenant?: string): Promise<void> {
    requireRole(p, ADMINS);
    await withTenantTx(this.db, tenantOf(p, tenant), async (tx) => {
      if (!(await this.store.deleteDomain(tx, id)))
        throw new NotFoundError('DOMAIN_NOT_FOUND', 'Domain not found.');
    });
  }

  /** Looks the records up in DNS: ownership TXT, SPF include and the DKIM CNAME. */
  async verifyDomain(p: Principal, id: string, tenant?: string) {
    requireRole(p, ADMINS);
    const tenantId = tenantOf(p, tenant);
    const d = await withTenantTx(this.db, tenantId, (tx) => this.store.domain(tx, id));
    if (!d) throw new NotFoundError('DOMAIN_NOT_FOUND', 'Domain not found.');
    const safe = async (f: () => Promise<string[]>) => {
      try {
        return await f();
      } catch {
        return [];
      }
    };
    const owner = (await safe(() => this.dns.txt(`_atlas-verify.${d.domain}`))).includes(
      `atlas-verification=${d.verificationToken}`,
    );
    const spf = (await safe(() => this.dns.txt(d.domain))).some(
      (r) =>
        r.startsWith('v=spf1') && r.split(/\s+/).includes(`include:${this.settings.spfInclude}`),
    );
    const target = `${d.dkimSelector}.${this.settings.dkimTarget}`;
    const dkim = (
      await safe(() => this.dns.cname(`${d.dkimSelector}._domainkey.${d.domain}`))
    ).some((r) => r.replace(/\.$/, '').toLowerCase() === target);
    const status = owner && spf && dkim ? 'verified' : 'failed';
    const saved = await withTenantTx(this.db, tenantId, (tx) =>
      this.store.saveDomainCheck(tx, id, spf, dkim, status, this.clock.now()),
    );
    return { ...this.viewDomain(saved as DomainRow), ownership_verified: owner };
  }

  // --- Reminders ----------------------------------------------------------------------------

  async scheduleReminder(
    p: Principal,
    input: {
      tenant_id?: string | undefined;
      type: 'self_rating_reminder' | 'manager_rating_reminder';
      recipient_user_id: string;
      due_at: string;
      values: Record<string, string>;
    },
  ) {
    requireRole(p, [...ADMINS, 'hiring_manager', 'service']);
    const tenantId = tenantOf(p, input.tenant_id);
    const allowed = new Set(allowedPlaceholders(input.type));
    for (const [k, v] of Object.entries(input.values)) {
      if (!allowed.has(k))
        throw new ValidationError('Unknown placeholder value.', [
          { path: `values.${k}`, message: 'not allowed for this type' },
        ]);
      if (k === 'URL' && !isHttpsUrl(v))
        throw new ValidationError('URL must be https.', [
          { path: 'values.URL', message: 'must be https' },
        ]);
    }
    const row: ReminderRow = {
      reminderId: newId(),
      type: input.type,
      recipientUserId: input.recipient_user_id,
      dueAt: new Date(input.due_at),
      data: input.values,
      status: 'scheduled',
      createdBy: p.subject,
      createdAt: this.clock.now(),
    };
    await withTenantTx(this.db, tenantId, (tx) => this.store.insertReminder(tx, tenantId, row));
    return viewReminder(row);
  }

  async reminders(p: Principal, status: string | undefined, tenant?: string) {
    requireRole(p, [...ADMINS, 'hiring_manager']);
    return withTenantTx(this.db, tenantOf(p, tenant), async (tx) =>
      (await this.store.reminders(tx, status ?? null, 200)).map(viewReminder),
    );
  }

  async cancelReminder(p: Principal, id: string, tenant?: string) {
    requireRole(p, [...ADMINS, 'hiring_manager', 'service']);
    return withTenantTx(this.db, tenantOf(p, tenant), async (tx) => {
      const r = await this.store.reminder(tx, id);
      if (!r) throw new NotFoundError('REMINDER_NOT_FOUND', 'Reminder not found.');
      if (!(await this.store.setReminderStatus(tx, id, 'scheduled', 'cancelled')))
        throw new DomainRuleError('REMINDER_NOT_SCHEDULED', `The reminder is already ${r.status}.`);
      return viewReminder({ ...r, status: 'cancelled' });
    });
  }
}

function viewSettings(s: TenantSettings) {
  const hhmm = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return {
    quiet_hours:
      s.quietStartMin !== null && s.quietEndMin !== null
        ? { start: hhmm(s.quietStartMin), end: hhmm(s.quietEndMin) }
        : null,
    time_zone: s.timeZone,
    max_per_day: s.maxPerDay,
    from_name: s.fromName,
  };
}

function viewReminder(r: ReminderRow) {
  return {
    reminder_id: r.reminderId,
    type: r.type,
    recipient_user_id: r.recipientUserId,
    due_at: r.dueAt.toISOString(),
    values: r.data,
    status: r.status,
    created_by: r.createdBy,
    created_at: r.createdAt.toISOString(),
  };
}
