#!/usr/bin/env node
/**
 * Pre-builds player-index cache for fixture players.
 * Fetches pages of previous events until TARGET_PER_SURFACE matches on the fixture surface.
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
const HOST = env.match(/RAPIDAPI_HOST=(.+)/)?.[1]?.trim() || 'tennisapi1.p.rapidapi.com';

if (!KEY) { console.error('RAPIDAPI_KEY not found in .env.local'); process.exit(1); }

const CACHE_DIR = path.join(__dirname, '..', 'cache');
const HEADERS = { 'x-rapidapi-host': HOST, 'x-rapidapi-key': KEY };
const DELAY_BETWEEN_PAGES = 300;
const DELAY_BETWEEN_PLAYERS = 600;
const TARGET_PER_SURFACE = 10;
const INDEX_LIMIT = 10;
const MAX_PAGES = 15; // 15 pages × ~20 events = ~300 events to find 10 per surface
const PAGE_SIZE = 20; // Sofascore returns ~20 events per page

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getTodayStr() {
  return new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().split('T')[0];
}

function groundTypeToSurface(groundType) {
  if (!groundType) return null;
  const g = groundType.toLowerCase();
  if (g.includes('clay')) return 'Clay';
  if (g.includes('grass')) return 'Grass';
  if (g.includes('hard')) return 'Hard';
  return null;
}

function isATPSingles(event) {
  if (!event.homeTeam || !event.awayTeam) return false;
  if ((event.homeTeam.name || '').includes('/') || (event.awayTeam.name || '').includes('/')) return false;
  const tp = event.tournament?.uniqueTournament?.tennisPoints ?? 0;
  const catSlug = (event.tournament?.uniqueTournament?.category?.slug || event.tournament?.category?.slug || '').toLowerCase();
  // ATP main tour (tp>=250) or Challenger category — excludes ITF which have catSlug='itf' or tp=0
  return tp >= 250 || catSlug === 'challenger';
}

function reverseResult(result) {
  if (!result) return '';
  return result.split(' ').map(set => { const [a, b] = set.split('-'); return `${b}-${a}`; }).join(' ');
}

function buildResult(event, pid) {
  const isHome = event.homeTeam.id === pid;
  const my = isHome ? event.homeScore : event.awayScore;
  const opp = isHome ? event.awayScore : event.homeScore;
  if (!my || !opp) return '';
  const parts = [];
  for (const p of ['period1', 'period2', 'period3', 'period4', 'period5']) {
    if (my[p] === undefined || my[p] === null) break;
    parts.push(`${my[p]}-${opp[p] ?? 0}`);
  }
  return parts.join(' ');
}

// In-memory stores shared across all players in this run
const indexes = {};
const histories = {};

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

  const isDup = idx[surface].some(e =>
    e.id === entry.id ||
    (e.date === entry.date && e.tournamentId === entry.tournamentId && e.opponentId === entry.opponentId)
  );
  if (isDup) return false;

  idx[surface].push(entry);
  idx[surface].sort((a, b) => b.date.localeCompare(a.date));

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
  if (!targetSurface) return false;
  const fp = path.join(CACHE_DIR, `player-index-${playerId}.json`);
  if (!fs.existsSync(fp)) return true;
  try {
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    const updatedToday = new Date((data.updatedAt || 0) + 2 * 60 * 60 * 1000).toISOString().slice(0, 10) === getTodayStr();
    return !updatedToday;
  } catch { return true; }
}

async function fetchPage(playerId, pageNum) {
  const url = `https://${HOST}/api/tennis/player/${playerId}/events/previous/${pageNum}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.status === 429) {
        const wait = attempt * 15000;
        console.log(`    page ${pageNum}: rate limited — waiting ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) { console.log(`    page ${pageNum}: HTTP ${res.status}`); return []; }
      return (await res.json()).events ?? [];
    } catch (e) {
      console.log(`    page ${pageNum}: error — ${e.message}`);
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

  for (let page = 0; page < MAX_PAGES; page++) {
    const events = await fetchPage(playerId, page);
    console.log(`    page ${page}: ${events.length} events`);

    let newForMe = 0;
    for (const event of events) {
      if (!isATPSingles(event)) continue;
      if (event.winnerCode == null) continue; // skip unfinished/future matches

      const surface = groundTypeToSurface(event.groundType)
        || groundTypeToSurface(event.tournament?.uniqueTournament?.groundType);
      if (!surface) continue;

      const isHome = event.homeTeam.id === pid;
      const myName = isHome ? event.homeTeam.name : event.awayTeam.name;
      const opponentId = isHome ? event.awayTeam.id : event.homeTeam.id;
      const opponentName = isHome ? event.awayTeam.name : event.homeTeam.name;

      if (myName && !myIdx.playerName) myIdx.playerName = myName;

      const myEntry = {
        id: String(event.id),
        date: new Date(event.startTimestamp * 1000).toISOString().split('T')[0],
        tournamentId: event.id,   // holds eventId for stats file lookup
        homeId: event.homeTeam.id, // home player in Sofascore — used to parse stats file
        tournamentName: event.tournament?.uniqueTournament?.name || event.tournament?.name,
        opponentId,
        opponentName,
        won: isHome ? event.winnerCode === 1 : event.winnerCode === 2,
        result: buildResult(event, pid),
      };

      if (addEntry(playerId, surface, myEntry)) newForMe++;

      if (opponentId) {
        const oppIdx = loadIndex(String(opponentId));
        if (opponentName && !oppIdx.playerName) oppIdx.playerName = opponentName;
        const oppEntry = {
          ...myEntry,
          opponentId: pid,
          opponentName: myName,
          won: !myEntry.won,
          result: reverseResult(myEntry.result),
        };
        addEntry(String(opponentId), surface, oppEntry);
      }
    }

    console.log(`    → ${newForMe} new | ${targetSurface}: ${surfaceCount()} matches`);

    if (events.length === 0) break;
    if (surfaceCount() >= TARGET_PER_SURFACE) {
      const oldest = myIdx[targetSurface]?.[myIdx[targetSurface].length - 1]?.date ?? '';
      const lastDate = events.length > 0
        ? new Date(events[events.length - 1].startTimestamp * 1000).toISOString().split('T')[0]
        : '';
      if (lastDate <= oldest) break;
    }
    if (events.length < PAGE_SIZE) break;
    if (page < MAX_PAGES - 1) await sleep(DELAY_BETWEEN_PAGES);
  }

  saveIndex(playerId);
  saveHistory(playerId);
  console.log(`    Saved: Clay=${myIdx.Clay?.length} Hard=${myIdx.Hard?.length} Grass=${myIdx.Grass?.length}`);
}

async function main() {
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

  const playerSurfaces = new Map();

  for (const date of dates) {
    const fp = path.join(CACHE_DIR, `fixtures-${date}.json`);
    if (!fs.existsSync(fp)) { console.log(`No fixture file for ${date}`); continue; }
    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    let added = 0;
    for (const f of (data.fixtures || [])) {
      if ((f.player1?.name ?? '').includes('/') || (f.player2?.name ?? '').includes('/')) continue;
      const surface = f.tournament?.court?.name || null;
      for (const player of [f.player1, f.player2]) {
        if (!player?.id) continue;
        const id = String(player.id);
        if (!playerSurfaces.has(id)) { playerSurfaces.set(id, surface); added++; }
      }
    }
    console.log(`Date ${date}: ${added} players`);
  }

  if (dates.includes(today)) {
    const beforeFuture = playerSurfaces.size;
    for (let d = 1; d <= 4; d++) {
      const futureDate = new Date(Date.now() + 2 * 60 * 60 * 1000 + d * 86400000).toISOString().split('T')[0];
      const fp = path.join(CACHE_DIR, `fixtures-${futureDate}.json`);
      if (!fs.existsSync(fp)) continue;
      const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      for (const f of (data.fixtures || [])) {
        const surface = f.tournament?.court?.name || null;
        for (const player of [f.player1, f.player2]) {
          if (!player?.id) continue;
          const id = String(player.id);
          if (!playerSurfaces.has(id)) playerSurfaces.set(id, surface);
        }
      }
    }
    const futureCount = playerSurfaces.size - beforeFuture;
    if (futureCount > 0) console.log(`Added ${futureCount} players from next 4 days`);
  }

  const toFetch = [...playerSurfaces.entries()].filter(([id, surface]) => needsFetch(id, surface));
  const skip = playerSurfaces.size - toFetch.length;

  console.log(`\nTotal players: ${playerSurfaces.size} | Fresh (skip): ${skip} | To fetch: ${toFetch.length}`);
  if (toFetch.length === 0) { console.log('All up to date!'); return; }

  for (let i = 0; i < toFetch.length; i++) {
    const [playerId, surface] = toFetch[i];
    await processPlayer(playerId, surface, i + 1, toFetch.length);
    if (i < toFetch.length - 1) await sleep(DELAY_BETWEEN_PLAYERS);
  }

  let flushed = 0;
  const fetchedIds = new Set(toFetch.map(([id]) => id));
  for (const pid of Object.keys(indexes)) {
    if (!fetchedIds.has(pid)) { saveIndex(pid); flushed++; }
  }
  for (const pid of Object.keys(histories)) {
    saveHistory(pid);
  }
  if (flushed > 0) console.log(`\nFlushed ${flushed} opponent index files.`);
  console.log(`\nDone!`);
}

main().catch(e => { console.error(e); process.exit(1); });
