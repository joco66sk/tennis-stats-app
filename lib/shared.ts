import fs from 'fs';
import path from 'path';

// ── Environment ────────────────────────────────────────────────────────────────

export const IS_VERCEL = !!process.env.VERCEL;
export const STATIC_CACHE = path.join(process.cwd(), 'cache');
export const STATIC_MATCH_STATS = path.join(process.cwd(), 'app', 'api', 'cache');
export const CACHE_DIR = IS_VERCEL ? '/tmp/cache' : STATIC_CACHE;
export const MATCH_STATS_DIR = IS_VERCEL ? '/tmp/cache' : STATIC_MATCH_STATS;

export const HOST = process.env.RAPIDAPI_HOST || 'tennis-api-atp-wta-itf.p.rapidapi.com';
export const RAPIDAPI_HEADERS = {
  'x-rapidapi-host': HOST,
  'x-rapidapi-key': process.env.RAPIDAPI_KEY ?? '',
};

// ── Surface mapping ────────────────────────────────────────────────────────────

export const COURT_ID_MAP: Record<number, string> = { 1: 'Hard', 2: 'Clay', 3: 'Hard', 5: 'Grass' };

export function normalizeSurface(s: string): string {
  if (s === 'I.hard' || s === 'Carpet') return 'Hard';
  return s;
}

// ── Vercel cold-start cache init ───────────────────────────────────────────────

export function initCache() {
  if (!IS_VERCEL || fs.existsSync(CACHE_DIR)) return;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  for (const srcDir of [STATIC_CACHE, STATIC_MATCH_STATS]) {
    if (!fs.existsSync(srcDir)) continue;
    for (const file of fs.readdirSync(srcDir)) {
      if (/^fixtures-\d{4}-\d{2}-\d{2}\.json$/.test(file)) continue; // always fetch fresh
      try { fs.copyFileSync(path.join(srcDir, file), path.join(CACHE_DIR, file)); } catch {}
    }
  }
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface MatchPlayer {
  id: number;
  name: string;
  countryAcr?: string;
}

export interface Tournament {
  id?: number;
  name: string;
  courtId?: number;
  court?: { name: string };
  rank?: { id: number; name: string };
}

export interface Match {
  id: number;
  date: string;
  result?: string;
  tournamentId: number;
  tournament?: Tournament;
  player1Id: number;
  player2Id: number;
  player1?: MatchPlayer;
  player2?: MatchPlayer;
  match_winner?: number;
}

export interface PlayerStatBlock {
  player1Id?: number;
  player2Id?: number;
  aces: number;
  doubleFaults: number;
  firstServe: number;
  firstServeOf: number;
  winningOnFirstServe: number;
  winningOnSecondServe: number;
  breakPointFacedGm: number;
  breakPointSavedGm: number;
  breakPointChanceGm: number;
  breakPointWonGm: number;
}

export interface MatchStatsData {
  player1Stats: PlayerStatBlock & { player1Id: number };
  player2Stats: PlayerStatBlock & { player2Id: number };
}

export interface PlayerMatchCache {
  matches: Match[];
  cachedAt: number;
  pages: number;
  deepSeeded?: boolean;
  seededAt?: number;
}

// ── Concurrency pool ───────────────────────────────────────────────────────────

export async function pool<T>(fns: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const out: T[] = new Array(fns.length);
  let i = 0;
  async function worker() { while (i < fns.length) { const idx = i++; out[idx] = await fns[idx](); } }
  await Promise.all(Array.from({ length: Math.min(limit, fns.length) }, worker));
  return out;
}
