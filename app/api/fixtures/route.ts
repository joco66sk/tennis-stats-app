import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { CACHE_DIR, STATIC_CACHE, HOST, RAPIDAPI_HEADERS, groundTypeToSurface, initCache } from '@/lib/shared';

function tennisPointsToRankId(points?: number): number {
  if (!points) return 0;
  if (points >= 2000) return 4;
  if (points >= 1000) return 3;
  if (points >= 250) return 2;
  return 1;
}

// Transforms a Sofascore event into the fixture shape expected by page.tsx
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function transformEvent(event: any): any {
  const surface = groundTypeToSurface(event.groundType)
    ?? groundTypeToSurface(event.tournament?.uniqueTournament?.groundType);
  const tp: number = event.tournament?.uniqueTournament?.tennisPoints ?? 0;
  const rankId = tennisPointsToRankId(tp);
  return {
    id: event.id,
    date: new Date((event.startTimestamp as number) * 1000).toISOString(),
    player1: event.homeTeam ? {
      id: event.homeTeam.id,
      name: event.homeTeam.name,
      countryAcr: event.homeTeam.country?.alpha2 || undefined,
    } : undefined,
    player2: event.awayTeam ? {
      id: event.awayTeam.id,
      name: event.awayTeam.name,
      countryAcr: event.awayTeam.country?.alpha2 || undefined,
    } : undefined,
    tournament: {
      id: event.tournament?.uniqueTournament?.id,
      name: event.tournament?.uniqueTournament?.name || event.tournament?.name || '',
      court: surface ? { name: surface } : undefined,
      rank: { id: rankId, name: rankId >= 4 ? 'Grand Slam' : rankId >= 3 ? 'Masters 1000' : 'ATP250' },
    },
    round: event.roundInfo ? { name: event.roundInfo.name } : undefined,
  };
}

async function safeFetch(url: string): Promise<{ events?: unknown[] }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: RAPIDAPI_HEADERS, next: { revalidate: 3600 } });
      if (!res.ok) return { events: [] };
      const json = await res.json() as { events?: unknown[] };
      if ((json.events?.length ?? 0) > 0 || attempt === 1) return json;
      await new Promise(r => setTimeout(r, 1000));
    } catch {
      if (attempt === 1) return { events: [] };
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return { events: [] };
}

function getCacheTTL(date: string): number {
  const cetNow = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const today = cetNow.toISOString().split('T')[0];
  const tomorrow = new Date(cetNow.getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  if (date < today) return 24 * 60 * 60 * 1000;
  if (date === today) return 60 * 60 * 1000;
  if (date === tomorrow) return 45 * 60 * 1000;
  return 30 * 60 * 1000;
}

function readFreshCache(date: string): string | null {
  const cetNow = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const today = cetNow.toISOString().split('T')[0];
  const fp = path.join(CACHE_DIR, `fixtures-${date}.json`);
  if (!fs.existsSync(fp)) return null;
  try {
    const raw = fs.readFileSync(fp, 'utf-8');
    if (date < today) return raw;
    const data = JSON.parse(raw) as { fetchedAt?: number };
    if (!data.fetchedAt) return null;
    return Date.now() - data.fetchedAt < getCacheTTL(date) ? raw : null;
  } catch { return null; }
}

function readStaleCache(date: string): string | null {
  for (const dir of [CACHE_DIR, STATIC_CACHE]) {
    const fp = path.join(dir, `fixtures-${date}.json`);
    if (!fs.existsSync(fp)) continue;
    try {
      const raw = fs.readFileSync(fp, 'utf-8');
      const d = JSON.parse(raw) as { fixtures?: unknown[] };
      if ((d.fixtures?.length ?? 0) > 0) return raw;
    } catch {}
  }
  return null;
}

export async function GET(request: NextRequest) {
  initCache();
  const { searchParams } = new URL(request.url);
  const forceRefresh = searchParams.get('refresh') === 'true';
  const cetNow = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const date = searchParams.get('date') || cetNow.toISOString().split('T')[0];

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return NextResponse.json({ error: 'Invalid date format' }, { status: 400 });

  if (!forceRefresh) {
    const cached = readFreshCache(date);
    if (cached) {
      console.log(`Serving cached fixtures for ${date}`);
      return NextResponse.json(JSON.parse(cached));
    }
  }

  console.log(`Fetching fresh fixtures for ${date}`);

  const [y, m, d] = date.split('-');
  const url = `https://${HOST}/api/tennis/category/3/events/${parseInt(d)}/${parseInt(m)}/${y}`;
  const fetched = await safeFetch(url);
  const rawEvents = (fetched.events ?? []) as any[];

  const seen = new Set<number>();
  const fixtures = rawEvents
    .filter(e => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      if (!e.homeTeam || !e.awayTeam) return false;
      if ((e.homeTeam.name || '').includes('/') || (e.awayTeam.name || '').includes('/')) return false;
      const tp: number = e.tournament?.uniqueTournament?.tennisPoints ?? 0;
      return tp >= 250;
    })
    .map(transformEvent)
    .sort((a: any, b: any) => (b.tournament?.rank?.id ?? 0) - (a.tournament?.rank?.id ?? 0));

  if (fixtures.length === 0) {
    const stale = readStaleCache(date);
    if (stale) {
      const existing = JSON.parse(stale) as { fixtures?: unknown[] };
      console.log(`API returned 0 fixtures, keeping cached ${existing.fixtures!.length}`);
      return NextResponse.json(existing);
    }
  }

  const result = { date, fixtures, count: fixtures.length, fetchedAt: Date.now() };
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CACHE_DIR, `fixtures-${date}.json`), JSON.stringify(result, null, 2), 'utf-8');

  return NextResponse.json(result);
}
