import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { MATCH_STATS_DIR, HOST, RAPIDAPI_HEADERS, initCache } from '@/lib/shared';

function readMatchStats(eventId: number): any | null {
  const file = path.join(MATCH_STATS_DIR, `match-stats-${eventId}.json`);
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch {}
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseMatchStats(raw: any, homeId: number, awayId: number, eventId: number): any | null {
  const allPeriod = raw.statistics?.find((s: any) => s.period === 'ALL');
  if (!allPeriod) return null;
  const allItems = allPeriod.groups.flatMap((g: any) => g.statisticsItems);
  const getStat = (key: string) => allItems.find((i: any) => i.key === key);
  const fsa  = getStat('firstServeAccuracy');
  const fspa = getStat('firstServePointsAccuracy');
  const sspa = getStat('secondServePointsAccuracy');
  const acesS = getStat('aces');
  const dfS  = getStat('doubleFaults');
  const bpsS = getStat('breakPointsSaved');
  if (!fsa) return null;
  const extract = (side: string) => ({
    firstServeOf: fsa?.[`${side}Total`] ?? 0,
    firstServe: fsa?.[`${side}Value`] ?? 0,
    winningOnFirstServe: fspa?.[`${side}Value`] ?? 0,
    winningOnSecondServe: sspa?.[`${side}Value`] ?? 0,
    aces: acesS?.[`${side}Value`] ?? 0,
    doubleFaults: dfS?.[`${side}Value`] ?? 0,
    breakPointsFaced: bpsS?.[`${side}Total`] ?? 0,
    breakPointsSaved: bpsS?.[`${side}Value`] ?? 0,
  });
  return { eventId, homeId, awayId, home: extract('home'), away: extract('away') };
}

async function fetchLiveStats(eventId: number, homeId: number, awayId: number): Promise<any | null> {
  try {
    const res = await fetch(
      `https://${HOST}/api/tennis/event/${eventId}/statistics`,
      { headers: RAPIDAPI_HEADERS }
    );
    if (!res.ok) return null;
    const raw = await res.json();
    const parsed = parseMatchStats(raw, homeId, awayId, eventId);
    if (parsed) {
      const filePath = path.join(MATCH_STATS_DIR, `match-stats-${eventId}.json`);
      try { fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2)); } catch {}
    }
    return parsed;
  } catch { return null; }
}

export async function GET(request: NextRequest) {
  initCache();
  const { searchParams } = new URL(request.url);
  const eventId = parseInt(searchParams.get('tournamentId') || '');
  const homeId = parseInt(searchParams.get('homeId') || '0') || 0;
  const awayId = parseInt(searchParams.get('awayId') || '0') || 0;

  if (!eventId)
    return NextResponse.json({ error: 'Missing tournamentId param' }, { status: 400 });

  const cached = readMatchStats(eventId);
  if (cached) return NextResponse.json(cached);

  if (!homeId || !awayId)
    return NextResponse.json({ error: 'Stats not cached; homeId+awayId required for live fetch' }, { status: 404 });

  const live = await fetchLiveStats(eventId, homeId, awayId);
  if (!live) return NextResponse.json({ error: 'Stats not available' }, { status: 404 });
  return NextResponse.json(live);
}
