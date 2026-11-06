'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useClaims } from '@/components/providers';
import { Loading } from '@/components/ui';
import { homeFor } from '@/lib/session';

export default function Home() {
  const router = useRouter();
  const { claims, ready } = useClaims();
  useEffect(() => {
    if (ready) router.replace(homeFor(claims));
  }, [ready, claims, router]);
  return (
    <main className="p-8">
      <Loading />
    </main>
  );
}
