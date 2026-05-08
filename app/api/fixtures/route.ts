// app/api/fixtures/route.ts
import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';

const API_KEY = process.env.RAPIDAPI_KEY!;
const HOST = process.env.RAPIDAPI_HOST || 'tennis-api-atp-wta-itf.p.rapidapi.com';

const HEADERS = {
  'x-rapidapi-host': HOST,
  'x-rapidapi-key': API_KEY,
};

const CACHE_DIR = path.join(process.cwd(), 'cache');

async function safeFetch(url: string): Promise<any> {
  try {
    const res = await fetch(url, { 
      headers: HEADERS,
      next: { revalidate: 3600 } // fallback cache
    });
    
    if (!res.ok) return { data: [] };
    return await res.json();
  } catch (err) {
    console.error('API fetch error:', err);
    return { data: [] };
  }
}

function getCacheFilePath(date: string) {
  return path.join(CACHE_DIR, `fixtures-${date}.json`);
}

function getCacheTTL(date: string): number {
  const cetNow = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const today = cetNow.toISOString().split('T')[0];
  const tomorrow = new Date(cetNow.getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  if (date < today) return 24 * 60 * 60 * 1000;        // past: 24h
  if (date === today) return 2 * 60 * 60 * 1000;       // today: 2h
  if (date === tomorrow) return 45 * 60 * 1000;        // tomorrow: 45 min
  return 20 * 60 * 1000;                               // future: 20 min
}

function isCacheValid(filePath: string, date: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const stats = fs.statSync(filePath);
  const ageMs = Date.now() - stats.mtimeMs;
  return ageMs < getCacheTTL(date);
}

function readCache(filePath: string) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw);
}

function writeCache(filePath: string, data: any) {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const forceRefresh = searchParams.get('refresh') === 'true';

  // CET time for "today"
  const now = new Date();
  const cetTime = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const date = searchParams.get('date') || cetTime.toISOString().split('T')[0];

  const cacheFile = getCacheFilePath(date);

  if (!forceRefresh && isCacheValid(cacheFile, date)) {
    console.log(`✅ Serving cached fixtures for ${date}`);
    return NextResponse.json(readCache(cacheFile));
  }

  console.log(`🔄 Fetching fresh fixtures for ${date}`);

  const year = new Date().getFullYear();
  const [atpPage1, atpPage2, atpPage3, cal1, cal2, cal3] = await Promise.all([
    safeFetch(`https://${HOST}/tennis/v2/atp/fixtures/${date}?include=tournament,tournament.court,tournament.rank,round&filter=PlayerGroup:singles&pageSize=50&pageNo=1`),
    safeFetch(`https://${HOST}/tennis/v2/atp/fixtures/${date}?include=tournament,tournament.court,tournament.rank,round&filter=PlayerGroup:singles&pageSize=50&pageNo=2`),
    safeFetch(`https://${HOST}/tennis/v2/atp/fixtures/${date}?include=tournament,tournament.court,tournament.rank,round&filter=PlayerGroup:singles&pageSize=50&pageNo=3`),
    safeFetch(`https://${HOST}/tennis/v2/atp/tournament/calendar/${year}?include=court&pageSize=50&pageNo=1`),
    safeFetch(`https://${HOST}/tennis/v2/atp/tournament/calendar/${year}?include=court&pageSize=50&pageNo=2`),
    safeFetch(`https://${HOST}/tennis/v2/atp/tournament/calendar/${year}?include=court&pageSize=50&pageNo=3`),
  ]);

  const toArray = (data: any): any[] => Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];

  const calendarData = [...toArray(cal1), ...toArray(cal2), ...toArray(cal3)];
  const calendarMap: Record<number, any> = {};
  calendarData.forEach((t: any) => {
    calendarMap[t.id] = t;
  });

  let allFixtures = [
    ...toArray(atpPage1),
    ...toArray(atpPage2),
    ...toArray(atpPage3),
  ];

  // Deduplicate
  const seen = new Set();
  allFixtures = allFixtures.filter(f => {
    if (seen.has(f.id)) return false;
    seen.add(f.id);
    return true;
  });

  // Enrich with better tournament rank
  const enriched = allFixtures.map((f: any) => ({
    ...f,
    tournament: {
      ...f.tournament,
      rank: calendarMap[f.tournamentId]?.rank || f.tournament?.rank,
    }
  }));

  // Sort: better tournaments first (higher rank id = more important usually)
  enriched.sort((a: any, b: any) => {
    const rankA = a.tournament?.rank?.id || 0;
    const rankB = b.tournament?.rank?.id || 0;
    return rankB - rankA;
  });

  // Never overwrite a non-empty cache with zero results — API may be temporarily rate-limited.
  if (enriched.length === 0 && fs.existsSync(cacheFile)) {
    const existing = readCache(cacheFile);
    if ((existing.fixtures?.length ?? 0) > 0) {
      console.log(`⚠️ API returned 0 fixtures but cache has ${existing.fixtures.length} — keeping cache`);
      return NextResponse.json(existing);
    }
  }

  const result = {
    date,
    fixtures: enriched,
    count: enriched.length
  };

  writeCache(cacheFile, result);

  // Persist tournament → surface map from calendar so player-surface-matches can use it
  try {
    const surfacesPath = path.join(CACHE_DIR, `surfaces-${year}.json`);
    let surfacesMap: Record<number, string> = {};
    if (fs.existsSync(surfacesPath)) {
      surfacesMap = JSON.parse(fs.readFileSync(surfacesPath, 'utf-8'));
    }
    calendarData.forEach((t: any) => {
      if (t.id && t.court?.name) surfacesMap[t.id] = t.court.name;
    });
    // Also pick up surfaces from today's fixtures in case calendar is missing any
    enriched.forEach((f: any) => {
      if (f.tournamentId && f.tournament?.court?.name) {
        surfacesMap[f.tournamentId] = f.tournament.court.name;
      }
    });
    fs.writeFileSync(surfacesPath, JSON.stringify(surfacesMap, null, 2), 'utf-8');
  } catch {}

  return NextResponse.json(result);
}