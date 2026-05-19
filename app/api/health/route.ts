import { NextResponse } from 'next/server';
import fs from 'fs';
import { CACHE_DIR, MATCH_STATS_DIR, IS_VERCEL, HOST } from '@/lib/shared';

export async function GET() {
  const apiKeySet = !!process.env.RAPIDAPI_KEY;

  let cacheFiles = 0;
  let fixtureFiles = 0;
  let playerFiles = 0;
  let matchStatFiles = 0;
  try {
    const files = fs.readdirSync(CACHE_DIR);
    cacheFiles = files.length;
    fixtureFiles = files.filter(f => f.startsWith('fixtures-')).length;
    playerFiles = files.filter(f => f.startsWith('player-index-')).length;
  } catch {}
  try {
    const statsDir = MATCH_STATS_DIR === CACHE_DIR ? null : MATCH_STATS_DIR;
    const statsFiles = statsDir ? fs.readdirSync(statsDir) : fs.readdirSync(CACHE_DIR);
    matchStatFiles = statsFiles.filter(f => f.startsWith('match-stats-')).length;
  } catch {}

  return NextResponse.json({
    ok: apiKeySet,
    env: IS_VERCEL ? 'vercel' : 'local',
    apiHost: HOST,
    apiKeySet,
    cache: { dir: CACHE_DIR, total: cacheFiles, fixtures: fixtureFiles, players: playerFiles, matchStats: matchStatFiles },
  });
}
