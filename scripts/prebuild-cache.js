#!/usr/bin/env node
/**
 * Pre-builds player-index cache for fixture dates.
 * Fetches pages until TARGET_PER_SURFACE matches exist for the player's fixture surface.
 * Writes both player + opponent entries from each fetched match — no reverse lookup needed.
 *
 * Usage:
 *   node scripts/prebuild-cache.js             (today)
 *   node scripts/prebuild-cache.js 2026-05-09  (specific date)
 *   node scripts/prebuild-cache.js all         (all cached fixture dates)
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
const DELAY_BETWEEN_PAGES = 300;
const DELAY_BETWEEN_PLAYERS = 600;
const TARGET_PER_SURFACE = 10;
const INDEX_LIMIT = 10;       // max entries kept per surface in active index
const FRESHNESS_HOURS = 12;
const MAX_PAGES = 5;
const COURT_ID_MAP = { 1: 'Hard', 2: 'Clay', 3: 'Hard', 5: 'Grass' };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getTodayStr() {
  const d = new Date(Date.now() + 2 * 60 * 60 * 1000); // CET
  return d.toISOString().split('T')[0];
}

function isQualifying(f) {
  return /^Q\d/i.test(f.round?.name ?? '');
}

function getSurface(m) {
  const fromId = COURT_ID_MAP[m.tournament?.courtId];
  if (fromId) return fromId;
  const name = (m.tournament?.court?.name || '').toLowerCase();
  if (name.includes('clay')) return 'Clay';
  if (name.includes('hard') || name.includes('indoor') || name.includes('carpet')) return 'Hard';
  if (name.includes('grass')) return 'Grass';
  return null;
}

function normalizeSurfaceName(s) {
  if (!s) return null;
  if (s === 'I.hard' || s === 'Carpet') return 'Hard';
  if (s === 'Clay' || s === 'Hard' || s === 'Grass') return s;
  return null;
}

// In-memory stores shared across all players in this run
const indexes = {};   // pid -> active index (last INDEX_LIMIT per surface)
const histories = {}; // pid -> history (older matches)

function loadIndex(pid) {
  const key = String(pid);
  if (indexes[key]) return indexes[key];
  const fp = path.join(CACHE_DIR, `player-index-${pid}.json`);
  if (fs.existsSync(fp)) {
    try { indexes[key] = JSON.parse(fs.readFileSync(fp, 'utf-8')); return indexes[key]; } catch {}
  }
  indexes[key] = { Clay: [], Hard: [], Grass: [], updatedAt: 0 };
  return indexes[key];
}

function loadHistory(pid) {
  const key = String(pid);
  if (histories[key]) return histories[key];
  const fp = path.join(CACHE_DIR, `player-history-${pid}.json`);
  if (fs.existsSync(fp)) {
    try { histories[key] = JSON.parse(fs.readFileSync(fp, 'utf-8')); return histories[key]; } catch {}
  }
  histories[key] = { Clay: [], Hard: [], Grass: [] };
  return histories[key];
}

function saveIndex(pid) {
  const key = String(pid);
  if (!indexes[key]) return;
  indexes[key].updatedAt = Date.now();
  fs.writeFileSync(
    path.join(CACHE_DIR, `player-index-${pid}.json`),
    JSON.stringify(indexes[key], null, 2)
  );
  for (const surface of ['Clay', 'Hard', 'Grass', 'All']) {
    const bp = path.join(CACHE_DIR, `player-surface-basic-${pid}-${surface}.json`);
    if (fs.existsSync(bp)) try { fs.unlinkSync(bp); } catch {}
  }
}

function saveHistory(pid) {
  const key = String(pid);
  if (!histories[key]) return;
  fs.writeFileSync(
    path.join(CACHE_DIR, `player-history-${pid}.json`),
    JSON.stringify(histories[key], null, 2)
  );
}

function addEntry(pid, surface, entry) {
  const idx = loadIndex(pid);
  if (!idx[surface]) idx[surface] = [];
  if (idx[surface].some(e => e.id === entry.id)) return false;

  // Deduplicate by id OR natural key (same match can have two IDs from different endpoints)
  const isDup = idx[surface].some(e =>
    e.id === entry.id ||
    (e.date === entry.date && e.tournamentId === entry.tournamentId && e.opponentId === entry.opponentId)
  );
  if (isDup) return false;

  idx[surface].push(entry);
  idx[surface].sort((a, b) => b.date.localeCompare(a.date));

  // Trim to INDEX_LIMIT — overflow slides into history
  if (idx[surface].length > INDEX_LIMIT) {
    const displaced = idx[surface].splice(INDEX_LIMIT);
    const hist = loadHistory(pid);
    if (!hist[surface]) hist[surface] = [];
    const histIds = new Set(hist[surface].map(e => e.id));
    for (const e of displaced) {
      if (!histIds.has(e.id)) { hist[surface].push(e); histIds.add(e.id); }
    }
  }
  return true;
}

function needsFetch(playerId, targetSurface) {
  if (!targetSurface) return false; // unknown court type — skip, don't waste pages
  const fp = path.join(CACHE_DIR, `player-index-${playerId}.json`);
  if (!fs.existsSync(fp)) return true;
  try {
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    const ageHours = (Date.now() - (data.updatedAt || 0)) / 3600000;
    if (ageHours < FRESHNESS_HOURS) {
      if ((data[targetSurface]?.length ?? 0) >= TARGET_PER_SURFACE) return false;
    }
    return true;
  } catch { return true; }
}

async function fetchPage(playerId, pageNo) {
  const url = `https://${HOST}/tennis/v2/atp/player/past-matches/${playerId}?pageSize=100&pageNo=${pageNo}&include=tournament,tournament.court`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.status === 429) {
        const wait = attempt * 15000;
        console.log(`    page ${pageNo}: rate limited — waiting ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) { console.log(`    page ${pageNo}: HTTP ${res.status}`); return []; }
      return (await res.json()).data ?? [];
    } catch (e) {
      console.log(`    page ${pageNo}: error - ${e.message}`);
      return [];
    }
  }
  return [];
}

async function processPlayer(playerId, targetSurface, index, total) {
  console.log(`\n[${index}/${total}] Player ${playerId} (surface: ${targetSurface || 'any'})`);

  const pid = parseInt(playerId);
  const myIdx = loadIndex(playerId);
  const surfaceCount = () => targetSurface ? (myIdx[targetSurface]?.length ?? 0) : 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const matches = await fetchPage(playerId, page);
    console.log(`    page ${page}: ${matches.length} matches`);

    let newForMe = 0;
    for (const m of matches) {
      const surface = getSurface(m);
      if (!surface) continue;

      const isP1 = m.player1Id === pid;
      const myName = isP1 ? m.player1?.name : m.player2?.name;
      const opponentId = isP1 ? m.player2Id : m.player1Id;
      const opponentName = isP1 ? m.player2?.name : m.player1?.name;

      if (myName && !myIdx.playerName) myIdx.playerName = myName;

      const myEntry = {
        id: String(m.id),
        date: (m.date || '').slice(0, 10),
        tournamentId: m.tournamentId,
        tournamentName: m.tournament?.name,
        opponentId,
        opponentName,
        won: m.match_winner === pid,
        result: m.result,
      };

      if (addEntry(playerId, surface, myEntry)) newForMe++;

      if (opponentId) {
        const oppIdx = loadIndex(opponentId);
        if (opponentName && !oppIdx.playerName) oppIdx.playerName = opponentName;
        const oppEntry = { ...myEntry, opponentId: pid, opponentName: myName, won: m.match_winner === opponentId };
        addEntry(String(opponentId), surface, oppEntry);
      }
    }

    console.log(`    → ${newForMe} new | ${targetSurface}: ${surfaceCount()} matches`);

    if (matches.length === 0) break;
    if (surfaceCount() >= TARGET_PER_SURFACE) break;
    if (matches.length < 100) break;
    if (page < MAX_PAGES) await sleep(DELAY_BETWEEN_PAGES);
  }

  saveIndex(playerId);
  saveHistory(playerId);
  console.log(`    Saved: Clay=${myIdx.Clay?.length} Hard=${myIdx.Hard?.length} Grass=${myIdx.Grass?.length}`);
}

async function main() {
  const atpOnly = !process.argv.includes('--all-levels');
  const skipQualifying = !process.argv.includes('--with-qualifying');
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const arg = args[0];
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

  const today = getTodayStr();
  if (atpOnly) console.log('Mode: ATP-only (use --all-levels to include Challenger/ITF)');
  if (skipQualifying) console.log('Skipping qualifying rounds (use --with-qualifying to include)');

  // Collect players and their target surface from fixtures
  const playerSurfaces = new Map(); // playerId -> surface

  for (const date of dates) {
    const fp = path.join(CACHE_DIR, `fixtures-${date}.json`);
    if (!fs.existsSync(fp)) { console.log(`No fixture file for ${date}`); continue; }
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    let added = 0;
    for (const f of (data.fixtures || [])) {
      if (atpOnly && (f.tournament?.rank?.id ?? 0) < 2) continue;
      if ((f.player1?.name ?? '').includes('/') || (f.player2?.name ?? '').includes('/')) continue;
      if (skipQualifying && isQualifying(f) && (f.tournament?.rank?.id ?? 0) < 2) continue;
      const surface = normalizeSurfaceName(f.tournament?.court?.name);
      for (const player of [f.player1, f.player2]) {
        if (!player?.id) continue;
        const id = String(player.id);
        if (!playerSurfaces.has(id)) { playerSurfaces.set(id, surface); added++; }
      }
    }
    console.log(`Date ${date}: ${added} players`);
  }

  // Include players from last 14 days when fetching today
  if (dates.includes(today)) {
    const beforeCount = playerSurfaces.size;
    for (let d = 1; d <= 14; d++) {
      const pastDate = new Date(Date.now() + 2 * 60 * 60 * 1000 - d * 86400000).toISOString().split('T')[0];
      const fp = path.join(CACHE_DIR, `fixtures-${pastDate}.json`);
      if (!fs.existsSync(fp)) continue;
      const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      for (const f of (data.fixtures || [])) {
        if (atpOnly && (f.tournament?.rank?.id ?? 0) < 2) continue;
        if (skipQualifying && isQualifying(f) && (f.tournament?.rank?.id ?? 0) < 2) continue;
        const surface = normalizeSurfaceName(f.tournament?.court?.name);
        for (const player of [f.player1, f.player2]) {
          if (!player?.id) continue;
          const id = String(player.id);
          if (!playerSurfaces.has(id)) playerSurfaces.set(id, surface);
        }
      }
    }
    const recentCount = playerSurfaces.size - beforeCount;
    if (recentCount > 0) console.log(`Added ${recentCount} players from last 14 days`);

    // Include players from next 3 days (upcoming fixtures already prefetched)
    const beforeUpcoming = playerSurfaces.size;
    for (let d = 1; d <= 3; d++) {
      const futureDate = new Date(Date.now() + 2 * 60 * 60 * 1000 + d * 86400000).toISOString().split('T')[0];
      const fp = path.join(CACHE_DIR, `fixtures-${futureDate}.json`);
      if (!fs.existsSync(fp)) continue;
      const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      for (const f of (data.fixtures || [])) {
        if (atpOnly && (f.tournament?.rank?.id ?? 0) < 2) continue;
        const surface = normalizeSurfaceName(f.tournament?.court?.name);
        for (const player of [f.player1, f.player2]) {
          if (!player?.id) continue;
          const id = String(player.id);
          if (!playerSurfaces.has(id)) playerSurfaces.set(id, surface);
        }
      }
    }
    const upcomingCount = playerSurfaces.size - beforeUpcoming;
    if (upcomingCount > 0) console.log(`Added ${upcomingCount} players from next 3 days`);
  }

  const toFetch = [...playerSurfaces.entries()].filter(([id, surface]) => needsFetch(id, surface));
  const skip = playerSurfaces.size - toFetch.length;

  console.log(`\nTotal players: ${playerSurfaces.size} | Fresh (skip): ${skip} | To fetch: ${toFetch.length}`);
  if (toFetch.length === 0) { console.log('All up to date!'); return; }

  const started = Date.now();
  for (let i = 0; i < toFetch.length; i++) {
    const [playerId, surface] = toFetch[i];
    await processPlayer(playerId, surface, i + 1, toFetch.length);
    if (i < toFetch.length - 1) await sleep(DELAY_BETWEEN_PLAYERS);
  }

  // Flush opponent indexes + histories that were updated but not yet saved
  let flushed = 0;
  const fetchedIds = new Set(toFetch.map(([id]) => id));
  for (const pid of Object.keys(indexes)) {
    if (!fetchedIds.has(pid)) { saveIndex(pid); flushed++; }
  }
  for (const pid of Object.keys(histories)) {
    saveHistory(pid);
  }
  if (flushed > 0) console.log(`\nFlushed ${flushed} opponent index files.`);

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\nDone! Fetched ${toFetch.length} players in ${elapsed}s`);
}

main().catch(e => { console.error(e); process.exit(1); });
