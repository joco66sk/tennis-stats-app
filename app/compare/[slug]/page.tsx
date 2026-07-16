import { redirect } from 'next/navigation';

export default async function MatchSlugPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ p1?: string; p2?: string; surface?: string }>;
}) {
  const { p1, p2, surface } = await searchParams;
  if (p1 && p2) {
    redirect(`/compare?p1=${p1}&p2=${p2}&surface=${surface || 'Hard'}`);
  }
  redirect('/');
}

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ p1?: string; p2?: string; surface?: string }>;
}) {
  const { slug } = await params;
  const { surface } = await searchParams;
  const parts = slug.split('-vs-');
  const player1 = parts[0]?.replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()) || 'Player 1';
  const rest = parts[1] || '';
  const player2Parts = rest.split('-');
  const player2 = player2Parts.slice(0, 2).map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  return {
    title: `${player1} vs ${player2} Stats | Tennis Deep Stats`,
    description: `${player1} vs ${player2} head-to-head stats on ${surface || 'grass'}. Serve, return and combined performance data from Tennis Deep Stats.`,
  };
}