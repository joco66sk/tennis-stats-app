import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const CACHE_DIR = path.join(process.cwd(), 'cache');

function fromRankingsCache() {
  const fp = path.join(CACHE_DIR, 'top-players.json');
  if (!fs.existsSync(fp)) return null;
  try {
    const { players } = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    if (Array.isArray(players) && players.length >= 10) return players.slice(0, 20);
  } catch {}
  return null;
}

function fromFixtures() {
  const playerMap = new Map<number, { name: string; ranking: number }>();
  try {
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith('fixtures-') && f.endsWith('.json'));
    for (const file of files) {
      try {
        const { fixtures = [] } = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf-8'));
        for (const f of fixtures) {
          for (const p of [f.player1, f.player2]) {
            if (!p?.id || !p.ranking) continue;
            const existing = playerMap.get(p.id);
            if (!existing || p.ranking < existing.ranking) {
              playerMap.set(p.id, { name: p.name, ranking: p.ranking });
            }
          }
        }
      } catch {}
    }
  } catch {}
  return [...playerMap.entries()]
    .map(([id, data]) => ({ id, ...data }))
    .sort((a, b) => a.ranking - b.ranking)
    .slice(0, 20);
}

export async function GET() {
  const players = fromRankingsCache() ?? fromFixtures();
  return NextResponse.json({ players }, { headers: { 'Cache-Control': 'public, max-age=1800' } });
}
