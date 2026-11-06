'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, ErrorNote, Loading, PageTitle } from '@/components/ui';
import { api, unwrap } from '@/lib/api';

interface Path {
  steps: { job_profile_id: string; title: string; readiness: number; transition: string }[];
  learning: { title: string; hours: number }[];
}

export default function Career() {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () =>
      unwrap(await api.intelligence.GET('/v1/employees/me')) as unknown as { employee_id: string },
  });
  const paths = useQuery({
    queryKey: ['career', me.data?.employee_id],
    enabled: Boolean(me.data),
    queryFn: async () =>
      unwrap(
        await api.intelligence.GET('/v1/employees/{id}/career-paths', {
          params: { path: { id: me.data?.employee_id as string } },
        }),
      ) as unknown as { paths: Path[] },
  });
  const error = me.error ?? paths.error;
  return (
    <>
      <PageTitle>Career paths</PageTitle>
      {me.isPending || paths.isPending ? <Loading /> : null}
      {error ? <ErrorNote error={error} /> : null}
      {paths.data?.paths.map((p, i) => (
        <Card key={i} title={p.steps.map((s) => s.title).join(' → ')}>
          <ol className="mb-3 list-decimal ps-6 text-sm">
            {p.steps.map((s) => (
              <li key={s.job_profile_id}>
                {s.title} ({s.transition}) — ready {Math.round(s.readiness * 100)}%
              </li>
            ))}
          </ol>
          {p.learning.length ? (
            <p className="text-sm text-muted">
              Suggested learning: {p.learning.map((l) => `${l.title} (${l.hours} h)`).join(', ')}
            </p>
          ) : null}
        </Card>
      ))}
      {paths.data && !paths.data.paths.length ? (
        <p className="text-sm text-muted">No paths from your role yet.</p>
      ) : null}
    </>
  );
}
