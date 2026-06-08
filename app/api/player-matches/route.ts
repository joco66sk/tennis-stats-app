import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { CACHE_DIR, initCache } from '@/lib/shared';

export function GET(request: NextRequest) {
  initCache();
  const { searchParams } = new URL(request.url);
  const playerId = searchParams.get('playerId');
  if (!playerId || !/^\d+$/.test(playerId))
    return NextResponse.json({ error: 'playerId must be a positive integer' }, { status: 400 });

  const cachePath = path.join(CACHE_DIR, `player-matches-${playerId}.json`);
  if (!fs.existsSync(cachePath))
    return NextResponse.json({ matches: [], fromCache: false });

  const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  return NextResponse.json({ matches: data.matches ?? [], fromCache: true });
}
