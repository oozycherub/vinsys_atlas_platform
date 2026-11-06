'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, ErrorNote, Loading, PageTitle, Table } from '@/components/ui';
import { api, unwrap } from '@/lib/api';

export default function Requisitions() {
  const q = useQuery({
    queryKey: ['requisitions'],
    queryFn: async () =>
      unwrap(await api.matching.GET('/v1/job-requisitions')) as unknown as {
        items: { requisition_id: string; title: string; status: string; openings: number }[];
      },
  });
  return (
    <>
      <PageTitle>Job requisitions</PageTitle>
      <Card>
        {q.isPending ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : null}
        {q.data ? (
          <Table
            caption="Requisitions"
            head={['Title', 'Status', 'Openings']}
            rows={q.data.items.map((r) => [r.title, r.status, String(r.openings)])}
          />
        ) : null}
      </Card>
    </>
  );
}
