import { Suspense } from 'react';
import { Redeem } from '@/components/redeem';

export default function MagicLink() {
  return (
    <Suspense>
      <Redeem kind="magic" />
    </Suspense>
  );
}
