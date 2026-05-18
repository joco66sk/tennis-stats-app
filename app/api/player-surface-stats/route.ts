import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import {
  IS_VERCEL, CACHE_DIR, MATCH_STATS_DIR, HOST, RAPIDAPI_HEADERS as HEADERS,
  COURT_ID_MAP, initCache, normalizeSurface, pool,
} from '@/lib/shared';

const BASIC_TTL = 4 * 60 * 60 * 1000;
const EMPTY_RETRY_TTL = 60 * 60 * 1000;
const MIN_STATS_DATE = '2025-01-01';
// On Vercel: committed cache is the source of truth — never refresh live.
// Locally: refresh after 7 days.
const REFRESH_TTL = IS_VERCEL ? Infinity : 7 * 24 * 60 * 60 * 1000;

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

  // Merge with existing file to preserve historical matches outside the API's page window.
  const matchCachePath = path.join(CACHE_DIR, `player-matches-${playerId}.json`);
  if (freshMatches.length > 0 && fs.existsSync(matchCachePath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(matchCachePath, 'utf-8')).matches ?? [];
      const ids = new Set(freshMatches.map((m: any) => String(m.id)));
      const historical = existing.filter((m: any) => !ids.has(String(m.id)));
      if (historical.length > 0) freshMatches = [...freshMatches, ...historical];
    } catch {}
  }

  // Dedupe by natural key — the API can return the same match with different IDs
  // depending on which player's endpoint it came from.
  const naturalSeen = new Set<string>();
  freshMatches = freshMatches.filter((m: any) => {
    const p1 = Math.min(m.player1Id || 0, m.player2Id || 0);
    const p2 = Math.max(m.player1Id || 0, m.player2Id || 0);
    const key = `${(m.date || '').slice(0, 10)}-${m.tournamentId}-${p1}-${p2}`;
    if (naturalSeen.has(key)) return false;
    naturalSeen.add(key);
    return true;
  });

  freshMatches.sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return freshMatches;
}

export async function GET(request: NextRequest) {
  initCache();
  const { searchParams } = new URL(request.url);
  const playerId = searchParams.get('playerId');
  const surface = normalizeSurface(searchParams.get('surface') || 'Clay');
  const limitRaw = parseInt(searchParams.get('limit') || '10');
  const limit = isNaN(limitRaw) || limitRaw < 1 ? 10 : Math.min(limitRaw, 50);
  const basic = searchParams.get('basic') === 'true';

  if (!playerId || !/^\d+$/.test(playerId))
    return NextResponse.json({ error: 'playerId must be a positive integer' }, { status: 400 });

  const matchCachePath = path.join(CACHE_DIR, `player-matches-${playerId}.json`);
  const basicCachePath = path.join(CACHE_DIR, `player-surface-basic-${playerId}-${surface}.json`);

  // Basic path: serve cached W/L if fresh. Skip match-stats fetching entirely.
  if (basic && fs.existsSync(basicCachePath)) {
    if (Date.now() - fs.statSync(basicCachePath).mtimeMs < BASIC_TTL)
      return NextResponse.json({ ...JSON.parse(fs.readFileSync(basicCachePath, 'utf-8')), fromCache: true });
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
      if (!IS_VERCEL) {
        const isEmpty = (fileData.matches ?? []).length === 0;
        const fileAge = Date.now() - (fileData.cachedAt ?? fs.statSync(matchCachePath).mtimeMs);
        if (isEmpty && fileAge > EMPTY_RETRY_TTL) { fs.unlinkSync(matchCachePath); needsSeed = true; }
        else if (!basic && !isDeepSeeded && (fileData.pages ?? 1) < 3) needsSeed = true;
        else if (!basic && fileAge > REFRESH_TTL) needsSeed = true;
      }
    } catch { needsSeed = true; }
  }

  if (needsSeed) {
    const pages = basic ? 1 : (isDeepSeeded ? 1 : 3);
    const merged = await fetchAndMergeMatches(playerId, pages);
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const payload: Record<string, unknown> = { matches: merged, cachedAt: Date.now(), pages };
    if (isDeepSeeded) { payload.deepSeeded = true; payload.seededAt = existingSeededAt; }
    fs.writeFileSync(matchCachePath, JSON.stringify(payload, null, 2));
  }

  if (!fs.existsSync(matchCachePath)) return NextResponse.json(emptyResponse(playerId, surface));

  const matchData = JSON.parse(fs.readFileSync(matchCachePath, 'utf-8'));
  const naturalSeen = new Set<string>();
  const allMatches: any[] = (matchData.matches || []).filter((m: any) => {
    const p1 = Math.min(m.player1Id || 0, m.player2Id || 0);
    const p2 = Math.max(m.player1Id || 0, m.player2Id || 0);
    const key = `${(m.date || '').slice(0, 10)}-${m.tournamentId}-${p1}-${p2}`;
    if (naturalSeen.has(key)) return false;
    naturalSeen.add(key);
    return true;
  });
  if (allMatches.length === 0) return NextResponse.json(emptyResponse(playerId, surface));

  const surfaceMap = surface !== 'All' ? loadSurfaceMap() : {};
  const sorted = [...allMatches].sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());
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

  // Full path: fetch match stats for the last N surface matches (max 3 concurrent).
  const allStats = await pool(
    filtered.map(m => () => m.date < MIN_STATS_DATE ? Promise.resolve(null) : getMatchStats(m.tournamentId, m.player1Id, m.player2Id)),
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
    // Use player1Id from inside the stats object — file may be stored in reversed order.
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
      if (oppBpChance > 0) { totalBpSaved += oppBpChance - oppBpWon; totalBpFaced += oppBpChance; }
    }
    const oppSvpt = opp.firstServeOf || 0;
    if (oppSvpt > 0) {
      totalReturnWon += oppSvpt - (opp.winningOnFirstServe || 0) - (opp.winningOnSecondServe || 0);
      totalOppSvpt += oppSvpt;
    }
    const opp1stIn = opp.firstServe || 0;
    if (opp1stIn > 0) { totalReturn1stWon += opp1stIn - (opp.winningOnFirstServe || 0); total1stIn_opp += opp1stIn; }
    const opp2ndPts = oppSvpt - opp1stIn;
    if (opp2ndPts > 0) { totalReturn2ndWon += opp2ndPts - (opp.winningOnSecondServe || 0); total2ndPts_opp += opp2ndPts; }
  }

  return NextResponse.json({
    playerId: pid, playerName, surface, wins, losses, matchesWithStats: statsCount,
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
