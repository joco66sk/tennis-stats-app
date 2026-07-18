import { redirect } from 'next/navigation';
import { computePlayerSurfaceStats, PlayerSurfaceStats } from '@/lib/player-stats';
import CompareClient from '../CompareClient';

export const revalidate = 3600;

function toTitleCase(slug: string) {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function buildNarrative(s1: PlayerSurfaceStats, s2: PlayerSurfaceStats, surface: string): string {
  if (s1.matchesWithStats === 0 || s2.matchesWithStats === 0) return '';
  const c1 = s1.avgServeWon + s1.avgReturnWon;
  const c2 = s2.avgServeWon + s2.avgReturnWon;
  const leader = c1 > c2 ? s1 : s2;
  const trailer = c1 > c2 ? s2 : s1;
  const diff = Math.abs(c1 - c2).toFixed(1);
  const surf = surface.toLowerCase();
  return `On ${surf}, ${leader.playerName} leads with ${Math.max(c1, c2).toFixed(1)}% combined serve + return versus ${trailer.playerName}'s ${Math.min(c1, c2).toFixed(1)}% — a ${diff}pp gap. W-L over last 10 ${surf} matches: ${leader.playerName} ${leader.wins}W–${leader.losses}L, ${trailer.playerName} ${trailer.wins}W–${trailer.losses}L.`;
}

function parseSlug(slug: string): { p1: string; p2: string; surface: string } | null {
  const parts = slug.split('-');
  if (parts.length < 4) return null;
  const p2 = parts[parts.length - 1];
  const p1 = parts[parts.length - 2];
  const surface = parts[parts.length - 3];
  if (!/^\d+$/.test(p1) || !/^\d+$/.test(p2)) return null;
  if (!['Clay', 'Hard', 'Grass', 'All'].includes(surface)) return null;
  return { p1, p2, surface };
}

export default async function MatchSlugPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const parsed = parseSlug(slug);
  if (!parsed) redirect('/');
  const { p1, p2, surface } = parsed;

  const [s1, s2] = await Promise.all([
    Promise.resolve(computePlayerSurfaceStats(p1, surface, 10)),
    Promise.resolve(computePlayerSurfaceStats(p2, surface, 10)),
  ]);
  const narrative = buildNarrative(s1, s2, surface);

  const slugParts = slug.split('-');
  const ddmmyy = slugParts[slugParts.length - 4] || '';
  const startDate = ddmmyy.length === 6
    ? `20${ddmmyy.slice(4, 6)}-${ddmmyy.slice(2, 4)}-${ddmmyy.slice(0, 2)}`
    : new Date().toISOString().split('T')[0];

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SportsEvent',
    name: `${s1.playerName} vs ${s2.playerName}`,
    sport: 'Tennis', startDate, endDate: startDate,
    eventStatus: 'https://schema.org/EventScheduled',
    image: 'https://tennisdeepstats.com/android-chrome-512x512.png',
    location: { '@type': 'Place', name: `${surface} Court`, address: { '@type': 'PostalAddress', addressCountry: 'INT' } },
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD', availability: 'https://schema.org/InStock', validFrom: startDate, url: `https://tennisdeepstats.com/compare/${slug}` },
    organizer: { '@type': 'Organization', name: 'ATP Tour', url: 'https://www.atptour.com' },
    performer: [{ '@type': 'Person', name: s1.playerName }, { '@type': 'Person', name: s2.playerName }],
    competitor: [{ '@type': 'SportsTeam', name: s1.playerName }, { '@type': 'SportsTeam', name: s2.playerName }],
    description: narrative || `${s1.playerName} vs ${s2.playerName} ${surface} surface stats.`,
    url: `https://tennisdeepstats.com/compare/${slug}`,
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <CompareClient p1Id={p1} p2Id={p2} surface={surface} />
    </>
  );
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const parsed = parseSlug(slug);
  if (!parsed) return { title: 'Tennis Deep Stats', description: 'ATP tennis serve & return stats.' };
  const { p1, p2, surface } = parsed;
  const s1 = computePlayerSurfaceStats(p1, surface, 10);
  const s2 = computePlayerSurfaceStats(p2, surface, 10);
  const p1Name = s1.playerName || toTitleCase(p1);
  const p2Name = s2.playerName || toTitleCase(p2);
  const narrative = buildNarrative(s1, s2, surface);
  const description = narrative || `${p1Name} vs ${p2Name} ${surface} surface stats — serve %, return %, combined serve+return performance. Data from last 10 ATP matches on ${surface.toLowerCase()}.`;
  return {
    title: `${p1Name} vs ${p2Name} ${surface} Stats | Tennis Deep Stats`,
    description,
    alternates: { canonical: `https://tennisdeepstats.com/compare/${slug}` },
    openGraph: { title: `${p1Name} vs ${p2Name} — ${surface} Stats`, description, url: `https://tennisdeepstats.com/compare/${slug}`, siteName: 'Tennis Deep Stats' },
  };
}
