import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { CACHE_DIR, HOST, RAPIDAPI_HEADERS, initCache } from '@/lib/shared';

async function safeFetch(url: string): Promise<{ data?: unknown[] }> {
  try {
    const res = await fetch(url, { headers: RAPIDAPI_HEADERS, next: { revalidate: 3600 } });
    if (!res.ok) return { data: [] };
    return await res.json() as { data?: unknown[] };
  } catch {
    return { data: [] };
  }
}

function getCacheTTL(date: string): number {
  const cetNow = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const today = cetNow.toISOString().split('T')[0];
  const tomorrow = new Date(cetNow.getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  if (date < today) return 24 * 60 * 60 * 1000;   // past: 24h
  if (date === today) return 4 * 60 * 60 * 1000;  // today: 4h
  if (date === tomorrow) return 90 * 60 * 1000;   // tomorrow: 90 min
  return 30 * 60 * 1000;                          // future: 30 min
}

export async function GET(request: NextRequest) {
  initCache();
  const { searchParams } = new URL(request.url);
  const forceRefresh = searchParams.get('refresh') === 'true';
  const cetNow = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const date = searchParams.get('date') || cetNow.toISOString().split('T')[0];

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return NextResponse.json({ error: 'Invalid date format' }, { status: 400 });

  const cacheFile = path.join(CACHE_DIR, `fixtures-${date}.json`);

  if (!forceRefresh && fs.existsSync(cacheFile)) {
    const age = Date.now() - fs.statSync(cacheFile).mtimeMs;
    if (age < getCacheTTL(date)) {
      console.log(`Serving cached fixtures for ${date}`);
      return NextResponse.json(JSON.parse(fs.readFileSync(cacheFile, 'utf-8')));
    }
  }

  console.log(`Fetching fresh fixtures for ${date}`);
  const year = cetNow.getFullYear();

  const [atpPage1, atpPage2, atpPage3, cal1, cal2, cal3] = await Promise.all([
    safeFetch(`https://${HOST}/tennis/v2/atp/fixtures/${date}?include=tournament,tournament.court,tournament.rank,round&filter=PlayerGroup:singles&pageSize=50&pageNo=1`),
    safeFetch(`https://${HOST}/tennis/v2/atp/fixtures/${date}?include=tournament,tournament.court,tournament.rank,round&filter=PlayerGroup:singles&pageSize=50&pageNo=2`),
    safeFetch(`https://${HOST}/tennis/v2/atp/fixtures/${date}?include=tournament,tournament.court,tournament.rank,round&filter=PlayerGroup:singles&pageSize=50&pageNo=3`),
    safeFetch(`https://${HOST}/tennis/v2/atp/tournament/calendar/${year}?include=court&pageSize=50&pageNo=1`),
    safeFetch(`https://${HOST}/tennis/v2/atp/tournament/calendar/${year}?include=court&pageSize=50&pageNo=2`),
    safeFetch(`https://${HOST}/tennis/v2/atp/tournament/calendar/${year}?include=court&pageSize=50&pageNo=3`),
  ]);

  const toArr = (d: { data?: unknown[] }) => d.data ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const calendarData: any[] = [...toArr(cal1), ...toArr(cal2), ...toArr(cal3)];
  const calendarMap: Record<number, unknown> = Object.fromEntries(calendarData.map((t: { id: number }) => [t.id, t]));

  const seen = new Set<number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allFixtures: any[] = ([...toArr(atpPage1), ...toArr(atpPage2), ...toArr(atpPage3)] as any[])
    .filter(f => { if (seen.has(f.id)) return false; seen.add(f.id); return true; });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const enriched: any[] = allFixtures
    .filter(f => !String(f.player1?.name ?? '').includes('/') && !String(f.player2?.name ?? '').includes('/'))
    .map(f => ({
      ...f,
      tournament: {
        ...f.tournament,
        rank: (calendarMap[f.tournamentId] as { rank?: unknown } | undefined)?.rank ?? f.tournament?.rank,
      },
    }))
    .sort((a, b) => (b.tournament?.rank?.id ?? 0) - (a.tournament?.rank?.id ?? 0));

  // Never overwrite a non-empty cache with zero results (API may be rate-limited)
  if (enriched.length === 0 && fs.existsSync(cacheFile)) {
    const existing = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as { fixtures?: unknown[] };
    if ((existing.fixtures?.length ?? 0) > 0) {
      console.log(`API returned 0 fixtures, keeping cached ${existing.fixtures!.length}`);
      return NextResponse.json(existing);
    }
  }

  const result = { date, fixtures: enriched, count: enriched.length };
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf-8');

  // Persist tournament → surface map for player-surface-stats fallback
  try {
    const surfacesPath = path.join(CACHE_DIR, `surfaces-${year}.json`);
    const surfacesMap: Record<number, string> = fs.existsSync(surfacesPath)
      ? JSON.parse(fs.readFileSync(surfacesPath, 'utf-8')) as Record<number, string>
      : {};
    for (const t of calendarData as Array<{ id: number; court?: { name: string } }>) {
      if (t.id && t.court?.name) surfacesMap[t.id] = t.court.name;
    }
    for (const f of enriched as Array<{ tournamentId: number; tournament?: { court?: { name: string } } }>) {
      if (f.tournamentId && f.tournament?.court?.name) surfacesMap[f.tournamentId] = f.tournament.court.name;
    }
    fs.writeFileSync(surfacesPath, JSON.stringify(surfacesMap, null, 2), 'utf-8');
  } catch {}

  return NextResponse.json(result);
}
