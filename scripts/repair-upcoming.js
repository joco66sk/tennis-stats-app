#!/usr/bin/env node
/**
 * Verify + repair upcoming fixture data in one pass.
 *
 * For each player in the next 4 days of ATP fixtures:
 *   - Missing player index → fetches it
 *   - Missing stats file for any of their last 10 surface matches → fetches it
 *   - Zero surface matches → warns
 *
 * Usage:
 *   node scripts/repair-upcoming.js           (repair mode)
 *   node scripts/repair-upcoming.js --dry-run (report only, no API calls)
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
const MIN_DATE = '2024-01-01';
const LAST_N = 10;
const DELAY = 400;
const MAX_PAGES = 15;
const PAGE_SIZE = 20;
const DRY_RUN = process.argv.includes('--dry-run');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function getTodayStr() { return new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().split('T')[0]; }

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
  return (event.tournament?.uniqueTournament?.tennisPoints ?? 0) >= 50; // include ATP Challengers
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

function getUpcomingDates() {
  return Array.from({ length: 5 }, (_, d) => {
    const dt = new Date(Date.now() + 2 * 60 * 60 * 1000 + d * 86400000);
    return dt.toISOString().split('T')[0];
  }).filter(d => {
    const fp = path.join(CACHE_DIR, `fixtures-${d}.json`);
    if (!fs.existsSync(fp)) return false;
    try { return (JSON.parse(fs.readFileSync(fp, 'utf-8')).fixtures?.length ?? 0) > 0; } catch { return false; }
  });
}

function detectActiveSurfaces(dates) {
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
  return detected.size > 0 ? [...detected] : ALL_SURFACES;
}

function getUpcomingPlayers(dates) {
  const players = new Map();
  for (const date of dates) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `fixtures-${date}.json`), 'utf-8'));
      for (const f of (data.fixtures || [])) {
        if ((f.player1?.name ?? '').includes('/') || (f.player2?.name ?? '').includes('/')) continue;
        const surface = f.tournament?.court?.name || null;
        for (const p of [f.player1, f.player2]) {
          if (p?.id && !players.has(String(p.id)))
            players.set(String(p.id), { name: p.name, surface });
        }
      }
    } catch {}
  }
  return players;
}

async function fetchAndSaveIndex(playerId, targetSurface) {
  const pid = parseInt(playerId);
  const existing = { Clay: [], Hard: [], Grass: [] };
  const fp = path.join(CACHE_DIR, `player-index-${playerId}.json`);
  if (fs.existsSync(fp)) {
    try { Object.assign(existing, JSON.parse(fs.readFileSync(fp, 'utf-8'))); } catch {}
  }

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `https://${HOST}/api/tennis/player/${playerId}/events/previous/${page}`;
    let events = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, { headers: HEADERS });
        if (res.status === 429) { await sleep(attempt * 15000); continue; }
        if (!res.ok) break;
        events = (await res.json()).events ?? [];
        break;
      } catch { break; }
    }
    if (events.length === 0) break;

    for (const event of events) {
      if (!isATPSingles(event)) continue;
      if (event.winnerCode == null) continue; // skip unfinished/future matches
      const surface = groundTypeToSurface(event.groundType)
        || groundTypeToSurface(event.tournament?.uniqueTournament?.groundType);
      if (!surface) continue;

      const isHome = event.homeTeam.id === pid;
      const opponentId = isHome ? event.awayTeam.id : event.homeTeam.id;
      const opponentName = isHome ? event.awayTeam.name : event.homeTeam.name;
      const myName = isHome ? event.homeTeam.name : event.awayTeam.name;
      if (myName && !existing.playerName) existing.playerName = myName;

      const entry = {
        id: String(event.id),
        date: new Date(event.startTimestamp * 1000).toISOString().split('T')[0],
        tournamentId: event.id,
        homeId: event.homeTeam.id,
        tournamentName: event.tournament?.uniqueTournament?.name || event.tournament?.name,
        opponentId,
        opponentName,
        won: isHome ? event.winnerCode === 1 : event.winnerCode === 2,
        result: buildResult(event, pid),
      };

      if (!existing[surface]) existing[surface] = [];
      const isDup = existing[surface].some(e =>
        e.id === entry.id ||
        (e.date === entry.date && e.tournamentId === entry.tournamentId && e.opponentId === entry.opponentId)
      );
      if (!isDup) {
        existing[surface].push(entry);
        existing[surface].sort((a, b) => b.date.localeCompare(a.date));
        if (existing[surface].length > LAST_N) existing[surface].splice(LAST_N);
      }
    }

    const surfaceCount = (existing[targetSurface] || []).length;
    if (surfaceCount >= LAST_N) break;
    if (events.length < PAGE_SIZE) break;
    await sleep(DELAY);
  }

  existing.updatedAt = Date.now();
  fs.writeFileSync(fp, JSON.stringify(existing, null, 2));
  return existing;
}

function statsFileExists(eventId) {
  return fs.existsSync(path.join(MATCH_STATS_DIR, `match-stats-${eventId}.json`));
}

async function fetchStats(eventId, homeId, awayId) {
  if (statsFileExists(eventId)) return 'cached';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`https://${HOST}/api/tennis/event/${eventId}/statistics`, { headers: HEADERS });
      if (res.status === 429) { await sleep(attempt * 15000); continue; }
      if (!res.ok) break;
      const raw = await res.json();
      const parsed = parseMatchStats(raw, homeId, awayId, eventId);
      if (parsed) {
        fs.writeFileSync(path.join(MATCH_STATS_DIR, `match-stats-${eventId}.json`), JSON.stringify(parsed, null, 2));
        return 'fetched';
      }
      break;
    } catch { break; }
  }
  return 'none';
}

async function main() {
  const dates = getUpcomingDates();
  if (dates.length === 0) { console.log('No upcoming fixtures found — nothing to repair.'); return; }

  const surfaces = detectActiveSurfaces(dates);
  const players = getUpcomingPlayers(dates);

  console.log(`Repair check: ${players.size} players | dates: ${dates.join(', ')} | surfaces: ${surfaces.join(', ')}`);
  if (DRY_RUN) console.log('DRY RUN — no API calls will be made\n');
  else console.log('');

  let repairedIndexes = 0, repairedStats = 0, warnings = 0;

  for (const [playerId, { name, surface: fixtureSurface }] of players) {
    const pid = parseInt(playerId);
    const indexPath = path.join(CACHE_DIR, `player-index-${playerId}.json`);
    let index = null;

    if (!fs.existsSync(indexPath)) {
      if (DRY_RUN) {
        console.log(`  MISSING INDEX  ${name} (${playerId})`);
        warnings++;
      } else {
        process.stdout.write(`  Fetching index  ${name} (${playerId}) ...`);
        index = await fetchAndSaveIndex(playerId, fixtureSurface);
        repairedIndexes++;
        const cnt = surfaces.map(s => `${s}:${(index[s] || []).length}`).join(' ');
        console.log(` done  [${cnt}]`);
        await sleep(DELAY);
      }
      continue;
    }

    try { index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')); }
    catch { console.log(`  PARSE ERROR    ${name} (${playerId})`); warnings++; continue; }

    const surfaceIssues = [];
    for (const s of surfaces) {
      const entries = (index[s] || []).filter(e => e.date >= MIN_DATE);
      if (entries.length === 0) surfaceIssues.push(s);
    }
    if (surfaceIssues.length > 0) {
      console.log(`  WARN 0 matches ${name.padEnd(24)} surfaces: ${surfaceIssues.join(', ')} (API gap or pre-2024)`);
      warnings++;
    }

    const missingStats = [];
    for (const s of surfaces) {
      const entries = (index[s] || []).filter(e => e.date >= MIN_DATE).slice(0, LAST_N);
      for (const e of entries) {
        if (e.tournamentId && !statsFileExists(e.tournamentId)) {
          const homeId = e.homeId ?? pid;
          const awayId = homeId === pid ? e.opponentId : pid;
          missingStats.push({ eventId: e.tournamentId, homeId, awayId, surface: s, date: e.date });
        }
      }
    }

    if (missingStats.length === 0) continue;

    if (DRY_RUN) {
      console.log(`  MISSING STATS  ${name.padEnd(24)} ${missingStats.length} files missing`);
      warnings += missingStats.length;
      continue;
    }

    process.stdout.write(`  Repairing stats ${name.padEnd(24)} ${missingStats.length} missing ...`);
    let fixed = 0;
    for (const { eventId, homeId, awayId } of missingStats) {
      const result = await fetchStats(eventId, homeId, awayId);
      if (result === 'fetched') { fixed++; repairedStats++; await sleep(DELAY); }
    }
    console.log(` ${fixed}/${missingStats.length} fixed`);
  }

  console.log(`\n${'═'.repeat(60)}`);
  if (DRY_RUN) {
    console.log(`Dry run complete. Warnings: ${warnings}`);
  } else {
    console.log(`Repair complete. Indexes: ${repairedIndexes} | Stats: ${repairedStats} | Warnings (unfixable): ${warnings}`);
  }

  if (warnings > 0) {
    console.log('Warnings = genuine API gaps (player has no ATP matches on this surface since 2024).');
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
