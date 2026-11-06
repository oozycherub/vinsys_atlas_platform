'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Card, ErrorNote, Loading, PageTitle } from '@/components/ui';
import { api, unwrap } from '@/lib/api';

const REVIEW_TYPES = new Set(['proctoring_review_required', 'interview_review_required']);

/** Sessions waiting for a human decision: no candidate is rejected on AI inference alone. */
export default function Reviews() {
  const q = useQuery({
    queryKey: ['inbox'],
    queryFn: async () =>
      unwrap(
        await api.notification.GET('/v1/me/notifications', { params: { query: { limit: 100 } } }),
      ) as unknown as {
        items: {
          notification_id: string;
          type: string;
          title: string;
          body: string;
          path: string | null;
        }[];
      },
  });
  const items = q.data?.items.filter((i) => REVIEW_TYPES.has(i.type)) ?? [];
  return (
    <>
      <PageTitle>Review queue</PageTitle>
      <Card>
        {q.isPending ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : null}
        {q.data && !items.length ? <p className="text-sm text-muted">Nothing to review.</p> : null}
        <ul className="divide-y divide-slate-100">
          {items.map((i) => (
            <li key={i.notification_id} className="py-3">
              <p className="font-medium">
                {i.path ? <Link href={i.path}>{i.title}</Link> : i.title}
              </p>
              <p className="text-sm text-muted">{i.body}</p>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
