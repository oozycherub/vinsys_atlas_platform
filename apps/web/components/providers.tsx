'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { type Locale, type MessageKey, translate } from '@/lib/i18n';
import { type Claims, decodeClaims, loadSession } from '@/lib/session';

const LocaleContext = createContext<Locale>('en');

export function useT(): (key: MessageKey) => string {
  const locale = useContext(LocaleContext);
  return (key) => translate(locale, key);
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}

/** The signed-in user's claims (null when signed out); updates on sign-in and sign-out. */
export function useClaims(): { claims: Claims | null; ready: boolean } {
  const [state, setState] = useState<{ claims: Claims | null; ready: boolean }>({
    claims: null,
    ready: false,
  });
  useEffect(() => {
    const read = () => {
      const s = loadSession();
      setState({ claims: s ? decodeClaims(s.accessToken) : null, ready: true });
    };
    read();
    window.addEventListener('atlas:session', read);
    return () => window.removeEventListener('atlas:session', read);
  }, []);
  return state;
}

export function Providers({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  const client = useMemo(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, staleTime: 15_000, refetchOnWindowFocus: false } },
      }),
    [],
  );
  return (
    <LocaleContext.Provider value={locale}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </LocaleContext.Provider>
  );
}
