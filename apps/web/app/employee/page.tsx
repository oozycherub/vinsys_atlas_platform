'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, ErrorNote, Loading, PageTitle, Table } from '@/components/ui';
import { api, unwrap } from '@/lib/api';

interface Me {
  employee_id: string;
  department: string | null;
  location: string | null;
  role_fit: {
    readiness: number;
    band: string;
    gaps: { skill_id: string; skill_name?: string; required: number; proficiency: number }[];
  } | null;
}

export default function MySkills() {
  const q = useQuery({
    queryKey: ['me'],
    queryFn: async () => unwrap(await api.intelligence.GET('/v1/employees/me')) as unknown as Me,
  });
  return (
    <>
      <PageTitle>My skills</PageTitle>
      {q.isPending ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : null}
      {q.data ? (
        <Card title="Fit for my current role">
          {q.data.role_fit ? (
            <>
              <p className="mb-3">
                Readiness <strong>{Math.round(q.data.role_fit.readiness * 100)}%</strong> (gap{' '}
                {q.data.role_fit.band})
              </p>
              <Table
                caption="Skill gaps for my role"
                head={['Skill', 'Required', 'Mine']}
                rows={q.data.role_fit.gaps.map((g) => [
                  g.skill_name ?? g.skill_id.slice(0, 8),
                  g.required.toFixed(1),
                  g.proficiency.toFixed(1),
                ])}
              />
            </>
          ) : (
            <p className="text-sm text-muted">Your role has no skill requirements yet.</p>
          )}
        </Card>
      ) : null}
    </>
  );
}
