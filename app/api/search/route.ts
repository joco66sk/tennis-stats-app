import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const CACHE_DIR = path.join(process.cwd(), 'cache');

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get('q') || '').toLowerCase().trim();

  if (q.length < 2) return NextResponse.json({ players: [], tournaments: [] });

  const playerMap = new Map<number, { name: string; ranking?: number }>();
  const tournamentMap = new Map<number, { name: string }>();

  try {
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith('fixtures-') && f.endsWith('.json'));
    for (const file of files) {
      try {
        const { fixtures = [] } = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf-8'));
        for (const f of fixtures) {
          for (const p of [f.player1, f.player2]) {
            if (!p?.id || !p.name) continue;
            if (p.name.toLowerCase().includes(q) && !playerMap.has(p.id)) {
              playerMap.set(p.id, { name: p.name, ranking: p.ranking });
            }
          }
          const t = f.tournament;
          if (t?.id && t.name?.toLowerCase().includes(q) && !tournamentMap.has(t.id)) {
            tournamentMap.set(t.id, { name: t.name });
          }
        }
      } catch {}
    }
  } catch {}

  const players = [...playerMap.entries()]
    .map(([id, data]) => ({ id, ...data }))
    .sort((a, b) => (a.ranking ?? 999) - (b.ranking ?? 999))
    .slice(0, 8);

  const tournaments = [...tournamentMap.entries()]
    .map(([id, data]) => ({ id, ...data }))
    .slice(0, 5);

  return NextResponse.json({ players, tournaments });
}
