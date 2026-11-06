'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, ErrorNote, Field, Loading, PageTitle, Table } from '@/components/ui';
import { api, unwrap } from '@/lib/api';

const ROLES = [
  'tenant_admin',
  'recruiter',
  'hiring_manager',
  'reviewer',
  'sme',
  'employee',
] as const;
type Role = (typeof ROLES)[number];

export default function Users() {
  const qc = useQueryClient();
  const users = useQuery({
    queryKey: ['users'],
    queryFn: async () =>
      unwrap(await api.identity.GET('/v1/users')) as unknown as {
        items: { user_id: string; email: string; status: string; roles: string[] }[];
      },
  });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('recruiter');
  const invite = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.identity.POST('/v1/users:invite', { body: { email, roles: [role] } as never }),
      ),
    onSuccess: () => {
      setEmail('');
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
  });
  return (
    <>
      <PageTitle>Users</PageTitle>
      <Card title="Invite someone">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            invite.mutate();
          }}
        >
          <Field
            id="invite-email"
            label="Email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <div className="mb-4">
            <label htmlFor="invite-role" className="mb-1 block text-sm font-medium">
              Role
            </label>
            <select
              id="invite-role"
              className="rounded-md border border-slate-400 px-3 py-2"
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r.replace('_', ' ')}
                </option>
              ))}
            </select>
          </div>
          {invite.error ? <ErrorNote error={invite.error} /> : null}
          {invite.isSuccess ? (
            <p role="status" className="mb-3 text-sm text-green-800">
              Invitation sent.
            </p>
          ) : null}
          <Button type="submit" disabled={!email || invite.isPending}>
            Send invitation
          </Button>
        </form>
      </Card>
      <Card title="People">
        {users.isPending ? <Loading /> : users.error ? <ErrorNote error={users.error} /> : null}
        {users.data ? (
          <Table
            caption="Users in this workspace"
            head={['Email', 'Roles', 'Status']}
            rows={users.data.items.map((u) => [u.email, u.roles.join(', '), u.status])}
          />
        ) : null}
      </Card>
    </>
  );
}
