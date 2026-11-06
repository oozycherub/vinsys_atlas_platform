'use client';

import { useState } from 'react';
import { useT } from '@/components/providers';
import { Button, ErrorNote, Field } from '@/components/ui';
import { api, unwrap } from '@/lib/api';
import { tenantSlug } from '@/lib/session';

export default function Login() {
  const t = useT();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const out = unwrap(
        await api.identity.POST('/v1/auth/magic-links', {
          body: { tenant_slug: tenantSlug(window.location.hostname), email },
        }),
      );
      // The binding ties the emailed link to this browser; it is sent back on redeem.
      sessionStorage.setItem('atlas.magic.binding', out.binding);
      setSent(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main
      id="main"
      className="mx-auto mt-24 max-w-md rounded-lg border border-slate-200 bg-white p-8 shadow-sm"
    >
      <h1 className="mb-6 text-2xl font-semibold">{t('login.title')}</h1>
      {sent ? (
        <p role="status">{t('login.sent')}</p>
      ) : (
        <form onSubmit={submit} noValidate>
          <Field
            id="email"
            label={t('login.email')}
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          {error ? <ErrorNote error={error} /> : null}
          <Button type="submit" disabled={busy || !email} className="w-full">
            {t('login.submit')}
          </Button>
        </form>
      )}
    </main>
  );
}
