'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Card, ErrorNote, Field, Loading, PageTitle, Table } from '@/components/ui';
import { api, unwrap } from '@/lib/api';

interface Assessment {
  assessment_id: string;
  title: string;
  status: string;
  version: number;
}

/** Assessments, and a quick builder for a one-question coding test. */
export default function Assessments() {
  const qc = useQueryClient();
  const router = useRouter();
  const list = useQuery({
    queryKey: ['assessments'],
    queryFn: async () =>
      unwrap(await api.assessment.GET('/v1/assessments')) as unknown as { items: Assessment[] },
  });
  const [form, setForm] = useState({
    title: '',
    minutes: '30',
    prompt: 'Read two integers from standard input and print their sum.',
    starter: 'import sys\n\n',
    input: '2 3',
    expected: '5',
    solution: 'import sys\na, b = map(int, sys.stdin.read().split())\nprint(a + b)\n',
  });
  const set =
    (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm({ ...form, [k]: e.target.value });
  const create = useMutation({
    mutationFn: async () => {
      const q = unwrap(
        await api.assessment.POST('/v1/questions', {
          body: {
            type: 'coding',
            prompt: form.prompt,
            marks: 10,
            payload: {
              languages: ['python'],
              starter_code: { python: form.starter },
              tests: [{ input: form.input, expected: form.expected, hidden: true, weight: 1 }],
              reference_solution: { language: 'python', code: form.solution },
            },
          } as never,
        }),
      ) as unknown as { question_id: string };
      return unwrap(
        await api.assessment.POST('/v1/assessments', {
          body: {
            title: form.title,
            kind: 'coding',
            duration_seconds: Number(form.minutes) * 60,
            definition: {
              sections: [{ title: 'Coding', questions: [{ question_id: q.question_id }] }],
            },
          } as never,
        }),
      ) as unknown as Assessment;
    },
    onSuccess: (a) => {
      void qc.invalidateQueries({ queryKey: ['assessments'] });
      router.push(`/recruiter/assessments/${a.assessment_id}`);
    },
  });
  const area = (id: keyof typeof form, label: string) => (
    <div className="mb-4">
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      <textarea
        id={id}
        rows={3}
        className="w-full rounded-md border border-slate-400 px-3 py-2 font-mono text-sm"
        value={form[id]}
        onChange={set(id)}
      />
    </div>
  );
  return (
    <>
      <PageTitle>Assessments</PageTitle>
      <Card title="Your assessments">
        {list.isPending ? <Loading /> : list.error ? <ErrorNote error={list.error} /> : null}
        {list.data ? (
          <Table
            caption="Assessments"
            head={['Title', 'Status', 'Version']}
            rows={list.data.items.map((a) => [
              <Link
                key={a.assessment_id}
                href={`/recruiter/assessments/${a.assessment_id}`}
                className="text-brand underline"
              >
                {a.title}
              </Link>,
              a.status,
              String(a.version),
            ])}
          />
        ) : null}
      </Card>
      <Card title="New coding assessment">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field id="title" label="Title" required value={form.title} onChange={set('title')} />
          <Field
            id="minutes"
            label="Duration (minutes)"
            type="number"
            min={1}
            max={360}
            required
            value={form.minutes}
            onChange={set('minutes')}
          />
          {area('prompt', 'Question')}
          {area('starter', 'Starter code (Python)')}
          <div className="grid grid-cols-2 gap-4">
            {area('input', 'Hidden test: input')}
            {area('expected', 'Hidden test: expected output')}
          </div>
          {area('solution', 'Reference solution')}
          {create.error ? <ErrorNote error={create.error} /> : null}
          <Button type="submit" disabled={!form.title || create.isPending}>
            Create assessment
          </Button>
        </form>
      </Card>
    </>
  );
}
