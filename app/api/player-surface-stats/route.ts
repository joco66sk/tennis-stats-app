import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { CACHE_DIR, MATCH_STATS_DIR, initCache, normalizeSurface } from '@/lib/shared';

const MIN_STATS_DATE = '2024-01-01';

interface IndexEntry {
  id: string;
  date: string;
  tournamentId: number;
  homeId?: number;
  tournamentName: string;
  opponentId: number;
  opponentName: string;
  won: boolean;
  result: string;
}

interface PlayerIndex {
  playerName?: string;
  Clay: IndexEntry[];
  Hard: IndexEntry[];
  Grass: IndexEntry[];
  updatedAt: number;
}

function emptyResponse(playerId: string, surface: string) {
  return {
    playerId: parseInt(playerId), playerName: `Player ${playerId}`,
    surface, wins: 0, losses: 0, matchesWithStats: 0, matches: [], form: [],
    avg1stServe: 0, avg1stWon: 0, avg2ndWon: 0, avgAces: 0, avgDf: 0,
    avgBpSaved: 0, avgServeWon: 0, avgReturnWon: 0, avgReturn1stWon: 0, avgReturn2ndWon: 0,
  };
}

function getMatchStats(eventId: number): any | null {
  const file = path.join(MATCH_STATS_DIR, `match-stats-${eventId}.json`);
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch {}
  }
  return null;
}

export async function GET(request: NextRequest) {
  initCache();
  const { searchParams } = new URL(request.url);
  const playerId = searchParams.get('playerId');
  const surface = normalizeSurface(searchParams.get('surface') || 'Clay');
  const limitRaw = parseInt(searchParams.get('limit') || '10');
  const limit = isNaN(limitRaw) || limitRaw < 1 ? 10 : Math.min(limitRaw, 10);
  const basic = searchParams.get('basic') === 'true';

  if (!playerId || !/^\d+$/.test(playerId))
    return NextResponse.json({ error: 'playerId must be a positive integer' }, { status: 400 });

  const indexPath = path.join(CACHE_DIR, `player-index-${playerId}.json`);
  if (!fs.existsSync(indexPath)) return NextResponse.json(emptyResponse(playerId, surface));

  let index: PlayerIndex;
  try { index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')); }
  catch { return NextResponse.json(emptyResponse(playerId, surface)); }

  const entries: IndexEntry[] = (index[surface as 'Clay' | 'Hard' | 'Grass'] ?? [])
    .filter(e => e.date >= MIN_STATS_DATE)
    .slice(0, limit);
  if (entries.length === 0) return NextResponse.json({ ...emptyResponse(playerId, surface), playerName: index.playerName ?? `Player ${playerId}` });

  const pid = parseInt(playerId);
  const playerName = index.playerName ?? `Player ${pid}`;

  if (basic) {
    const wins = entries.filter(e => e.won).length;
    const losses = entries.length - wins;
    return NextResponse.json({
      playerId: pid, playerName, surface, wins, losses,
      matchesWithStats: 0, matches: [], form: [],
      avg1stServe: 0, avg1stWon: 0, avg2ndWon: 0, avgAces: 0, avgDf: 0,
      avgBpSaved: 0, avgServeWon: 0, avgReturnWon: 0, avgReturn1stWon: 0, avgReturn2ndWon: 0,
    });
  }

  const allStats = entries.map(e => e.tournamentId ? getMatchStats(e.tournamentId) : null);

  let wins = 0, losses = 0, statsCount = 0;
  let total1stIn = 0, total1stWon = 0, total2ndWon = 0, totalSvpt = 0;
  let totalAces = 0, totalDf = 0, totalBpSaved = 0, totalBpFaced = 0;
  let totalReturnWon = 0, totalOppSvpt = 0;
  let totalReturn1stWon = 0, total1stIn_opp = 0;
  let totalReturn2ndWon = 0, total2ndPts_opp = 0;
  const matchList: any[] = [];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    e.won ? wins++ : losses++;
    matchList.push({
      id: e.id, date: e.date, result: e.result, won: e.won,
      opponentName: e.opponentName, tournamentId: e.tournamentId, opponentId: e.opponentId,
      homeId: e.homeId,
    });

    const stats = allStats[i];
    if (!stats) continue;
    const isHome = stats.homeId === pid;
    const my = isHome ? stats.home : stats.away;
    const opp = isHome ? stats.away : stats.home;
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
      const myBpFaced = my.breakPointsFaced || 0;
      if (myBpFaced > 0) { totalBpSaved += my.breakPointsSaved || 0; totalBpFaced += myBpFaced; }
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
  });
}
