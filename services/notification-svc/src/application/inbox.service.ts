import { Inject, Injectable } from '@nestjs/common';
import {
  BadRequestError,
  CLOCK,
  type Clock,
  DATABASE,
  type Database,
  isUuid,
  NotFoundError,
  type Principal,
  withTenantTx,
} from '@atlas/platform';
import { type NotificationRow, type NotificationStore, NOTIFICATION_STORE } from './store';
import { inboxOwner } from './access';

export interface InboxItem {
  notification_id: string;
  type: string;
  title: string;
  body: string;
  path: string | null;
  read: boolean;
  created_at: string;
}

const item = (n: NotificationRow): InboxItem => ({
  notification_id: n.notificationId,
  type: n.type,
  title: String(n.data['title'] ?? ''),
  body: String(n.data['body'] ?? ''),
  path: (n.data['path'] as string | null) ?? null,
  read: n.readAt !== null,
  created_at: n.createdAt.toISOString(),
});

/** Opaque cursor: created_at and id of an item. */
export function encodeCursor(n: { createdAt: Date; id: string }): string {
  return Buffer.from(`${n.createdAt.toISOString()}|${n.id}`).toString('base64url');
}

export function decodeCursor(raw: string | undefined): { createdAt: Date; id: string } | null {
  if (!raw) return null;
  const [at, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(at ?? '');
  if (!id || !isUuid(id) || Number.isNaN(createdAt.getTime()))
    throw new BadRequestError('INVALID_CURSOR', 'The cursor is not valid.');
  return { createdAt, id };
}

/** `GET /v1/me/notifications`: the caller's own in-app notifications, never anyone else's. */
@Injectable()
export class InboxService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(NOTIFICATION_STORE) private readonly store: NotificationStore,
  ) {}

  async list(
    p: Principal,
    q: { cursor?: string | undefined; limit: number; unread_only: boolean },
  ) {
    const { tenantId, userId } = inboxOwner(p);
    return withTenantTx(this.db, tenantId, async (tx) => {
      const rows = await this.store.inbox(
        tx,
        userId,
        null,
        decodeCursor(q.cursor),
        q.limit + 1,
        q.unread_only,
      );
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return {
        items: page.map(item),
        unread: await this.store.unreadCount(tx, userId),
        next_cursor:
          rows.length > q.limit && last
            ? encodeCursor({ createdAt: last.createdAt, id: last.notificationId })
            : null,
      };
    });
  }

  /** Items newer than `after` (oldest first), for the SSE stream. */
  async since(p: Principal, after: { createdAt: Date; id: string } | null, limit = 50) {
    const { tenantId, userId } = inboxOwner(p);
    return withTenantTx(this.db, tenantId, async (tx) => {
      const rows = after
        ? await this.store.inbox(tx, userId, after, null, limit, false)
        : (await this.store.inbox(tx, userId, null, null, limit, true)).reverse();
      return {
        items: rows.map((n) => ({
          ...item(n),
          cursor: encodeCursor({ createdAt: n.createdAt, id: n.notificationId }),
        })),
        unread: await this.store.unreadCount(tx, userId),
      };
    });
  }

  async markRead(p: Principal, id: string): Promise<{ notification_id: string; read: true }> {
    const { tenantId, userId } = inboxOwner(p);
    await withTenantTx(this.db, tenantId, async (tx) => {
      if (!(await this.store.markRead(tx, userId, id, this.clock.now())))
        throw new NotFoundError('NOTIFICATION_NOT_FOUND', 'Notification not found.');
    });
    return { notification_id: id, read: true };
  }

  async markAllRead(p: Principal): Promise<{ marked: number }> {
    const { tenantId, userId } = inboxOwner(p);
    return {
      marked: await withTenantTx(this.db, tenantId, (tx) =>
        this.store.markAllRead(tx, userId, this.clock.now()),
      ),
    };
  }
}
