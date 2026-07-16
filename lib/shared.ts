import fs from 'fs';
import path from 'path';

// ── Environment ────────────────────────────────────────────────────────────────

export const IS_VERCEL = !!process.env.VERCEL;
export const STATIC_CACHE = path.join(process.cwd(), 'cache');
export const STATIC_MATCH_STATS = path.join(process.cwd(), 'app', 'api', 'cache');
export const CACHE_DIR = IS_VERCEL ? '/tmp/cache' : STATIC_CACHE;
export const MATCH_STATS_DIR = IS_VERCEL ? '/tmp/cache' : STATIC_MATCH_STATS;

export const HOST = process.env.RAPIDAPI_HOST || 'tennisapi1.p.rapidapi.com';
export const RAPIDAPI_HEADERS = {
  'x-rapidapi-host': HOST,
  'x-rapidapi-key': process.env.RAPIDAPI_KEY ?? '',
};

// ── Surface mapping ────────────────────────────────────────────────────────────

export function groundTypeToSurface(groundType?: string): string | null {
  if (!groundType) return null;
  const g = groundType.toLowerCase();
  if (g.includes('clay')) return 'Clay';
  if (g.includes('grass')) return 'Grass';
  if (g.includes('hard')) return 'Hard';
  return null;
}

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

export interface PlayerStatBlock {
  aces: number;
  doubleFaults: number;
  firstServe: number;
  firstServeOf: number;
  winningOnFirstServe: number;
  winningOnSecondServe: number;
  breakPointsFaced: number;
  breakPointsSaved: number;
}

export interface MatchStatsData {
  eventId: number;
  homeId: number;
  awayId: number;
  home: PlayerStatBlock;
  away: PlayerStatBlock;
}
