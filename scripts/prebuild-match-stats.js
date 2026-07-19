#!/usr/bin/env node
/**
 * Pre-builds match-stats cache for players in fixture files.
 * Fetches serve/return stats for each player's last N clay/hard/grass matches.
 *
 * Usage:
 *   node scripts/prebuild-match-stats.js             (today)
 *   node scripts/prebuild-match-stats.js 2026-05-09  (specific date)
 *   node scripts/prebuild-match-stats.js upcoming    (next 5 days)
 *   node scripts/prebuild-match-stats.js all         (all dates)
 */

const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env.local');
const env = fs.readFileSync(envPath, 'utf-8');
const KEY = env.match(/RAPIDAPI_KEY=(.+)/)?.[1]?.trim();
const HOST = env.match(/RAPIDAPI_HOST=(.+)/)?.[1]?.trim() || 'tennisapi1.p.rapidapi.com';

if (!KEY) { console.error('RAPIDAPI_KEY not found in .env.local'); process.exit(1); }

const CACHE_DIR = path.join(__dirname, '..', 'cache');
const MATCH_STATS_DIR = path.join(__dirname, '..', 'app', 'api', 'cache');
const HEADERS = { 'x-rapidapi-host': HOST, 'x-rapidapi-key': KEY };

const ALL_SURFACES = ['Clay', 'Hard', 'Grass'];
const LAST_N = 10;
const MIN_DATE = '2024-01-01';
const DELAY = 400;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getTodayStr() {
  return new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().split('T')[0];
}

function getPlayerIdsFromFixtures(dates) {
  const ids = new Set();
  for (const date of dates) {
    const fp = path.join(CACHE_DIR, `fixtures-${date}.json`);
    if (!fs.existsSync(fp)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      for (const f of (data.fixtures || [])) {
        if ((f.player1?.name ?? '').includes('/') || (f.player2?.name ?? '').includes('/')) continue;
        if (f.player1?.id) ids.add(String(f.player1.id));
        if (f.player2?.id) ids.add(String(f.player2.id));
      }
    } catch {}
  }
  return [...ids];
}

// Parse Sofascore statistics response into our normalized format
function parseMatchStats(raw, homeId, awayId, eventId) {
  const allPeriod = raw.statistics?.find(s => s.period === 'ALL');
  if (!allPeriod) return null;

  const allItems = allPeriod.groups.flatMap(g => g.statisticsItems);
  const getStat = (key) => allItems.find(i => i.key === key);

  const fsa  = getStat('firstServeAccuracy');
  const fspa = getStat('firstServePointsAccuracy');
  const sspa = getStat('secondServePointsAccuracy');
  const acesS = getStat('aces');
  const dfS  = getStat('doubleFaults');
  const bpsS = getStat('breakPointsSaved');

  if (!fsa) return null;

  const extract = (side) => ({
    firstServeOf: fsa?.[`${side}Total`] ?? 0,
    firstServe: fsa?.[`${side}Value`] ?? 0,
    winningOnFirstServe: fspa?.[`${side}Value`] ?? 0,
    winningOnSecondServe: sspa?.[`${side}Value`] ?? 0,
    aces: acesS?.[`${side}Value`] ?? 0,
    doubleFaults: dfS?.[`${side}Value`] ?? 0,
    breakPointsFaced: bpsS?.[`${side}Total`] ?? 0,
    breakPointsSaved: bpsS?.[`${side}Value`] ?? 0,
  });

  return { eventId, homeId, awayId, home: extract('home'), away: extract('away') };
}

async function fetchStats(eventId, homeId, awayId) {
  const file = path.join(MATCH_STATS_DIR, `match-stats-${eventId}.json`);
  if (fs.existsSync(file)) return 'cached';

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(
        `https://${HOST}/api/tennis/event/${eventId}/statistics`,
        { headers: HEADERS }
      );
      if (res.status === 429) {
        const wait = attempt * 15000;
        console.log(`    rate limited — waiting ${wait / 1000}s before retry ${attempt}/3`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) break;
      const raw = await res.json();
      const parsed = parseMatchStats(raw, homeId, awayId, eventId);
      if (parsed) {
        fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
        return 'fetched';
      }
      break;
    } catch { break; }
  }
  return 'none';
}

async function main() {
  if (!fs.existsSync(MATCH_STATS_DIR)) fs.mkdirSync(MATCH_STATS_DIR, { recursive: true });

  const surfaceArg = process.argv.find(a => a.startsWith('--surface='))?.split('=')[1]
    || (process.argv.includes('--surface') ? process.argv[process.argv.indexOf('--surface') + 1] : null);
  const clayOnly = process.argv.includes('--clay-only');
  let surfaces = clayOnly ? ['Clay'] : surfaceArg ? [surfaceArg] : ALL_SURFACES;

  const args = process.argv.slice(2).filter(a =>
    a !== '--clay-only' && !a.startsWith('--surface') &&
    process.argv.indexOf(a) !== process.argv.indexOf('--surface') + 1
  );
  const arg = args[0];
  let dates = [];

  if (!arg || arg === 'today') {
    dates = [getTodayStr()];
  } else if (arg === 'upcoming') {
    dates = Array.from({ length: 5 }, (_, d) => {
      const dt = new Date(Date.now() + 2 * 60 * 60 * 1000 + d * 86400000);
      return dt.toISOString().split('T')[0];
    }).filter(d => fs.existsSync(path.join(CACHE_DIR, `fixtures-${d}.json`)));
    console.log(`Upcoming dates: ${dates.join(', ')}`);
    if (!surfaceArg && !clayOnly) {
      const detected = new Set();
      for (const date of dates) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `fixtures-${date}.json`), 'utf-8'));
          for (const f of (data.fixtures || [])) {
            const s = f.tournament?.court?.name;
            if (s) detected.add(s);
          }
        } catch {}
      }
      if (detected.size > 0) surfaces = [...detected];
    }
  } else if (arg === 'all') {
    dates = fs.readdirSync(CACHE_DIR)
      .filter(f => /^fixtures-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.replace('fixtures-', '').replace('.json', ''))
      .sort();
  } else if (arg !== 'recent') {
    dates = [arg];
  }

  if (surfaces.length < ALL_SURFACES.length) console.log(`Surface filter: ${surfaces.join(', ')} only`);

  const playerArg = process.argv.find(a => a.startsWith('--player='))?.split('=')[1];
  const hoursArg = parseInt(process.argv.find(a => a.startsWith('--hours='))?.split('=')[1] || '2');

  let playerIds;
  if (playerArg) {
    playerIds = playerArg.split(',').map(s => s.trim());
    console.log(`Player mode: ${playerIds.join(', ')}`);
  } else if (arg === 'recent') {
    const cutoff = Date.now() - hoursArg * 60 * 60 * 1000;
    playerIds = fs.readdirSync(CACHE_DIR)
      .filter(f => /^player-index-\d+\.json$/.test(f))
      .filter(f => {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf-8'));
          return (d.updatedAt || 0) >= cutoff;
        } catch { return false; }
      })
      .map(f => f.match(/player-index-(\d+)\.json/)[1]);
    console.log(`Recent mode (last ${hoursArg}h): ${playerIds.length} player indexes`);
  } else {
    playerIds = getPlayerIdsFromFixtures(dates);
  }

  if (playerIds.length === 0) {
    console.log('No players found. Make sure fixture files exist in cache/');
    process.exit(0);
  }

  console.log(`Match stats prebuild: ${playerIds.length} players from ${dates.length} fixture date(s)`);
  console.log(`Surfaces: ${surfaces.join(', ')} | Last ${LAST_N} per surface\n`);

  let totalFetched = 0, totalCached = 0, totalNone = 0;

  for (let i = 0; i < playerIds.length; i++) {
    const playerId = playerIds[i];
    const pid = parseInt(playerId);
    const indexFile = path.join(CACHE_DIR, `player-index-${playerId}.json`);
    if (!fs.existsSync(indexFile)) continue;

    let index;
    try { index = JSON.parse(fs.readFileSync(indexFile, 'utf-8')); } catch { continue; }

    const toFetch = new Map();
    for (const surface of surfaces) {
      const entries = (index[surface] || []).filter(e => e.date >= MIN_DATE).slice(0, LAST_N);
      for (const e of entries) {
        if (!e.tournamentId) continue;
        const key = String(e.tournamentId);
        if (!toFetch.has(key)) {
          const homeId = e.homeId ?? pid;
          const awayId = homeId === pid ? e.opponentId : pid;
          toFetch.set(key, { eventId: e.tournamentId, homeId, awayId });
        }
      }
    }

    if (toFetch.size === 0) continue;

    let fetched = 0, cached = 0;
    for (const { eventId, homeId, awayId } of toFetch.values()) {
      const result = await fetchStats(eventId, homeId, awayId);
      if (result === 'fetched') { fetched++; totalFetched++; await sleep(DELAY); }
      else if (result === 'cached') { cached++; totalCached++; }
      else { totalNone++; }
    }

    if (fetched > 0) {
      console.log(`[${i + 1}/${playerIds.length}] Player ${playerId}: ${fetched} fetched, ${cached} already cached`);
    }
  }

  console.log(`\nDone! Fetched: ${totalFetched} new | Cached: ${totalCached} skipped | No stats available: ${totalNone}`);
  console.log(`API calls used: ${totalFetched}`);
}

main().catch(e => { console.error(e); process.exit(1); });
