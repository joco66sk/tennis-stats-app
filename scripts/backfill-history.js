#!/usr/bin/env node
/**
 * Backfills extended match history for top ATP players.
 * Fetches up to 30 matches per surface (vs the regular-player default).
 * Tries the ATP rankings endpoint first; falls back to recent fixture files.
 *
 * Usage:
 *   node scripts/backfill-history.js              (30 matches/surface, fixture-based list)
 *   node scripts/backfill-history.js --limit=50   (50 matches/surface)
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

const TARGET = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '30');
const TIME_LIMIT_MS = 10 * 60 * 1000; // stop after 10 minutes so the combined workflow stays under 30 min
const MAX_PAGES = 20;
const MIN_DATE = '2023-01-01'; // go back to 2023 for more matches
const SURFACES = ['Clay', 'Hard', 'Grass'];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function groundTypeToSurface(g) {
  if (!g) return null;
  const s = g.toLowerCase();
  if (s.includes('clay')) return 'Clay';
  if (s.includes('grass')) return 'Grass';
  if (s.includes('hard')) return 'Hard';
  return null;
}

function isATPSingles(event) {
  if (!event.homeTeam || !event.awayTeam) return false;
  if ((event.homeTeam.name || '').includes('/') || (event.awayTeam.name || '').includes('/')) return false;
  return (event.tournament?.uniqueTournament?.tennisPoints ?? 0) >= 250;
}

function buildResult(event, pid) {
  const isHome = event.homeTeam.id === pid;
  const my = isHome ? event.homeScore : event.awayScore;
  const opp = isHome ? event.awayScore : event.homeScore;
  if (!my || !opp) return '';
  const parts = [];
  for (const p of ['period1', 'period2', 'period3', 'period4', 'period5']) {
    if (my[p] == null) break;
    parts.push(`${my[p]}-${opp[p] ?? 0}`);
  }
  return parts.join(' ');
}

// ── Get player list ────────────────────────────────────────────────────────────

async function tryRankingsEndpoint() {
  // Sofascore ATP singles ranking (category 3, ranking type varies)
  const candidates = [
    `https://${HOST}/api/tennis/rankings/1`,
    `https://${HOST}/api/tennis/rankings/atp`,
    `https://${HOST}/api/tennis/category/3/rankings`,
  ];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) continue;
      const data = await res.json();
      const rows = data.rankings ?? data.rows ?? data;
      if (!Array.isArray(rows) || rows.length < 50) continue;
      const ids = rows.slice(0, 100).map(r => String(r.team?.id || r.player?.id || r.id)).filter(Boolean);
      if (ids.length >= 50) {
        console.log(`Rankings from ${url}: ${ids.length} players`);
        return ids;
      }
    } catch {}
  }
  return null;
}

function getPlayersFromFixtures() {
  // Collect player IDs from all cached fixture files
  const playerMap = new Map(); // id → { name, appearances }
  const files = fs.readdirSync(CACHE_DIR)
    .filter(f => f.startsWith('fixtures-') && f.endsWith('.json'))
    .sort().reverse();

  for (const file of files) {
    try {
      const { fixtures = [] } = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file)));
      for (const f of fixtures) {
        const rankId = f.tournament?.rank?.id ?? 0;
        if (rankId < 2) continue; // skip non-ATP
        for (const p of [f.player1, f.player2]) {
          if (!p?.id) continue;
          const key = String(p.id);
          const entry = playerMap.get(key) || { name: p.name, appearances: 0 };
          entry.appearances++;
          playerMap.set(key, entry);
        }
      }
    } catch {}
  }

  // Sort by appearances (more appearances = more active = more likely top-ranked)
  return [...playerMap.entries()]
    .sort(([, a], [, b]) => b.appearances - a.appearances)
    .slice(0, 150)
    .map(([id, { name }]) => ({ id, name }));
}

// ── Backfill one player ────────────────────────────────────────────────────────

async function backfillPlayer(playerId, displayName, idx, total) {
  const pid = parseInt(playerId);
  const fp = path.join(CACHE_DIR, `player-index-${playerId}.json`);

  let index = { Clay: [], Hard: [], Grass: [], playerName: displayName || null, updatedAt: 0 };
  if (fs.existsSync(fp)) {
    try { index = { ...index, ...JSON.parse(fs.readFileSync(fp, 'utf-8')) }; } catch {}
  }

  const needsSurface = SURFACES.filter(s => (index[s] || []).length < TARGET);
  if (needsSurface.length === 0) {
    console.log(`[${idx}/${total}] ${index.playerName || playerId}: already complete, skipping`);
    return false;
  }

  const counts = SURFACES.map(s => `${s}:${(index[s] || []).length}`).join(' ');
  console.log(`[${idx}/${total}] ${index.playerName || playerId}: ${counts} — fetching...`);

  let changed = false;
  let tooOld = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (SURFACES.every(s => (index[s] || []).length >= TARGET)) break;
    if (tooOld) break;

    let events = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(`https://${HOST}/api/tennis/player/${playerId}/events/previous/${page}`, { headers: HEADERS });
        if (res.status === 429) { await sleep(attempt * 15000); continue; }
        if (res.status === 405) { await sleep(attempt * 10000); continue; }
        if (!res.ok) break;
        events = (await res.json()).events ?? [];
        break;
      } catch { await sleep(2000); }
    }

    if (events.length === 0) break;

    for (const event of events) {
      const date = new Date((event.startTimestamp || 0) * 1000).toISOString().split('T')[0];
      if (date < MIN_DATE) { tooOld = true; break; }
      if (!isATPSingles(event) || event.winnerCode == null) continue;

      const surface = groundTypeToSurface(event.groundType)
        || groundTypeToSurface(event.tournament?.uniqueTournament?.groundType);
      if (!surface) continue;

      if (!index[surface]) index[surface] = [];
      if ((index[surface].length) >= TARGET) continue;

      const id = String(event.id);
      if (index[surface].some(e => e.id === id)) continue;

      const isHome = event.homeTeam.id === pid;
      if (!index.playerName) index.playerName = isHome ? event.homeTeam.name : event.awayTeam.name;

      index[surface].push({
        id,
        date,
        tournamentId: event.id,
        homeId: event.homeTeam.id,
        tournamentName: event.tournament?.uniqueTournament?.name || event.tournament?.name || '',
        opponentId: isHome ? event.awayTeam.id : event.homeTeam.id,
        opponentName: isHome ? event.awayTeam.name : event.homeTeam.name,
        won: isHome ? event.winnerCode === 1 : event.winnerCode === 2,
        result: buildResult(event, pid),
      });
      changed = true;
    }

    for (const s of SURFACES) {
      if (index[s]) index[s].sort((a, b) => b.date.localeCompare(a.date));
    }

    await sleep(400);
  }

  if (changed || needsSurface.length > 0) {
    index.updatedAt = Date.now();
    fs.writeFileSync(fp, JSON.stringify(index, null, 2));
    const newCounts = SURFACES.map(s => `${s}:${(index[s] || []).length}`).join(' ');
    console.log(`  → saved: ${newCounts}`);
  }

  return changed;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  console.log(`\nBackfilling history (target: ${TARGET} per surface, time limit: ${TIME_LIMIT_MS / 60000} min)\n${'─'.repeat(50)}`);

  // Get player list
  console.log('Getting player list...');
  let players;
  const rankingIds = await tryRankingsEndpoint();
  if (rankingIds) {
    players = rankingIds.map(id => ({ id, name: null }));
  } else {
    console.log('Rankings endpoint not available — using fixture-based list');
    players = getPlayersFromFixtures();
  }

  console.log(`Processing ${players.length} players...\n`);

  let updated = 0;
  for (let i = 0; i < players.length; i++) {
    if (Date.now() - startTime >= TIME_LIMIT_MS) {
      console.log(`\nTime limit reached — stopped after ${i}/${players.length} players.`);
      break;
    }
    const { id, name } = players[i];
    try {
      const changed = await backfillPlayer(id, name, i + 1, players.length);
      if (changed) updated++;
    } catch (e) {
      console.log(`  error: ${e.message}`);
    }
    if (i < players.length - 1) await sleep(700);
  }

  console.log(`\n${'─'.repeat(50)}\nDone. Updated ${updated}/${players.length} players.`);
}

main().catch(e => { console.error(e); process.exit(1); });
