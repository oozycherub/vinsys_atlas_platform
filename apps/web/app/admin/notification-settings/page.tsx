'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, ErrorNote, Field, Loading, PageTitle, Table } from '@/components/ui';
import { api, unwrap } from '@/lib/api';

interface Pref {
  type: string;
  transactional: boolean;
  enabled: boolean;
  email: boolean;
  in_app: boolean;
}
interface Endpoint {
  endpoint_id: string;
  url: string;
  event_types: string[];
  enabled: boolean;
  consecutive_failures: number;
}

const EVENT_TYPES = [
  'assessment.session.submitted',
  'assessment.session.terminated',
  'assessment.session.evaluated',
  'proctoring.session.finalized',
  'interview.session.completed',
  'report.artifact.ready',
] as const;

export default function NotificationSettings() {
  const qc = useQueryClient();
  const prefs = useQuery({
    queryKey: ['prefs'],
    queryFn: async () =>
      unwrap(await api.notification.GET('/v1/notification-preferences')) as unknown as {
        items: Pref[];
      },
  });
  const setPref = useMutation({
    mutationFn: async (p: Pref) =>
      unwrap(
        await api.notification.PUT('/v1/notification-preferences/{type}', {
          params: { path: { type: p.type } },
          body: { enabled: p.enabled, email: p.email, in_app: p.in_app },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['prefs'] }),
  });
  const hooks = useQuery({
    queryKey: ['webhooks'],
    queryFn: async () =>
      unwrap(await api.notification.GET('/v1/webhook-endpoints')) as unknown as {
        items: Endpoint[];
      },
  });
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.notification.POST('/v1/webhook-endpoints', {
          body: { url, event_types: [...EVENT_TYPES] },
        }),
      ) as unknown as { secret: string },
    onSuccess: (out) => {
      setSecret(out.secret);
      setUrl('');
      void qc.invalidateQueries({ queryKey: ['webhooks'] });
    },
  });

  return (
    <>
      <PageTitle>Notification settings</PageTitle>
      <Card title="What is sent">
        {prefs.isPending ? <Loading /> : prefs.error ? <ErrorNote error={prefs.error} /> : null}
        {prefs.data ? (
          <Table
            caption="Notification types and channels"
            head={['Type', 'On', 'Email', 'In-app']}
            rows={prefs.data.items.map((p) => [
              p.type.replace(/_/g, ' '),
              ...(['enabled', 'email', 'in_app'] as const).map((k) => (
                <input
                  key={k}
                  type="checkbox"
                  aria-label={`${p.type.replace(/_/g, ' ')}: ${k.replace('_', '-')}`}
                  checked={p[k]}
                  disabled={p.transactional || setPref.isPending}
                  onChange={(e) => setPref.mutate({ ...p, [k]: e.target.checked })}
                />
              )),
            ])}
          />
        ) : null}
        <p className="mt-2 text-xs text-muted">
          Sign-in links, invitations and report-ready messages are always sent.
        </p>
      </Card>
      <Card title="Webhooks">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field
            id="hook-url"
            label="Endpoint URL (https)"
            type="url"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          {create.error ? <ErrorNote error={create.error} /> : null}
          <Button type="submit" disabled={!url || create.isPending}>
            Add endpoint
          </Button>
        </form>
        {secret ? (
          <p role="status" className="mt-3 rounded bg-amber-50 p-3 text-sm">
            Signing secret (shown once): <code className="break-all">{secret}</code>
          </p>
        ) : null}
        {hooks.data ? (
          <div className="mt-4">
            <Table
              caption="Webhook endpoints"
              head={['URL', 'Status', 'Failures']}
              rows={hooks.data.items.map((h) => [
                h.url,
                h.enabled ? 'enabled' : 'disabled',
                String(h.consecutive_failures),
              ])}
            />
          </div>
        ) : null}
      </Card>
    </>
  );
}
