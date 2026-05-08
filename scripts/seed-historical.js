#!/usr/bin/env node
/**
 * One-time historical seed: fetches all ATP matches from Jan 2025 onward
 * for every player seen across all fixture files. Paginates until pre-2025
 * matches appear. Tags each file deepSeeded:true so prebuild and the route
 * only need a 1-page delta update afterward.
 *
 * Usage:
 *   node scripts/seed-historical.js             (all players from all fixtures)
 *   node scripts/seed-historical.js 2026-05-08  (only players from that fixture date)
 *   node scripts/seed-historical.js --force      (re-seed even if already tagged)
 */

const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env.local');
const env = fs.readFileSync(envPath, 'utf-8');
const KEY = env.match(/RAPIDAPI_KEY=(.+)/)?.[1]?.trim();
const HOST = env.match(/RAPIDAPI_HOST=(.+)/)?.[1]?.trim() || 'tennis-api-atp-wta-itf.p.rapidapi.com';

if (!KEY) { console.error('RAPIDAPI_KEY not found in .env.local'); process.exit(1); }

const CACHE_DIR = path.join(__dirname, '..', 'cache');
const HEADERS = { 'x-rapidapi-host': HOST, 'x-rapidapi-key': KEY };

const CUTOFF_DATE = '2025-01-01';   // stop paginating once all matches on page are older than this
const MAX_PAGES = 8;                // hard cap — 800 matches is more than enough for any player
const DELAY_BETWEEN_PAGES = 400;   // ms
const DELAY_BETWEEN_PLAYERS = 800; // ms
const RESEED_AFTER_DAYS = 30;      // skip players seeded more recently than this

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getAllPlayerIds(dateFilter) {
  const ids = new Set();
  const files = fs.readdirSync(CACHE_DIR)
    .filter(f => /^fixtures-\d{4}-\d{2}-\d{2}\.json$/.test(f));

  for (const file of files) {
    if (dateFilter && file !== `fixtures-${dateFilter}.json`) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf-8'));
      for (const f of (data.fixtures || [])) {
        if (f.player1?.id) ids.add(String(f.player1.id));
        if (f.player2?.id) ids.add(String(f.player2.id));
      }
    } catch {}
  }
  return [...ids];
}

async function fetchPage(playerId, pageNo) {
  const url = `https://${HOST}/tennis/v2/atp/player/past-matches/${playerId}?pageSize=100&pageNo=${pageNo}&include=tournament,tournament.court`;
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) { console.log(`    page ${pageNo}: HTTP ${res.status}`); return []; }
    return (await res.json()).data ?? [];
  } catch (e) {
    console.log(`    page ${pageNo}: error - ${e.message}`);
    return [];
  }
}

async function fetchHistorical(playerId) {
  const allMatches = [];
  const seen = new Set();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const matches = await fetchPage(playerId, page);
    if (matches.length === 0) { console.log(`    page ${page}: empty, done`); break; }

    let added = 0;
    let allBeforeCutoff = true;
    for (const m of matches) {
      if ((m.date || '') >= CUTOFF_DATE) allBeforeCutoff = false;
      if (!seen.has(String(m.id))) { seen.add(String(m.id)); allMatches.push(m); added++; }
    }
    console.log(`    page ${page}: ${matches.length} fetched, ${added} new`);
    if (allBeforeCutoff) { console.log(`    All matches before ${CUTOFF_DATE}, done`); break; }
    if (page < MAX_PAGES) await sleep(DELAY_BETWEEN_PAGES);
  }

  return allMatches;
}

function mergeWithExisting(playerId, freshMatches) {
  const fp = path.join(CACHE_DIR, `player-matches-${playerId}.json`);
  if (freshMatches.length === 0 || !fs.existsSync(fp)) return freshMatches;
  try {
    const existing = JSON.parse(fs.readFileSync(fp, 'utf-8')).matches ?? [];
    const freshIds = new Set(freshMatches.map(m => String(m.id)));
    const historicalOnly = existing.filter(m => !freshIds.has(String(m.id)));
    return historicalOnly.length === 0 ? freshMatches : [...freshMatches, ...historicalOnly];
  } catch { return freshMatches; }
}

async function processPlayer(playerId, index, total, force) {
  console.log(`\n[${index}/${total}] Player ${playerId}`);

  const fp = path.join(CACHE_DIR, `player-matches-${playerId}.json`);
  if (!force && fs.existsSync(fp)) {
    try {
      const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      if (data.deepSeeded) {
        const ageDays = (Date.now() - (data.seededAt || fs.statSync(fp).mtimeMs)) / (1000 * 60 * 60 * 24);
        if (ageDays < RESEED_AFTER_DAYS) {
          console.log(`    Deep-seeded ${ageDays.toFixed(1)} days ago, skipping`);
          return;
        }
      }
    } catch {}
  }

  const fresh = await fetchHistorical(playerId);
  if (fresh.length === 0) { console.log(`    No matches found`); return; }

  const merged = mergeWithExisting(playerId, fresh);
  merged.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const now = Date.now();
  fs.writeFileSync(fp, JSON.stringify({
    matches: merged,
    cachedAt: now,
    pages: MAX_PAGES,
    deepSeeded: true,
    seededAt: now,
  }, null, 2));

  // Invalidate basic surface caches so fixture page recomputes from fresh data
  for (const surface of ['Clay', 'Hard', 'Grass', 'All']) {
    const basicFp = path.join(CACHE_DIR, `player-surface-basic-${playerId}-${surface}.json`);
    if (fs.existsSync(basicFp)) fs.unlinkSync(basicFp);
  }

  const surfaces = {};
  const COURT_ID_MAP = { 1: 'Hard', 2: 'Clay', 3: 'Hard', 5: 'Grass' };
  for (const m of merged) {
    const s = COURT_ID_MAP[m.tournament?.courtId] || m.tournament?.court?.name || '?';
    surfaces[s] = (surfaces[s] || 0) + 1;
  }
  const surfStr = Object.entries(surfaces).map(([s, c]) => `${s}:${c}`).join(' ');
  console.log(`    Saved ${merged.length} matches [${surfStr}]`);
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const dateFilter = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));

  const playerIds = getAllPlayerIds(dateFilter);
  if (playerIds.length === 0) {
    console.log('No players found. Make sure fixture files exist in cache/');
    process.exit(0);
  }

  console.log(`Historical seed: ${playerIds.length} players${dateFilter ? ` from fixtures-${dateFilter}` : ' from all fixtures'}`);
  console.log(`Cutoff: ${CUTOFF_DATE} | Max pages: ${MAX_PAGES} | Force: ${force}\n`);

  const started = Date.now();
  for (let i = 0; i < playerIds.length; i++) {
    await processPlayer(playerIds[i], i + 1, playerIds.length, force);
    if (i < playerIds.length - 1) await sleep(DELAY_BETWEEN_PLAYERS);
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\nHistorical seed complete: ${playerIds.length} players in ${elapsed}s`);
}

main().catch(e => { console.error(e); process.exit(1); });
