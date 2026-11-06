import { Suspense } from 'react';
import { Redeem } from '@/components/redeem';

export default function Invitation() {
  return (
    <Suspense>
      <Redeem kind="invitation" />
    </Suspense>
  );
}
