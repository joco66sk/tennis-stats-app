import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const CACHE_DIR = path.join(process.cwd(), 'cache');

function tournamentNameSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function toTournamentSlug(id: number, name: string, year: string): string {
  return `${id}-${tournamentNameSlug(name)}-${year}`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get('q') || '').toLowerCase().trim();

  if (q.length < 2) return NextResponse.json({ players: [], tournaments: [] });

  const playerMap = new Map<number, { name: string; ranking?: number }>();
  const tournamentMap = new Map<number, { name: string; slug: string }>();

  // Players from fixture files (most likely to have rankings)
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
        }
      } catch {}
    }
  } catch {}

  // Tournaments from archive (covers past events)
  try {
    const archivePath = path.join(CACHE_DIR, 'tournament-archive.json');
    if (fs.existsSync(archivePath)) {
      const { tournaments = {} } = JSON.parse(fs.readFileSync(archivePath, 'utf-8'));
      for (const t of Object.values(tournaments) as any[]) {
        if (!t?.id || !t.name) continue;
        const searchText = `${t.name} ${t.year}`.toLowerCase();
        if (searchText.includes(q)) {
          const slug = toTournamentSlug(t.id, t.name, t.year);
          tournamentMap.set(t.id, { name: `${t.name} ${t.year}`, slug });
        }
      }
    }
  } catch {}

  const players = [...playerMap.entries()]
    .map(([id, data]) => ({ id, ...data }))
    .sort((a, b) => (a.ranking ?? 999) - (b.ranking ?? 999))
    .slice(0, 8);

  const tournaments = [...tournamentMap.entries()]
    .map(([, data]) => data)
    .sort((a, b) => b.name.localeCompare(a.name)) // newest year first
    .slice(0, 5);

  return NextResponse.json({ players, tournaments });
}
