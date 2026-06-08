import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { MATCH_STATS_DIR, initCache } from '@/lib/shared';

function readMatchStats(tournamentId: number, p1: number, p2: number) {
  for (const [a, b] of [[p1, p2], [p2, p1]]) {
    const file = path.join(MATCH_STATS_DIR, `match-stats-${tournamentId}-${a}-${b}.json`);
    if (fs.existsSync(file)) {
      try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch {}
    }
  }
  return null;
}

export function GET(request: NextRequest) {
  initCache();
  const { searchParams } = new URL(request.url);
  const tournamentId = parseInt(searchParams.get('tournamentId') || '');
  const p1 = parseInt(searchParams.get('p1') || '');
  const p2 = parseInt(searchParams.get('p2') || '');

  if (!tournamentId || !p1 || !p2)
    return NextResponse.json({ error: 'Missing params' }, { status: 400 });

  const data = readMatchStats(tournamentId, p1, p2);
  if (!data) return NextResponse.json({ error: 'Stats not available' }, { status: 404 });

  return NextResponse.json(data);
}
