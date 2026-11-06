'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ErrorNote, Loading } from '@/components/ui';
import { api, unwrap } from '@/lib/api';
import { decodeClaims, homeFor, saveSession, tenantSlug } from '@/lib/session';

/** Turns an emailed link (magic link or invitation) into a session, once. */
export function Redeem({ kind }: { kind: 'magic' | 'invitation' }) {
  const params = useSearchParams();
  const router = useRouter();
  const [error, setError] = useState<unknown>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = params.get('token') ?? '';
    // Drop the token from the address bar and history straight away.
    window.history.replaceState(null, '', window.location.pathname);
    void (async () => {
      try {
        const tenant_slug = tenantSlug(window.location.hostname);
        const tokens =
          kind === 'magic'
            ? unwrap(
                await api.identity.POST('/v1/auth/magic-links:redeem', {
                  body: {
                    tenant_slug,
                    token,
                    binding: sessionStorage.getItem('atlas.magic.binding') ?? '',
                  },
                }),
              )
            : unwrap(
                await api.identity.POST('/v1/invitations:redeem', { body: { tenant_slug, token } }),
              );
        const t = tokens as { access_token: string; expires_in: number };
        saveSession(t.access_token, t.expires_in);
        sessionStorage.removeItem('atlas.magic.binding');
        router.replace(homeFor(decodeClaims(t.access_token)));
      } catch (err) {
        setError(err);
      }
    })();
  }, [kind, params, router]);

  return (
    <main className="mx-auto mt-24 max-w-md p-8">
      {error ? <ErrorNote error={error} /> : <Loading />}
    </main>
  );
}
