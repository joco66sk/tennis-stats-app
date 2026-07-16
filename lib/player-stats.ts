import fs from 'fs';
import path from 'path';
import { CACHE_DIR, MATCH_STATS_DIR, initCache } from '@/lib/shared';

const MIN_STATS_DATE = '2024-01-01';

export interface MatchSummary {
  id: string;
  date: string;
  result: string;
  won: boolean;
  opponentName: string;
  tournamentId: number;
  opponentId: number;
  homeId?: number;
}

export interface PlayerSurfaceStats {
  playerId: number;
  playerName: string;
  surface: string;
  wins: number;
  losses: number;
  matchesWithStats: number;
  avg1stServe: number;
  avg1stWon: number;
  avg2ndWon: number;
  avgAces: number;
  avgDf: number;
  avgBpSaved: number;
  avgServeWon: number;
  avgReturnWon: number;
  avgReturn1stWon: number;
  avgReturn2ndWon: number;
  form: boolean[];
  matches: MatchSummary[];
}

function getMatchStats(eventId: number): any | null {
  const file = path.join(MATCH_STATS_DIR, `match-stats-${eventId}.json`);
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch {}
  }
  return null;
}

function empty(playerId: string, surface: string): PlayerSurfaceStats {
  return {
    playerId: parseInt(playerId), playerName: `Player ${playerId}`, surface,
    wins: 0, losses: 0, matchesWithStats: 0,
    avg1stServe: 0, avg1stWon: 0, avg2ndWon: 0, avgAces: 0, avgDf: 0,
    avgBpSaved: 0, avgServeWon: 0, avgReturnWon: 0, avgReturn1stWon: 0, avgReturn2ndWon: 0,
    form: [], matches: [],
  };
}

export function computePlayerSurfaceStats(
  playerId: string,
  surface: string,
  limit = 10,
): PlayerSurfaceStats {
  initCache();

  const pid = parseInt(playerId);
  const indexPath = path.join(CACHE_DIR, `player-index-${playerId}.json`);
  if (!fs.existsSync(indexPath)) return empty(playerId, surface);

  let index: any;
  try { index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')); }
  catch { return empty(playerId, surface); }

  const entries = (index[surface as 'Clay' | 'Hard' | 'Grass'] ?? [])
    .filter((e: any) => e.date >= MIN_STATS_DATE)
    .slice(0, limit);

  const playerName: string = index.playerName ?? `Player ${pid}`;
  if (entries.length === 0) return { ...empty(playerId, surface), playerName };

  let wins = 0, losses = 0, statsCount = 0;
  let total1stIn = 0, total1stWon = 0, total2ndWon = 0, totalSvpt = 0;
  let totalAces = 0, totalDf = 0, totalBpSaved = 0, totalBpFaced = 0;
  let totalReturnWon = 0, totalOppSvpt = 0;
  let totalReturn1stWon = 0, total1stIn_opp = 0;
  let totalReturn2ndWon = 0, total2ndPts_opp = 0;
  const matchList: MatchSummary[] = [];

  for (const e of entries) {
    e.won ? wins++ : losses++;
    matchList.push({
      id: e.id, date: e.date, result: e.result, won: e.won,
      opponentName: e.opponentName, tournamentId: e.tournamentId,
      opponentId: e.opponentId, homeId: e.homeId,
    });

    if (!e.tournamentId) continue;
    const stats = getMatchStats(e.tournamentId);
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

  return {
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
  };
}
