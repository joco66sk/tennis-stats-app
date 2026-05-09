#!/usr/bin/env node
/**
 * Pre-builds player-matches cache for fixture dates.
 * Fetches each player sequentially with delays to avoid rate limiting.
 *
 * Usage:
 *   node scripts/prebuild-cache.js             (today)
 *   node scripts/prebuild-cache.js 2026-05-09  (specific date)
 *   node scripts/prebuild-cache.js all         (all cached fixture dates)
 */

const fs = require('fs');
const path = require('path');

// Load RAPIDAPI_KEY from .env.local
const envPath = path.join(__dirname, '..', '.env.local');
const env = fs.readFileSync(envPath, 'utf-8');
const KEY = env.match(/RAPIDAPI_KEY=(.+)/)?.[1]?.trim();
const HOST = env.match(/RAPIDAPI_HOST=(.+)/)?.[1]?.trim() || 'tennis-api-atp-wta-itf.p.rapidapi.com';

if (!KEY) { console.error('RAPIDAPI_KEY not found in .env.local'); process.exit(1); }

const CACHE_DIR = path.join(__dirname, '..', 'cache');
const HEADERS = { 'x-rapidapi-host': HOST, 'x-rapidapi-key': KEY };

const DELAY_BETWEEN_PAGES = 300;   // ms between page fetches for one player
const DELAY_BETWEEN_PLAYERS = 600; // ms between players

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getTodayStr() {
  const d = new Date(Date.now() + 2 * 60 * 60 * 1000); // CET
  return d.toISOString().split('T')[0];
}

function getPlayerIdsFromFixture(date) {
  const fp = path.join(CACHE_DIR, `fixtures-${date}.json`);
  if (!fs.existsSync(fp)) { console.log(`No fixture file for ${date}`); return []; }
  const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
  const ids = new Set();
  for (const f of (data.fixtures || [])) {
    if (f.player1?.id) ids.add(String(f.player1.id));
    if (f.player2?.id) ids.add(String(f.player2.id));
  }
  return [...ids];
}

function needsFetch(playerId, forceToday = false) {
  const fp = path.join(CACHE_DIR, `player-matches-${playerId}.json`);
  if (!fs.existsSync(fp)) return true;
  try {
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    const matches = data.matches || [];
    const ageMs = Date.now() - fs.statSync(fp).mtimeMs;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (matches.length === 0) return true;
    // Non-deep-seeded files need 3 pages — always re-fetch them
    if (!data.deepSeeded && (data.pages ?? 1) < 3) return true;
    if (forceToday) return true;
    if (ageDays > 3) return true;
    return false;
  } catch { return true; }
}

async function fetchPage(playerId, pageNo) {
  const url = `https://${HOST}/tennis/v2/atp/player/past-matches/${playerId}?pageSize=100&pageNo=${pageNo}&include=tournament,tournament.court`;
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) { console.log(`    page ${pageNo}: HTTP ${res.status}`); return []; }
    const json = await res.json();
    return json.data ?? [];
  } catch (e) {
    console.log(`    page ${pageNo}: error - ${e.message}`);
    return [];
  }
}

async function fetchPlayerMatches(playerId, pages = 3) {
  const allMatches = [];
  const seen = new Set();

  for (let page = 1; page <= pages; page++) {
    const matches = await fetchPage(playerId, page);
    let added = 0;
    for (const m of matches) {
      const id = String(m.id);
      if (!seen.has(id)) { seen.add(id); allMatches.push(m); added++; }
    }
    console.log(`    page ${page}: ${matches.length} matches (${added} new)`);
    if (matches.length === 0) break;
    if (page < pages) await sleep(DELAY_BETWEEN_PAGES);
  }

  return allMatches;
}

function reverseLookuFallback(playerId) {
  const pid = parseInt(playerId);
  const seen = new Set();
  const found = [];
  try {
    for (const file of fs.readdirSync(CACHE_DIR)) {
      if (!file.startsWith('player-matches-') || file === `player-matches-${playerId}.json`) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf-8'));
        for (const m of (data.matches || [])) {
          if ((m.player1Id === pid || m.player2Id === pid) && !seen.has(String(m.id))) {
            seen.add(String(m.id));
            found.push(m);
          }
        }
      } catch {}
    }
  } catch {}
  return found;
}

function mergeWithExisting(playerId, freshMatches) {
  const fp = path.join(CACHE_DIR, `player-matches-${playerId}.json`);
  if (freshMatches.length === 0 || !fs.existsSync(fp)) return freshMatches;
  try {
    const existing = JSON.parse(fs.readFileSync(fp, 'utf-8')).matches ?? [];
    // Fresh data always wins. Only add historical matches not covered by fresh fetch.
    const freshIds = new Set(freshMatches.map(m => String(m.id)));
    const historicalOnly = existing.filter(m => !freshIds.has(String(m.id)));
    if (historicalOnly.length === 0) return freshMatches;
    return [...freshMatches, ...historicalOnly];
  } catch { return freshMatches; }
}

async function processPlayer(playerId, index, total) {
  const fp = path.join(CACHE_DIR, `player-matches-${playerId}.json`);
  let existingData = null;
  try { existingData = JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch {}
  const isDeepSeeded = existingData?.deepSeeded === true;
  const pages = isDeepSeeded ? 1 : 3;

  console.log(`\n[${index}/${total}] Player ${playerId} (${isDeepSeeded ? 'delta 1p' : '3p full'})`);

  let matches = await fetchPlayerMatches(playerId, pages);

  // Always supplement with reverse lookup — catches API lag where recent matches
  // appear in opponents' files before the player's own endpoint returns them.
  const freshIds = new Set(matches.map(m => String(m.id)));
  const reversed = reverseLookuFallback(playerId);
  let supplemented = 0;
  for (const m of reversed) {
    if (!freshIds.has(String(m.id))) { freshIds.add(String(m.id)); matches.push(m); supplemented++; }
  }
  if (matches.length === 0) {
    console.log(`    No matches from API or reverse lookup`);
  } else if (supplemented > 0) {
    console.log(`    Reverse lookup added: ${supplemented} matches`);
  }

  const merged = mergeWithExisting(playerId, matches);
  merged.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const payload = { matches: merged, cachedAt: Date.now(), pages };
  if (isDeepSeeded) { payload.deepSeeded = true; payload.seededAt = existingData.seededAt; }
  fs.writeFileSync(fp, JSON.stringify(payload, null, 2));

  // Invalidate basic cache so fixture page recomputes from fresh match data.
  for (const surface of ['Clay', 'Hard', 'Grass', 'All']) {
    const basicFp = path.join(CACHE_DIR, `player-surface-basic-${playerId}-${surface}.json`);
    if (fs.existsSync(basicFp)) fs.unlinkSync(basicFp);
  }

  // Surface breakdown
  const COURT_ID_MAP = { 1: 'Hard', 2: 'Clay', 3: 'Hard', 5: 'Grass' };
  const surfaces = {};
  for (const m of merged) {
    const s = COURT_ID_MAP[m.tournament?.courtId] || m.tournament?.court?.name || '?';
    surfaces[s] = (surfaces[s] || 0) + 1;
  }
  const surfStr = Object.entries(surfaces).map(([s, c]) => `${s}:${c}`).join(' ');
  console.log(`    Saved ${merged.length} matches [${surfStr}]`);
}

async function main() {
  const arg = process.argv[2];
  let dates = [];

  if (!arg || arg === 'today') {
    dates = [getTodayStr()];
  } else if (arg === 'all') {
    dates = fs.readdirSync(CACHE_DIR)
      .filter(f => /^fixtures-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.replace('fixtures-', '').replace('.json', ''))
      .sort();
  } else {
    dates = [arg];
  }

  // Collect all unique player IDs across requested dates.
  // Today's players are always re-fetched (API data lag); historical dates skip fresh files.
  const today = getTodayStr();
  const playerMap = new Map(); // id -> forceToday
  for (const date of dates) {
    const ids = getPlayerIdsFromFixture(date);
    const isToday = date === today;
    ids.forEach(id => {
      // Once marked forceToday, keep it
      if (!playerMap.has(id) || isToday) playerMap.set(id, isToday);
    });
    console.log(`Date ${date}: ${ids.length} players${isToday ? ' (force re-fetch)' : ''}`);
  }

  const toFetch = [...playerMap.entries()].filter(([id, force]) => needsFetch(id, force)).map(([id]) => id);
  const skip = playerMap.size - toFetch.length;

  console.log(`\nTotal players: ${playerMap.size} | Fresh (skip): ${skip} | To fetch: ${toFetch.length}`);
  if (toFetch.length === 0) { console.log('All up to date!'); return; }

  const started = Date.now();
  for (let i = 0; i < toFetch.length; i++) {
    await processPlayer(toFetch[i], i + 1, toFetch.length);
    if (i < toFetch.length - 1) await sleep(DELAY_BETWEEN_PLAYERS);
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\nDone! Fetched ${toFetch.length} players in ${elapsed}s`);
}

main().catch(e => { console.error(e); process.exit(1); });
