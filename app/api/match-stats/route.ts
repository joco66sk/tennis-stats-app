import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { MATCH_STATS_DIR, HOST, RAPIDAPI_HEADERS, initCache } from '@/lib/shared';

function readMatchStats(tournamentId: number, p1: number, p2: number) {
  for (const [a, b] of [[p1, p2], [p2, p1]]) {
    const file = path.join(MATCH_STATS_DIR, `match-stats-${tournamentId}-${a}-${b}.json`);
    if (fs.existsSync(file)) {
      try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch {}
    }
  }
  return null;
}

async function fetchLiveStats(tournamentId: number, p1: number, p2: number) {
  for (const [a, b] of [[p1, p2], [p2, p1]]) {
    try {
      const res = await fetch(
        `https://${HOST}/tennis/v2/atp/h2h/match-stats/${tournamentId}/${a}/${b}`,
        { headers: RAPIDAPI_HEADERS }
      );
      if (!res.ok) continue;
      const raw = await res.json() as { data?: { player1Stats?: unknown } };
      if (raw?.data?.player1Stats) {
        const filePath = path.join(MATCH_STATS_DIR, `match-stats-${tournamentId}-${a}-${b}.json`);
        try { fs.writeFileSync(filePath, JSON.stringify(raw.data, null, 2)); } catch {}
        return raw.data;
      }
    } catch {}
  }
  return null;
}

export async function GET(request: NextRequest) {
  initCache();
  const { searchParams } = new URL(request.url);
  const tournamentId = parseInt(searchParams.get('tournamentId') || '');
  const p1 = parseInt(searchParams.get('p1') || '');
  const p2 = parseInt(searchParams.get('p2') || '');

  if (!tournamentId || !p1 || !p2)
    return NextResponse.json({ error: 'Missing params' }, { status: 400 });

  const cached = readMatchStats(tournamentId, p1, p2);
  if (cached) return NextResponse.json(cached);

  const live = await fetchLiveStats(tournamentId, p1, p2);
  if (!live) return NextResponse.json({ error: 'Stats not available' }, { status: 404 });
  return NextResponse.json(live);
}
