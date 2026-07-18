'use client';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import CompareClient from './CompareClient';

function CompareContent() {
  const searchParams = useSearchParams();
  const p1Id = searchParams.get('p1') || '';
  const p2Id = searchParams.get('p2') || '';
  const surface = searchParams.get('surface') || 'Clay';
  return <CompareClient p1Id={p1Id} p2Id={p2Id} surface={surface} />;
}

export default function ComparePage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-zinc-950 flex items-center justify-center text-zinc-500">Loading...</div>}>
      <CompareContent />
    </Suspense>
  );
}
