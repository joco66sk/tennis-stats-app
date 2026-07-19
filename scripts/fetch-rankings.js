#!/usr/bin/env node
/**
 * Fetches ATP singles rankings from Sofascore and saves to cache/top-players.json.
 * Called by the cache-update workflow every 30 minutes.
 */

const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env.local');
const env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
const KEY = env.match(/RAPIDAPI_KEY=(.+)/)?.[1]?.trim() || process.env.RAPIDAPI_KEY;
const HOST = env.match(/RAPIDAPI_HOST=(.+)/)?.[1]?.trim() || process.env.RAPIDAPI_HOST || 'tennisapi1.p.rapidapi.com';

if (!KEY) { console.error('RAPIDAPI_KEY not found'); process.exit(1); }

const CACHE_DIR = path.join(__dirname, '..', 'cache');
const HEADERS = { 'x-rapidapi-host': HOST, 'x-rapidapi-key': KEY };
const OUT = path.join(CACHE_DIR, 'top-players.json');

// Only refresh if older than 2 hours
if (fs.existsSync(OUT)) {
  try {
    const { fetchedAt } = JSON.parse(fs.readFileSync(OUT, 'utf-8'));
    if (Date.now() - fetchedAt < 2 * 60 * 60 * 1000) {
      console.log('Rankings cache fresh — skipping');
      process.exit(0);
    }
  } catch {}
}

async function fetchRankings() {
  const candidates = [
    `https://${HOST}/api/tennis/rankings/1`,
    `https://${HOST}/api/tennis/rankings/atp`,
    `https://${HOST}/api/tennis/category/3/rankings`,
  ];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) { console.log(`${url}: HTTP ${res.status}`); continue; }
      const data = await res.json();
      const rows = data.rankings ?? data.rows ?? data;
      if (!Array.isArray(rows) || rows.length < 20) { console.log(`${url}: too few rows (${rows?.length})`); continue; }

      const players = rows.slice(0, 30).map((r, i) => ({
        id: r.team?.id || r.player?.id || r.id,
        name: r.team?.name || r.player?.name || r.name || '',
        ranking: r.ranking || r.rowNumber || i + 1,
      })).filter(p => p.id && p.name);

      if (players.length >= 15) {
        console.log(`Got ${players.length} players from ${url}`);
        return players;
      }
    } catch (e) { console.log(`${url}: ${e.message}`); }
  }
  return null;
}

async function main() {
  const players = await fetchRankings();
  if (!players) {
    console.log('All ranking endpoints failed — keeping existing cache');
    process.exit(0);
  }
  fs.writeFileSync(OUT, JSON.stringify({ players, fetchedAt: Date.now() }, null, 2));
  console.log(`Saved ${players.length} players to top-players.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
