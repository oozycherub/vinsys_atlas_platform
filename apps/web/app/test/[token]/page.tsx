import { Runner } from '@/components/runner/runner';

export const metadata = { title: 'Assessment' };

/** The candidate test runner: no account, an invite link and then a session token. */
export default async function TestPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main id="main" className="mx-auto max-w-4xl px-4 py-6">
      <Runner inviteToken={token} />
    </main>
  );
}
