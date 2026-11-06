'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, ErrorNote, Loading, PageTitle, Table } from '@/components/ui';
import { api, unwrap } from '@/lib/api';

export default function Taxonomy() {
  const skills = useQuery({
    queryKey: ['skills'],
    queryFn: async () =>
      unwrap(
        await api.taxonomy.GET('/v1/skills', { params: { query: { limit: 50 } as never } }),
      ) as unknown as {
        items: { skill_id: string; name: string; node_type: string; path: string }[];
      },
  });
  const profiles = useQuery({
    queryKey: ['job-profiles'],
    queryFn: async () =>
      unwrap(await api.taxonomy.GET('/v1/job-profiles')) as unknown as {
        items: { job_profile_id: string; title: string; status: string }[];
      },
  });
  return (
    <>
      <PageTitle>Skills and job profiles</PageTitle>
      <Card title="Skills">
        {skills.isPending ? <Loading /> : skills.error ? <ErrorNote error={skills.error} /> : null}
        {skills.data ? (
          <Table
            caption="Skills"
            head={['Skill', 'Type', 'Path']}
            rows={skills.data.items.map((s) => [s.name, s.node_type, s.path])}
          />
        ) : null}
      </Card>
      <Card title="Job profiles">
        {profiles.isPending ? (
          <Loading />
        ) : profiles.error ? (
          <ErrorNote error={profiles.error} />
        ) : null}
        {profiles.data ? (
          <Table
            caption="Job profiles"
            head={['Title', 'Status']}
            rows={profiles.data.items.map((p) => [p.title, p.status])}
          />
        ) : null}
      </Card>
    </>
  );
}
