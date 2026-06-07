import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { MATCH_STATS_DIR, HOST, RAPIDAPI_HEADERS as HEADERS, initCache } from '@/lib/shared';

async function fetchMatchStats(tournamentId: number, p1: number, p2: number) {
  for (const [a, b] of [[p1, p2], [p2, p1]]) {
    const file = path.join(MATCH_STATS_DIR, `match-stats-${tournamentId}-${a}-${b}.json`);
    if (fs.existsSync(file)) {
      try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch {}
    }
  }
  for (const [a, b] of [[p1, p2], [p2, p1]]) {
    try {
      const res = await fetch(
        `https://${HOST}/tennis/v2/atp/h2h/match-stats/${tournamentId}/${a}/${b}`,
        { headers: HEADERS }
      );
      if (!res.ok) continue;
      const raw = await res.json();
      if (raw?.data?.player1Stats) {
        if (!fs.existsSync(MATCH_STATS_DIR)) fs.mkdirSync(MATCH_STATS_DIR, { recursive: true });
        fs.writeFileSync(
          path.join(MATCH_STATS_DIR, `match-stats-${tournamentId}-${a}-${b}.json`),
          JSON.stringify(raw.data, null, 2)
        );
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

  const data = await fetchMatchStats(tournamentId, p1, p2);
  if (!data) return NextResponse.json({ error: 'Stats not available' }, { status: 404 });

  return NextResponse.json(data);
}
