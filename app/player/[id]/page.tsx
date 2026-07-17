import fs from 'fs';
import path from 'path';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { computePlayerSurfaceStats } from '@/lib/player-stats';
import PlayerTabs from './PlayerTabs';

export const revalidate = 3600;
export const dynamicParams = true;

const CACHE_DIR = path.join(process.cwd(), 'cache');

// Pre-render players appearing in the next 14 days of fixtures
export async function generateStaticParams() {
  const playerIds = new Set<string>();
  for (let i = 0; i <= 14; i++) {
    const d = new Date(Date.now() + 2 * 60 * 60 * 1000 + i * 86400000);
    const date = d.toISOString().split('T')[0];
    const fp = path.join(CACHE_DIR, `fixtures-${date}.json`);
    if (!fs.existsSync(fp)) continue;
    try {
      const { fixtures = [] } = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      for (const f of fixtures) {
        if (f.player1?.id) playerIds.add(String(f.player1.id));
        if (f.player2?.id) playerIds.add(String(f.player2.id));
      }
    } catch {}
  }
  return Array.from(playerIds).map(id => ({ id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = computePlayerSurfaceStats(id, 'Clay', 30);
  const name = s.playerName || `Player ${id}`;
  return {
    title: `${name} Tennis Stats | Tennis Deep Stats`,
    description: `${name} serve, return and win rate stats on Clay, Hard and Grass. Last 30 ATP matches per surface.`,
    alternates: { canonical: `https://tennisdeepstats.com/player/${id}` },
    openGraph: {
      title: `${name} — Surface Stats`,
      description: `Serve %, return %, win rate and recent form for ${name} on Clay, Hard and Grass.`,
      url: `https://tennisdeepstats.com/player/${id}`,
      siteName: 'Tennis Deep Stats',
    },
  };
}

export default async function PlayerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (!/^\d+$/.test(id)) redirect('/');

  const [clay, hard, grass] = [
    computePlayerSurfaceStats(id, 'Clay', 30),
    computePlayerSurfaceStats(id, 'Hard', 30),
    computePlayerSurfaceStats(id, 'Grass', 30),
  ];

  const name = clay.playerName || hard.playerName || grass.playerName;
  const hasAnyData = clay.wins + clay.losses + hard.wins + hard.losses + grass.wins + grass.losses > 0;

  if (!name || !hasAnyData) redirect('/');

  return (
    <div style={{ minHeight: '100vh', background: '#09090b', color: '#fff', padding: '16px', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: 480, margin: '0 auto' }}>

        {/* Nav */}
        <div style={{ marginBottom: 16 }}>
          <Link href="/" style={{ color: '#71717a', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
            ← Fixtures
          </Link>
          <div style={{ marginTop: 10, fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#71717a' }}>
            Tennis Deep Stats
          </div>
        </div>

        {/* Player header */}
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ fontSize: 22, fontWeight: 900, color: '#f4f4f5', margin: '0 0 4px', lineHeight: 1.2 }}>
            {name}
          </h1>
          <div style={{ fontSize: 12, color: '#71717a' }}>ATP Surface Statistics — last 30 matches</div>
        </div>

        <PlayerTabs clay={clay} hard={hard} grass={grass} />

        <div style={{ textAlign: 'center', fontSize: 11, color: '#3f3f46', marginTop: 16 }}>
          tennisdeepstats.com — serve &amp; return stats before every ATP match
        </div>

      </div>
    </div>
  );
}
