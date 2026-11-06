'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Button, Card, ErrorNote, Loading, PageTitle, Table } from '@/components/ui';
import { api, unwrap } from '@/lib/api';

interface SessionRow {
  session_id: string;
  candidate_id: string;
  status: string;
  percent_score: number | null;
  submitted_at: string | null;
}
interface ReportView {
  report_id: string;
  status: string;
  error: string | null;
  download: { url: string; file_name: string } | null;
}

function ReportButton({ sessionId }: { sessionId: string }) {
  const [report, setReport] = useState<ReportView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const request = async () => {
    setError(null);
    try {
      let r = unwrap(
        await api.report.POST('/v1/reports', {
          body: { type: 'candidate_assessment_pdf', params: { session_id: sessionId } } as never,
        }),
      ) as unknown as ReportView;
      setReport(r);
      for (let i = 0; i < 60 && (r.status === 'queued' || r.status === 'running'); i++) {
        await new Promise((res) => setTimeout(res, 1000));
        r = unwrap(
          await api.report.GET('/v1/reports/{id}', { params: { path: { id: r.report_id } } }),
        ) as unknown as ReportView;
        setReport(r);
      }
    } catch (err) {
      setError(err);
    }
  };
  if (report?.download)
    return (
      <a
        href={report.download.url}
        className="text-brand underline"
        download={report.download.file_name}
      >
        Download report
      </a>
    );
  return (
    <>
      <Button
        variant="secondary"
        onClick={() => void request()}
        disabled={report !== null && report.status !== 'failed'}
      >
        {report ? (report.status === 'failed' ? 'Retry report' : 'Preparing…') : 'PDF report'}
      </Button>
      {error ? <ErrorNote error={error} /> : null}
      {report?.status === 'failed' ? (
        <ErrorNote error={new Error(report.error ?? 'The report failed.')} />
      ) : null}
    </>
  );
}

export default function AssessmentDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const a = useQuery({
    queryKey: ['assessment', id],
    queryFn: async () =>
      unwrap(
        await api.assessment.GET('/v1/assessments/{assessmentId}', {
          params: { path: { assessmentId: id } },
        }),
      ) as unknown as { title: string; status: string; version: number },
  });
  const sessions = useQuery({
    queryKey: ['sessions', id],
    queryFn: async () =>
      unwrap(
        await api.assessment.GET('/v1/assessments/{assessmentId}/sessions', {
          params: { path: { assessmentId: id } },
        }),
      ) as unknown as { items: SessionRow[] },
    refetchInterval: 5000,
  });
  const publish = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.assessment.POST('/v1/assessments/{assessmentId}:publish', {
          params: { path: { assessmentId: id } },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assessment', id] }),
  });
  const [link, setLink] = useState<string | null>(null);
  const invite = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.assessment.POST('/v1/assessments/{assessmentId}/invite-links', {
          params: { path: { assessmentId: id } },
          body: { kind: 'open' },
        }),
      ) as unknown as { token: string },
    onSuccess: (out) => setLink(`${window.location.origin}/test/${out.token}`),
  });
  if (a.isPending) return <Loading />;
  if (a.error) return <ErrorNote error={a.error} />;
  return (
    <>
      <PageTitle>{a.data.title}</PageTitle>
      <Card title="Status">
        <p className="mb-3">
          {a.data.status} · version {a.data.version}
        </p>
        <div className="flex gap-3">
          {a.data.status === 'draft' ? (
            <Button onClick={() => publish.mutate()} disabled={publish.isPending}>
              Publish
            </Button>
          ) : (
            <Button onClick={() => invite.mutate()} disabled={invite.isPending}>
              Create candidate link
            </Button>
          )}
        </div>
        {publish.error ? <ErrorNote error={publish.error} /> : null}
        {invite.error ? <ErrorNote error={invite.error} /> : null}
        {link ? (
          <p role="status" className="mt-3 text-sm">
            Candidate link (shown once):{' '}
            <code data-testid="candidate-link" className="break-all">
              {link}
            </code>
          </p>
        ) : null}
      </Card>
      <Card title="Candidates">
        {sessions.isPending ? (
          <Loading />
        ) : sessions.error ? (
          <ErrorNote error={sessions.error} />
        ) : null}
        {sessions.data?.items.length ? (
          <Table
            caption="Candidate sessions"
            head={['Candidate', 'Status', 'Score', 'Report']}
            rows={sessions.data.items.map((s) => [
              s.candidate_id.slice(0, 8),
              s.status,
              s.percent_score === null ? '—' : `${Math.round(s.percent_score)}%`,
              s.status === 'submitted' || s.status === 'evaluated' ? (
                <ReportButton key={s.session_id} sessionId={s.session_id} />
              ) : (
                '—'
              ),
            ])}
          />
        ) : sessions.data ? (
          <p className="text-sm text-muted">No candidates yet.</p>
        ) : null}
      </Card>
    </>
  );
}
