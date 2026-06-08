#!/usr/bin/env node
/**
 * Pre-builds match-stats cache for players in fixture files.
 * Fetches serve/return stats for each player's last N clay/hard/grass matches.
 * Run before deploying to Vercel so stats don't need live API calls.
 *
 * Usage:
 *   node scripts/prebuild-match-stats.js             (today's fixture, all surfaces)
 *   node scripts/prebuild-match-stats.js 2026-05-09  (specific date)
 *   node scripts/prebuild-match-stats.js all         (all fixture dates — expensive)
 *   node scripts/prebuild-match-stats.js today --clay-only   (clay season, saves ~66% API calls)
 *   node scripts/prebuild-match-stats.js today --surface Hard
 */

const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env.local');
const env = fs.readFileSync(envPath, 'utf-8');
const KEY = env.match(/RAPIDAPI_KEY=(.+)/)?.[1]?.trim();
const HOST = env.match(/RAPIDAPI_HOST=(.+)/)?.[1]?.trim() || 'tennis-api-atp-wta-itf.p.rapidapi.com';

if (!KEY) { console.error('RAPIDAPI_KEY not found in .env.local'); process.exit(1); }

const CACHE_DIR = path.join(__dirname, '..', 'cache');
const MATCH_STATS_DIR = path.join(__dirname, '..', 'app', 'api', 'cache');
const HEADERS = { 'x-rapidapi-host': HOST, 'x-rapidapi-key': KEY };

const COURT_ID_MAP = { 1: 'Hard', 2: 'Clay', 3: 'Hard', 5: 'Grass' };
const ALL_SURFACES = ['Clay', 'Hard', 'Grass'];
const LAST_N = 10;
const MIN_DATE = '2024-01-01';
const DELAY = 400; // ms between API calls

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getTodayStr() {
  const d = new Date(Date.now() + 2 * 60 * 60 * 1000);
  return d.toISOString().split('T')[0];
}

function getSurface(m) {
  return COURT_ID_MAP[m.tournament?.courtId] || m.tournament?.court?.name || null;
}

function isQualifying(f) {
  return /^Q\d/i.test(f.round?.name ?? '');
}

function getPlayerIdsFromFixtures(dates, atpOnly = true, skipQualifying = false) {
  const ids = new Set();
  for (const date of dates) {
    const fp = path.join(CACHE_DIR, `fixtures-${date}.json`);
    if (!fs.existsSync(fp)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      for (const f of (data.fixtures || [])) {
        if (atpOnly && (f.tournament?.rank?.id ?? 0) < 1) continue;
        if ((f.player1?.name ?? '').includes('/') || (f.player2?.name ?? '').includes('/')) continue;
        if (skipQualifying && isQualifying(f)) continue;
        if (f.player1?.id) ids.add(String(f.player1.id));
        if (f.player2?.id) ids.add(String(f.player2.id));
      }
    } catch {}
  }
  return [...ids];
}

async function fetchStats(tournamentId, p1, p2) {
  for (const [a, b] of [[p1, p2], [p2, p1]]) {
    const file = path.join(MATCH_STATS_DIR, `match-stats-${tournamentId}-${a}-${b}.json`);
    if (fs.existsSync(file)) return 'cached';
  }
  for (const [a, b] of [[p1, p2], [p2, p1]]) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(
          `https://${HOST}/tennis/v2/atp/h2h/match-stats/${tournamentId}/${a}/${b}`,
          { headers: HEADERS }
        );
        if (res.status === 429) {
          const wait = attempt * 15000;
          console.log(`    rate limited (429) — waiting ${wait / 1000}s before retry ${attempt}/3`);
          await sleep(wait);
          continue;
        }
        if (!res.ok) break;
        const raw = await res.json();
        if (raw?.data?.player1Stats) {
          fs.writeFileSync(
            path.join(MATCH_STATS_DIR, `match-stats-${tournamentId}-${a}-${b}.json`),
            JSON.stringify(raw.data, null, 2)
          );
          return 'fetched';
        }
        break;
      } catch { break; }
    }
  }
  return 'none';
}

async function main() {
  if (!fs.existsSync(MATCH_STATS_DIR)) fs.mkdirSync(MATCH_STATS_DIR, { recursive: true });

  const atpOnly = !process.argv.includes('--all-levels');
  const skipQualifying = !process.argv.includes('--with-qualifying');
  const clayOnly = process.argv.includes('--clay-only');
  const surfaceArg = process.argv.find(a => a.startsWith('--surface='))?.split('=')[1]
    || (process.argv.includes('--surface') ? process.argv[process.argv.indexOf('--surface') + 1] : null);
  const surfaces = clayOnly ? ['Clay']
    : surfaceArg ? [surfaceArg]
    : ALL_SURFACES;

  const args = process.argv.slice(2).filter(a =>
    a !== '--all-levels' && a !== '--clay-only' && a !== '--with-qualifying' && !a.startsWith('--surface')
    && process.argv.indexOf(a) !== process.argv.indexOf('--surface') + 1
  );
  const arg = args[0];
  let dates = [];
  if (!arg || arg === 'today') {
    dates = [getTodayStr()];
  } else if (arg === 'upcoming') {
    dates = [0, 1, 2, 3].map(d => {
      const dt = new Date(Date.now() + 2 * 60 * 60 * 1000 + d * 86400000);
      return dt.toISOString().split('T')[0];
    }).filter(d => fs.existsSync(path.join(CACHE_DIR, `fixtures-${d}.json`)));
    console.log(`Upcoming dates: ${dates.join(', ')}`);
  } else if (arg === 'all') {
    dates = fs.readdirSync(CACHE_DIR)
      .filter(f => /^fixtures-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.replace('fixtures-', '').replace('.json', ''))
      .sort();
  } else {
    dates = [arg];
  }

  if (atpOnly) console.log('Mode: ATP-only (use --all-levels to include Challenger/ITF)');
  if (skipQualifying) console.log('Skipping qualifying rounds (use --with-qualifying to include)');
  if (surfaces.length < ALL_SURFACES.length) console.log(`Surface filter: ${surfaces.join(', ')} only`);

  const playerIds = getPlayerIdsFromFixtures(dates, atpOnly, skipQualifying);
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

    // Collect unique (tournamentId, opponentId) pairs across requested surfaces, 2025+ only
    const toFetch = new Map();
    for (const surface of surfaces) {
      const entries = (index[surface] || []).filter(e => e.date >= MIN_DATE).slice(0, LAST_N);
      for (const e of entries) {
        const key = `${e.tournamentId}-${Math.min(pid, e.opponentId)}-${Math.max(pid, e.opponentId)}`;
        if (!toFetch.has(key)) toFetch.set(key, { tournamentId: e.tournamentId, p1: pid, p2: e.opponentId });
      }
    }

    if (toFetch.size === 0) continue;

    let fetched = 0, cached = 0;
    for (const { tournamentId, p1, p2 } of toFetch.values()) {
      const result = await fetchStats(tournamentId, p1, p2);
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
