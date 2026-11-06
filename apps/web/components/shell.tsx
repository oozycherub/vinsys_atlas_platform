'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { clearSession, loadSession, type Portal, portalsFor } from '@/lib/session';
import { useClaims, useLocale, useT } from './providers';

const LINKS: Record<Portal, { href: string; label: string }[]> = {
  admin: [
    { href: '/admin', label: 'Overview' },
    { href: '/admin/users', label: 'Users' },
    { href: '/admin/taxonomy', label: 'Skills and job profiles' },
    { href: '/admin/analytics', label: 'Analytics' },
    { href: '/admin/notification-settings', label: 'Notification settings' },
    { href: '/admin/reports', label: 'Report settings' },
  ],
  recruiter: [
    { href: '/recruiter', label: 'Assessments' },
    { href: '/recruiter/requisitions', label: 'Requisitions' },
    { href: '/recruiter/reviews', label: 'Review queue' },
  ],
  employee: [
    { href: '/employee', label: 'My skills' },
    { href: '/employee/career', label: 'Career paths' },
    { href: '/employee/marketplace', label: 'Opportunities' },
  ],
};

/** Unread notifications over SSE (fetch, so the bearer token is a header, not in the URL). */
function useUnread(): number | null {
  const [unread, setUnread] = useState<number | null>(null);
  useEffect(() => {
    const token = loadSession()?.accessToken;
    if (!token) return;
    const abort = new AbortController();
    void (async () => {
      try {
        const res = await fetch('/v1/me/notifications:stream', {
          headers: { Authorization: `Bearer ${token}` },
          signal: abort.signal,
        });
        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (reader) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          for (const m of buffer.matchAll(/event: unread\ndata: (\{[^\n]*\})/g))
            setUnread((JSON.parse(m[1] as string) as { unread: number }).unread);
          buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2);
        }
      } catch {
        /* offline or signed out: the badge just stays as it was */
      }
    })();
    return () => abort.abort();
  }, []);
  return unread;
}

export function Shell({ portal, children }: { portal: Portal; children: React.ReactNode }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const { claims, ready } = useClaims();
  const unread = useUnread();

  useEffect(() => {
    if (ready && !claims) router.replace('/login');
  }, [ready, claims, router]);

  const portals = portalsFor(claims);
  const toggleLocale = () => {
    document.cookie = `atlas_locale=${locale === 'en' ? 'ar' : 'en'}; path=/; max-age=31536000; samesite=lax; secure`;
    window.location.reload();
  };

  return (
    <>
      <a
        href="#main"
        className="sr-only-focusable absolute start-2 top-2 z-10 rounded bg-white p-2"
      >
        {t('nav.skip')}
      </a>
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <span className="text-lg font-bold text-brand">{t('app.name')}</span>
          <nav aria-label="Portals" className="flex gap-4 text-sm">
            {portals.map((p) => (
              <Link
                key={p}
                href={`/${p}`}
                aria-current={portal === p ? 'page' : undefined}
                className={portal === p ? 'font-semibold underline' : ''}
              >
                {t(`nav.${p}`)}
              </Link>
            ))}
          </nav>
          <div className="ms-auto flex items-center gap-4 text-sm">
            <Link
              href={`/${portal}/notifications`}
              aria-label={`${t('nav.notifications')}${unread ? ` (${unread} unread)` : ''}`}
            >
              {t('nav.notifications')}
              {unread ? (
                <span className="ms-1 rounded-full bg-brand px-2 text-xs text-white">{unread}</span>
              ) : null}
            </Link>
            <button type="button" onClick={toggleLocale} lang={locale === 'en' ? 'ar' : 'en'}>
              {t('nav.language')}
            </button>
            <button
              type="button"
              onClick={() => {
                clearSession();
                router.replace('/login');
              }}
            >
              {t('nav.signOut')}
            </button>
          </div>
        </div>
      </header>
      <div className="mx-auto flex max-w-6xl gap-8 px-4 py-6">
        <nav aria-label="Sections" className="w-56 shrink-0 text-sm">
          <ul className="space-y-1">
            {LINKS[portal].map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  aria-current={pathname === l.href ? 'page' : undefined}
                  className={`block rounded px-2 py-1 ${pathname === l.href ? 'bg-slate-200 font-semibold' : 'hover:bg-slate-100'}`}
                >
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <main id="main" className="min-w-0 flex-1" tabIndex={-1}>
          {ready && claims ? children : null}
        </main>
      </div>
    </>
  );
}
