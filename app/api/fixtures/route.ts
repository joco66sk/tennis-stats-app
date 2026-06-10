import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { CACHE_DIR, STATIC_CACHE, HOST, RAPIDAPI_HEADERS, initCache } from '@/lib/shared';

async function safeFetch(url: string): Promise<{ data?: unknown[] }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: RAPIDAPI_HEADERS, next: { revalidate: 3600 } });
      if (!res.ok) return { data: [] };
      const json = await res.json() as { data?: unknown[] };
      if ((json.data?.length ?? 0) > 0 || attempt === 1) return json;
      await new Promise(r => setTimeout(r, 1000));
    } catch {
      if (attempt === 1) return { data: [] };
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return { data: [] };
}

function getCacheTTL(date: string): number {
  const cetNow = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const today = cetNow.toISOString().split('T')[0];
  const tomorrow = new Date(cetNow.getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  if (date < today) return 24 * 60 * 60 * 1000;
  if (date === today) return 60 * 60 * 1000;    // today: 1h (schedule changes throughout day)
  if (date === tomorrow) return 45 * 60 * 1000; // tomorrow: 45min
  return 30 * 60 * 1000;
}

// Uses fetchedAt embedded in JSON so mtime from git checkout / initCache copy doesn't matter.
// Past dates served unconditionally (completed data never changes).
function readFreshCache(date: string): string | null {
  const cetNow = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const today = cetNow.toISOString().split('T')[0];
  const fp = path.join(CACHE_DIR, `fixtures-${date}.json`);
  if (!fs.existsSync(fp)) return null;
  try {
    const raw = fs.readFileSync(fp, 'utf-8');
    if (date < today) return raw; // past dates: static cache is authoritative
    const data = JSON.parse(raw) as { fetchedAt?: number };
    if (!data.fetchedAt) return null; // no timestamp → treat as stale
    return Date.now() - data.fetchedAt < getCacheTTL(date) ? raw : null;
  } catch { return null; }
}

// Stale fallback: any non-empty file from /tmp/cache or static cache
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

  const [atpPage1, atpPage2, atpPage3] = await Promise.all([
    safeFetch(`https://${HOST}/tennis/v2/atp/fixtures/${date}?include=tournament,tournament.court,tournament.rank,round&filter=PlayerGroup:singles&pageSize=50&pageNo=1`),
    safeFetch(`https://${HOST}/tennis/v2/atp/fixtures/${date}?include=tournament,tournament.court,tournament.rank,round&filter=PlayerGroup:singles&pageSize=50&pageNo=2`),
    safeFetch(`https://${HOST}/tennis/v2/atp/fixtures/${date}?include=tournament,tournament.court,tournament.rank,round&filter=PlayerGroup:singles&pageSize=50&pageNo=3`),
  ]);

  const toArr = (d: { data?: unknown[] }) => d.data ?? [];

  const seen = new Set<number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allFixtures: any[] = ([...toArr(atpPage1), ...toArr(atpPage2), ...toArr(atpPage3)] as any[])
    .filter(f => { if (seen.has(f.id)) return false; seen.add(f.id); return true; });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const enriched: any[] = allFixtures
    .filter(f => !String(f.player1?.name ?? '').includes('/') && !String(f.player2?.name ?? '').includes('/'))
    .sort((a, b) => (b.tournament?.rank?.id ?? 0) - (a.tournament?.rank?.id ?? 0));

  // Never overwrite a non-empty cache with zero results (API may be rate-limited)
  if (enriched.length === 0) {
    const stale = readStaleCache(date);
    if (stale) {
      const existing = JSON.parse(stale) as { fixtures?: unknown[] };
      console.log(`API returned 0 fixtures, keeping cached ${existing.fixtures!.length}`);
      return NextResponse.json(existing);
    }
  }

  const result = { date, fixtures: enriched, count: enriched.length, fetchedAt: Date.now() };
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, `fixtures-${date}.json`);
  fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf-8');

  // Persist tournament → surface map
  try {
    const year = cetNow.getFullYear();
    const surfacesPath = path.join(CACHE_DIR, `surfaces-${year}.json`);
    const surfacesMap: Record<number, string> = fs.existsSync(surfacesPath)
      ? JSON.parse(fs.readFileSync(surfacesPath, 'utf-8')) as Record<number, string>
      : {};
    for (const f of enriched as Array<{ tournamentId: number; tournament?: { court?: { name: string } } }>) {
      if (f.tournamentId && f.tournament?.court?.name) surfacesMap[f.tournamentId] = f.tournament.court.name;
    }
    fs.writeFileSync(surfacesPath, JSON.stringify(surfacesMap, null, 2), 'utf-8');
  } catch {}

  return NextResponse.json(result);
}
