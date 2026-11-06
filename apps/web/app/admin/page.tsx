'use client';

import Link from 'next/link';
import { Card, PageTitle } from '@/components/ui';

const AREAS = [
  { href: '/admin/users', title: 'Users', text: 'Invite people and manage roles.' },
  {
    href: '/admin/taxonomy',
    title: 'Skills and job profiles',
    text: 'The skills taxonomy and role requirements.',
  },
  {
    href: '/admin/analytics',
    title: 'Analytics',
    text: 'Skill gaps across departments and roles.',
  },
  {
    href: '/admin/notification-settings',
    title: 'Notification settings',
    text: 'Which notifications are sent, templates, webhooks.',
  },
  {
    href: '/admin/reports',
    title: 'Report settings',
    text: 'Sections of the candidate assessment report.',
  },
];

export default function AdminHome() {
  return (
    <>
      <PageTitle>Administration</PageTitle>
      <div className="grid gap-4 sm:grid-cols-2">
        {AREAS.map((a) => (
          <Card key={a.href}>
            <h2 className="text-lg font-semibold">
              <Link href={a.href} className="text-brand underline">
                {a.title}
              </Link>
            </h2>
            <p className="text-sm text-muted">{a.text}</p>
          </Card>
        ))}
      </div>
    </>
  );
}
