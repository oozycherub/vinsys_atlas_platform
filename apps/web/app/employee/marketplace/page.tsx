'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, ErrorNote, Loading, PageTitle } from '@/components/ui';
import { api, unwrap } from '@/lib/api';

interface Opportunity {
  opportunity_id: string;
  title: string;
  type: string;
  allocation_pct: number;
  start_date: string;
  score?: number;
}

export default function Marketplace() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['feed'],
    queryFn: async () =>
      unwrap(
        await api.intelligence.GET('/v1/opportunities', { params: { query: {} as never } }),
      ) as unknown as { items: Opportunity[] },
  });
  const apply = useMutation({
    mutationFn: async (id: string) =>
      unwrap(
        await api.intelligence.POST('/v1/opportunities/{id}/applications', {
          params: { path: { id } },
          body: {} as never,
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['feed'] }),
  });
  return (
    <>
      <PageTitle>Opportunities</PageTitle>
      {q.isPending ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : null}
      {apply.error ? <ErrorNote error={apply.error} /> : null}
      {q.data?.items.map((o) => (
        <Card key={o.opportunity_id} title={o.title}>
          <p className="mb-3 text-sm text-muted">
            {o.type} · {o.allocation_pct}% from {o.start_date}
            {o.score !== undefined ? ` · match ${Math.round(o.score * 100)}%` : ''}
          </p>
          <Button onClick={() => apply.mutate(o.opportunity_id)} disabled={apply.isPending}>
            Apply
          </Button>
        </Card>
      ))}
      {q.data && !q.data.items.length ? (
        <p className="text-sm text-muted">No open opportunities match you right now.</p>
      ) : null}
    </>
  );
}
