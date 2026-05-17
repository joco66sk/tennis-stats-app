import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';

const IS_VERCEL = !!process.env.VERCEL;
const STATIC_CACHE = path.join(process.cwd(), 'cache');
const STATIC_MATCH_STATS = path.join(process.cwd(), 'app', 'api', 'cache');
const CACHE_DIR = IS_VERCEL ? '/tmp/cache' : STATIC_CACHE;
const MATCH_STATS_DIR = IS_VERCEL ? '/tmp/cache' : STATIC_MATCH_STATS;

function initCache() {
  if (!IS_VERCEL || fs.existsSync(CACHE_DIR)) return;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  for (const srcDir of [STATIC_CACHE, STATIC_MATCH_STATS]) {
    if (!fs.existsSync(srcDir)) continue;
    for (const file of fs.readdirSync(srcDir)) {
      try { fs.copyFileSync(path.join(srcDir, file), path.join(CACHE_DIR, file)); } catch {}
    }
  }
}
const HOST = process.env.RAPIDAPI_HOST || 'tennis-api-atp-wta-itf.p.rapidapi.com';
const HEADERS = {
  'x-rapidapi-host': HOST,
  'x-rapidapi-key': process.env.RAPIDAPI_KEY!,
};

// courtId is always populated; court.name is sometimes null.
const COURT_ID_MAP: Record<number, string> = { 1: 'Hard', 2: 'Clay', 3: 'Hard', 5: 'Grass' };

function normalizeSurface(s: string): string {
  if (s === 'I.hard' || s === 'Carpet') return 'Hard';
  return s;
}

function loadSurfaceMap(): Record<number, string> {
  const map: Record<number, string> = {};
  if (!fs.existsSync(CACHE_DIR)) return map;
  try {
    for (const file of fs.readdirSync(CACHE_DIR)) {
      if (!/^surfaces-\d{4}\.json$/.test(file)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf-8'));
        for (const [id, surface] of Object.entries(data))
          map[parseInt(id)] = normalizeSurface(surface as string);
      } catch {}
    }
  } catch {}
  return map;
}

// Priority: courtId (always present) → court.name → surfaces-YYYY.json fallback
function getMatchSurface(m: any, surfaceMap: Record<number, string>): string | null {
  const fromCourtId = COURT_ID_MAP[m.tournament?.courtId];
  if (fromCourtId) return fromCourtId;
  const fromName = m.tournament?.court?.name;
  if (fromName) return normalizeSurface(fromName);
  return surfaceMap[m.tournamentId] ?? null;
}

function emptyResponse(playerId: string, surface: string) {
  return {
    playerId: parseInt(playerId), playerName: `Player ${playerId}`,
    surface, wins: 0, losses: 0, matchesWithStats: 0, matches: [], form: [],
    avg1stServe: 0, avg1stWon: 0, avg2ndWon: 0, avgAces: 0, avgDf: 0,
    avgBpSaved: 0, avgServeWon: 0, avgReturnWon: 0, avgReturn1stWon: 0, avgReturn2ndWon: 0,
  };
}

async function getMatchStats(tournamentId: number, p1: number, p2: number): Promise<any | null> {
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

async function fetchAndMergeMatches(playerId: string, pages = 3): Promise<any[]> {
  let freshMatches: any[] = [];
  try {
    const reqs = Array.from({ length: pages }, (_, i) =>
      fetch(`https://${HOST}/tennis/v2/atp/player/past-matches/${playerId}?pageSize=100&pageNo=${i + 1}&include=tournament,tournament.court`, { headers: HEADERS, signal: AbortSignal.timeout(10000) })
    );
    const responses = await Promise.all(reqs);
    const jsons = await Promise.all(responses.map(r => r.json().catch(() => ({}))));
    const seen = new Set<string>();
    freshMatches = jsons.flatMap((d: any) => d.data ?? []).filter((m: any) => {
      if (seen.has(String(m.id))) return false;
      seen.add(String(m.id));
      return true;
    });
  } catch {}

  // Supplement with reverse lookup — catches API lag where a player's recent matches
  // appear in opponents' files before showing in their own endpoint.
  const pid = parseInt(playerId);
  const freshIds = new Set<string>(freshMatches.map((m: any) => String(m.id)));
  try {
    for (const file of fs.readdirSync(CACHE_DIR)) {
      if (!file.startsWith('player-matches-') || file === `player-matches-${playerId}.json`) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf-8'));
        for (const m of (data.matches ?? [])) {
          if ((m.player1Id === pid || m.player2Id === pid) && !freshIds.has(String(m.id))) {
            freshIds.add(String(m.id));
            freshMatches.push(m);
          }
        }
      } catch {}
    }
  } catch {}

  freshMatches.sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // Supplement fresh data with historical matches from the existing file that fall
  // outside the API's 3-page window. Fresh data always takes precedence — never
  // return the old file when we have a valid fresh fetch.
  const matchCachePath = path.join(CACHE_DIR, `player-matches-${playerId}.json`);
  if (freshMatches.length > 0 && fs.existsSync(matchCachePath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(matchCachePath, 'utf-8')).matches ?? [];
      const freshIds = new Set(freshMatches.map((m: any) => String(m.id)));
      const historicalOnly = existing.filter((m: any) => !freshIds.has(String(m.id)));
      if (historicalOnly.length > 0) {
        freshMatches = [...freshMatches, ...historicalOnly].sort(
          (a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime()
        );
      }
    } catch {}
  }

  return freshMatches;
}

export async function GET(request: NextRequest) {
  initCache();
  const { searchParams } = new URL(request.url);
  const playerId = searchParams.get('playerId');
  const surface = searchParams.get('surface') || 'Clay';
  const limit = parseInt(searchParams.get('limit') || '10');
  const basic = searchParams.get('basic') === 'true';

  if (!playerId) return NextResponse.json({ error: 'playerId required' }, { status: 400 });

  const matchCachePath = path.join(CACHE_DIR, `player-matches-${playerId}.json`);
  const basicCachePath = path.join(CACHE_DIR, `player-surface-basic-${playerId}-${surface}.json`);
  const BASIC_TTL = 4 * 60 * 60 * 1000;
  const EMPTY_RETRY_TTL = 60 * 60 * 1000;
  const REFRESH_TTL = 24 * 60 * 60 * 1000;

  // Basic path: serve cached W/L if fresh (4h TTL). Skip re-seeding for fixture page speed.
  if (basic && fs.existsSync(basicCachePath)) {
    const age = Date.now() - fs.statSync(basicCachePath).mtimeMs;
    if (age < BASIC_TTL) {
      return NextResponse.json({ ...JSON.parse(fs.readFileSync(basicCachePath, 'utf-8')), fromCache: true });
    }
  }

  // Decide whether to refresh player-matches from API.
  let needsSeed = !fs.existsSync(matchCachePath);
  let isDeepSeeded = false;
  let existingSeededAt: number | undefined;
  if (!needsSeed) {
    try {
      const fileData = JSON.parse(fs.readFileSync(matchCachePath, 'utf-8'));
      isDeepSeeded = fileData.deepSeeded === true;
      existingSeededAt = fileData.seededAt;
      const isEmpty = (fileData.matches ?? []).length === 0;
      const fileAge = Date.now() - (fileData.cachedAt ?? fs.statSync(matchCachePath).mtimeMs);
      if (isEmpty && fileAge > EMPTY_RETRY_TTL) { fs.unlinkSync(matchCachePath); needsSeed = true; }
      // deepSeeded files have full history — only a 1-page delta needed when stale
      else if (!basic && !isDeepSeeded && (fileData.pages ?? 1) < 3) needsSeed = true;
      else if (!basic && fileAge > REFRESH_TTL) needsSeed = true;
    } catch { needsSeed = true; }
  }

  // deepSeeded: delta update (1 page). Non-deep: 3 pages for compare, 1 for basic.
  const pagesNeeded = basic ? 1 : (isDeepSeeded ? 1 : 3);

  if (needsSeed) {
    const merged = await fetchAndMergeMatches(playerId, pagesNeeded);
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const payload: Record<string, unknown> = { matches: merged, cachedAt: Date.now(), pages: pagesNeeded };
    if (isDeepSeeded) { payload.deepSeeded = true; payload.seededAt = existingSeededAt; }
    fs.writeFileSync(matchCachePath, JSON.stringify(payload, null, 2));
  }

  if (!fs.existsSync(matchCachePath)) return NextResponse.json(emptyResponse(playerId, surface));

  const matchData = JSON.parse(fs.readFileSync(matchCachePath, 'utf-8'));
  const allMatches: any[] = matchData.matches || [];

  if (allMatches.length === 0) return NextResponse.json(emptyResponse(playerId, surface));

  // Sort by date descending, assign surface via courtId, filter, take last N.
  const surfaceMap = surface !== 'All' ? loadSurfaceMap() : {};
  const sorted = [...allMatches].sort(
    (a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );
  const filtered = surface === 'All'
    ? sorted.slice(0, limit)
    : sorted.filter(m => getMatchSurface(m, surfaceMap) === surface).slice(0, limit);

  const pid = parseInt(playerId);
  const nameRef = allMatches.find(m => m.player1Id === pid || m.player2Id === pid) ?? allMatches[0];
  const playerName: string = nameRef
    ? ((nameRef.player1Id === pid ? nameRef.player1?.name : nameRef.player2?.name) ?? `Player ${pid}`)
    : `Player ${pid}`;

  // Basic path: count W/L only, no match-stats API calls.
  if (basic) {
    const wins = filtered.filter(m => m.match_winner === pid).length;
    const losses = filtered.length - wins;
    const result = { playerId: pid, playerName, surface, wins, losses, matchesWithStats: 0, matches: [], form: [] };
    if (wins + losses > 0) {
      try {
        if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(basicCachePath, JSON.stringify(result, null, 2));
      } catch {}
    }
    return NextResponse.json(result);
  }

  // Full path: fetch match stats for the last N surface matches.
  // Concurrency limited to 3 to avoid rate-limiting on parallel API calls.
  async function pool<T>(fns: Array<() => Promise<T>>, limit: number): Promise<T[]> {
    const out: T[] = new Array(fns.length);
    let i = 0;
    async function worker() { while (i < fns.length) { const idx = i++; out[idx] = await fns[idx](); } }
    await Promise.all(Array.from({ length: Math.min(limit, fns.length) }, worker));
    return out;
  }
  const allStats = await pool(
    filtered.map(m => () => getMatchStats(m.tournamentId, m.player1Id, m.player2Id)),
    3
  );

  let wins = 0, losses = 0, statsCount = 0;
  let total1stIn = 0, total1stWon = 0, total2ndWon = 0, totalSvpt = 0;
  let totalAces = 0, totalDf = 0, totalBpSaved = 0, totalBpFaced = 0;
  let totalReturnWon = 0, totalOppSvpt = 0;
  let totalReturn1stWon = 0, total1stIn_opp = 0;
  let totalReturn2ndWon = 0, total2ndPts_opp = 0;
  const matchList: any[] = [];

  for (let i = 0; i < filtered.length; i++) {
    const m = filtered[i];
    const won = m.match_winner === pid;
    won ? wins++ : losses++;
    matchList.push({
      id: String(m.id),
      date: m.date,
      result: m.result,
      won,
      opponentName: m.player1Id === pid ? m.player2?.name : m.player1?.name,
      opponentCountry: m.player1Id === pid ? m.player2?.countryAcr : m.player1?.countryAcr,
    });

    const stats = allStats[i];
    if (!stats) continue;
    // Use playerId from inside the stats object — file may be stored in reversed order
    // so m.player1Id === pid is unreliable when stats were fetched via the swapped API call.
    const isP1 = stats.player1Stats?.player1Id === pid;
    const my = isP1 ? stats.player1Stats : stats.player2Stats;
    const opp = isP1 ? stats.player2Stats : stats.player1Stats;
    if (!my || !opp) continue;

    const svpt = my.firstServeOf || 0;
    if (svpt > 0) {
      statsCount++;
      totalAces += my.aces || 0;
      totalDf += my.doubleFaults || 0;
      total1stIn += my.firstServe || 0;
      total1stWon += my.winningOnFirstServe || 0;
      total2ndWon += my.winningOnSecondServe || 0;
      totalSvpt += svpt;
      const oppBpChance = opp.breakPointChanceGm || 0;
      const oppBpWon = opp.breakPointWonGm || 0;
      if (oppBpChance > 0) {
        totalBpSaved += oppBpChance - oppBpWon;
        totalBpFaced += oppBpChance;
      }
    }
    const oppSvpt = opp.firstServeOf || 0;
    if (oppSvpt > 0) {
      totalReturnWon += oppSvpt - (opp.winningOnFirstServe || 0) - (opp.winningOnSecondServe || 0);
      totalOppSvpt += oppSvpt;
    }
    const opp1stIn = opp.firstServe || 0;
    if (opp1stIn > 0) {
      totalReturn1stWon += opp1stIn - (opp.winningOnFirstServe || 0);
      total1stIn_opp += opp1stIn;
    }
    const opp2ndPts = oppSvpt - (opp.firstServe || 0);
    if (opp2ndPts > 0) {
      totalReturn2ndWon += opp2ndPts - (opp.winningOnSecondServe || 0);
      total2ndPts_opp += opp2ndPts;
    }
  }

  return NextResponse.json({
    playerId: pid,
    playerName,
    surface,
    wins,
    losses,
    matchesWithStats: statsCount,
    avg1stServe: totalSvpt ? (total1stIn / totalSvpt) * 100 : 0,
    avg1stWon: total1stIn ? (total1stWon / total1stIn) * 100 : 0,
    avg2ndWon: (totalSvpt - total1stIn) > 0 ? (total2ndWon / (totalSvpt - total1stIn)) * 100 : 0,
    avgAces: statsCount ? totalAces / statsCount : 0,
    avgDf: statsCount ? totalDf / statsCount : 0,
    avgBpSaved: totalBpFaced ? (totalBpSaved / totalBpFaced) * 100 : 0,
    avgServeWon: totalSvpt ? ((total1stWon + total2ndWon) / totalSvpt) * 100 : 0,
    avgReturnWon: totalOppSvpt ? (totalReturnWon / totalOppSvpt) * 100 : 0,
    avgReturn1stWon: total1stIn_opp ? (totalReturn1stWon / total1stIn_opp) * 100 : 0,
    avgReturn2ndWon: total2ndPts_opp ? (totalReturn2ndWon / total2ndPts_opp) * 100 : 0,
    form: matchList.slice(0, 5).map(m => m.won),
    matches: matchList,
    fromCache: false,
  });
}
