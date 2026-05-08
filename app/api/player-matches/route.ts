import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';

const HOST = process.env.RAPIDAPI_HOST || 'tennis-api-atp-wta-itf.p.rapidapi.com';
const HEADERS = {
  'x-rapidapi-host': HOST,
  'x-rapidapi-key': process.env.RAPIDAPI_KEY!,
};
const CACHE_DIR = path.join(process.cwd(), 'cache');

function getCachePath(playerId: string) {
  return path.join(CACHE_DIR, `player-matches-${playerId}.json`);
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const playerId = searchParams.get('playerId');
  if (!playerId) return NextResponse.json({ error: 'playerId required' }, { status: 400 });

  const cachePath = getCachePath(playerId);
  const existing = fs.existsSync(cachePath)
    ? JSON.parse(fs.readFileSync(cachePath, 'utf-8'))
    : null;

  let freshMatches: any[] = [];
  let apiSuccess = false;
  try {
    const [res1, res2, res3] = await Promise.all([
      fetch(`https://${HOST}/tennis/v2/atp/player/past-matches/${playerId}?pageSize=100&pageNo=1&include=tournament,tournament.court`, { headers: HEADERS }),
      fetch(`https://${HOST}/tennis/v2/atp/player/past-matches/${playerId}?pageSize=100&pageNo=2&include=tournament,tournament.court`, { headers: HEADERS }),
      fetch(`https://${HOST}/tennis/v2/atp/player/past-matches/${playerId}?pageSize=100&pageNo=3&include=tournament,tournament.court`, { headers: HEADERS }),
    ]);
    apiSuccess = res1.ok || res2.ok || res3.ok;
    const [d1, d2, d3] = await Promise.all([res1.json(), res2.json(), res3.json()]);
    const seen = new Set();
    freshMatches = [...(d1.data ?? []), ...(d2.data ?? []), ...(d3.data ?? [])].filter((m: any) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  } catch (err) {
    if (existing) return NextResponse.json({ matches: existing.matches, fromCache: true });
    return NextResponse.json({ error: 'Failed to fetch matches from API' }, { status: 502 });
  }

  if (!existing) {
    freshMatches.sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());
    // Don't write an empty file if the API itself failed — prevents blocking future retries.
    if (freshMatches.length === 0 && !apiSuccess) {
      return NextResponse.json({ matches: [], fromCache: false });
    }
    const data = { matches: freshMatches, cachedAt: Date.now() };
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));
    return NextResponse.json({ matches: freshMatches, fromCache: false });
  }

  const cachedIds = new Set(existing.matches.map((m: any) => m.id));
  const newMatches = freshMatches.filter((m: any) => !cachedIds.has(m.id));

  if (newMatches.length > 0) {
    const merged = [...newMatches, ...existing.matches]
      .sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());
    fs.writeFileSync(cachePath, JSON.stringify({ matches: merged, cachedAt: Date.now() }, null, 2));
    return NextResponse.json({ matches: merged, fromCache: false, newMatches: newMatches.length });
  }

  return NextResponse.json({ matches: existing.matches, fromCache: true });
}
