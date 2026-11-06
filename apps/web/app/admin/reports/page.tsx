'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, ErrorNote, Loading, PageTitle } from '@/components/ui';
import { api, unwrap } from '@/lib/api';

interface Section {
  key: string;
  title: string;
  mandatory: boolean;
  enabled: boolean;
}

export default function ReportSettings() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['report-settings'],
    queryFn: async () =>
      unwrap(await api.report.GET('/v1/report-settings')) as unknown as { sections: Section[] },
  });
  const save = useMutation({
    mutationFn: async (s: Section) =>
      unwrap(
        await api.report.PUT('/v1/report-settings', {
          body: { sections: [{ key: s.key as never, enabled: s.enabled }] },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['report-settings'] }),
  });
  return (
    <>
      <PageTitle>Candidate report settings</PageTitle>
      <Card>
        {q.isPending ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : null}
        <fieldset>
          <legend className="mb-3 text-sm text-muted">
            Sections included in candidate PDFs. Mandatory sections are always included.
          </legend>
          {q.data?.sections.map((s) => (
            <div key={s.key} className="mb-2 flex items-center gap-2">
              <input
                id={`sec-${s.key}`}
                type="checkbox"
                checked={s.enabled}
                disabled={s.mandatory || save.isPending}
                onChange={(e) => save.mutate({ ...s, enabled: e.target.checked })}
              />
              <label htmlFor={`sec-${s.key}`}>
                {s.title}
                {s.mandatory ? ' (mandatory)' : ''}
              </label>
            </div>
          ))}
        </fieldset>
        {save.error ? <ErrorNote error={save.error} /> : null}
      </Card>
    </>
  );
}
