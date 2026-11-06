'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Card, ErrorNote, Loading, PageTitle } from '@/components/ui';
import { api, unwrap } from '@/lib/api';

interface Cell {
  group: string;
  skill_id: string;
  skill_name?: string;
  mean_gap: number;
  employees: number;
}

/** Skill-gap heat map. Colour is never the only cue: each cell also shows its value. */
export default function Analytics() {
  const [dimension, setDimension] = useState<'department' | 'location' | 'job_profile'>(
    'department',
  );
  const q = useQuery({
    queryKey: ['skill-gaps', dimension],
    queryFn: async () =>
      unwrap(
        await api.intelligence.GET('/v1/analytics/skill-gaps', {
          params: { query: { dimension } as never },
        }),
      ) as unknown as { cells: Cell[] },
  });
  const cells = q.data?.cells ?? [];
  const groups = [...new Set(cells.map((c) => c.group))];
  const skills = [
    ...new Map(cells.map((c) => [c.skill_id, c.skill_name ?? c.skill_id.slice(0, 8)])).entries(),
  ];
  const shade = (gap: number) =>
    gap > 0.5 ? 'bg-red-200' : gap >= 0.2 ? 'bg-amber-100' : 'bg-green-100';
  return (
    <>
      <PageTitle>Skill gaps</PageTitle>
      <Card>
        <label htmlFor="dimension" className="me-2 text-sm font-medium">
          Group by
        </label>
        <select
          id="dimension"
          value={dimension}
          onChange={(e) => setDimension(e.target.value as typeof dimension)}
          className="rounded-md border border-slate-400 px-2 py-1"
        >
          <option value="department">Department</option>
          <option value="location">Location</option>
          <option value="job_profile">Job profile</option>
        </select>
        <div className="mt-4 overflow-x-auto">
          {q.isPending ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : null}
          {cells.length ? (
            <table className="text-sm">
              <caption className="sr-only">
                Mean skill gap by {dimension} (0 = no gap, 1 = the whole requirement missing)
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="px-2 py-1 text-start">
                    {dimension}
                  </th>
                  {skills.map(([id, name]) => (
                    <th key={id} scope="col" className="px-2 py-1">
                      {name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g}>
                    <th scope="row" className="px-2 py-1 text-start font-medium">
                      {g}
                    </th>
                    {skills.map(([id]) => {
                      const c = cells.find((x) => x.group === g && x.skill_id === id);
                      return (
                        <td
                          key={id}
                          className={`px-2 py-1 text-center ${c ? shade(c.mean_gap) : ''}`}
                        >
                          {c ? `${Math.round(c.mean_gap * 100)}%` : '—'}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : q.data ? (
            <p className="text-sm text-muted">No groups large enough to show yet.</p>
          ) : null}
        </div>
      </Card>
    </>
  );
}
