import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { Providers } from '@/components/providers';
import { dirOf, isLocale, type Locale } from '@/lib/i18n';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Atlas', template: '%s · Atlas' },
  description: 'Skills, assessments and talent intelligence',
};

/** Every page renders per request: the CSP nonce (proxy.ts) needs dynamic rendering. */
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const raw = (await cookies()).get('atlas_locale')?.value;
  const locale: Locale = isLocale(raw) ? raw : 'en';
  return (
    <html lang={locale} dir={dirOf(locale)}>
      <body>
        <Providers locale={locale}>{children}</Providers>
      </body>
    </html>
  );
}
