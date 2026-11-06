'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { api, unwrap } from '@/lib/api';
import { Button, Card, ErrorNote, Loading, PageTitle } from './ui';

interface Item {
  notification_id: string;
  type: string;
  title: string;
  body: string;
  path: string | null;
  read: boolean;
  created_at: string;
}

export function Inbox() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['inbox'],
    queryFn: async () =>
      unwrap(
        await api.notification.GET('/v1/me/notifications', { params: { query: { limit: 50 } } }),
      ) as unknown as { items: Item[]; unread: number },
  });
  const markAll = useMutation({
    mutationFn: async () => unwrap(await api.notification.POST('/v1/me/notifications:markAllRead')),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inbox'] }),
  });
  return (
    <>
      <PageTitle>Notifications</PageTitle>
      <Card>
        {q.isPending ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : null}
        {q.data ? (
          <>
            <p className="mb-3 text-sm text-muted">{q.data.unread} unread</p>
            <ul className="divide-y divide-slate-100">
              {q.data.items.map((i) => (
                <li key={i.notification_id} className="py-3">
                  <p className={i.read ? '' : 'font-semibold'}>
                    {i.path ? <Link href={i.path}>{i.title}</Link> : i.title}
                  </p>
                  <p className="text-sm text-muted">{i.body}</p>
                </li>
              ))}
            </ul>
            <Button variant="secondary" onClick={() => markAll.mutate()} disabled={!q.data.unread}>
              Mark all as read
            </Button>
          </>
        ) : null}
      </Card>
    </>
  );
}
