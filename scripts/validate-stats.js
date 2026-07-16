#!/usr/bin/env node
/**
 * Validates computed averages for all upcoming fixture players.
 * Replicates the same math as player-surface-stats/route.ts.
 * Flags stats outside plausible ATP ranges, re-fetches on suspicion.
 *
 * Usage:
 *   node scripts/validate-stats.js            (validate + re-fetch on suspicion)
 *   node scripts/validate-stats.js --dry-run  (report only, no API calls)
 */

const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env.local');
const env = fs.readFileSync(envPath, 'utf-8');
const KEY = env.match(/RAPIDAPI_KEY=(.+)/)?.[1]?.trim();
const HOST = env.match(/RAPIDAPI_HOST=(.+)/)?.[1]?.trim() || 'tennisapi1.p.rapidapi.com';

if (!KEY) { console.error('RAPIDAPI_KEY not found'); process.exit(1); }

const CACHE_DIR = path.join(__dirname, '..', 'cache');
const MATCH_STATS_DIR = path.join(__dirname, '..', 'app', 'api', 'cache');
const HEADERS = { 'x-rapidapi-host': HOST, 'x-rapidapi-key': KEY };

const MIN_DATE = '2024-01-01';
const LAST_N = 10;
const DELAY = 400;
const DRY_RUN = process.argv.includes('--dry-run');

const THRESHOLDS = {
  serveWon:   { min: 48, max: 82  },
  returnWon:  { min: 18, max: 54  },
  combined:   { min: 78, max: 112 },
  firstServe: { min: 38, max: 80  },
  firstWon:   { min: 52, max: 92  },
  secondWon:  { min: 35, max: 74  },
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
  return detected.size > 0 ? [...detected] : ['Clay', 'Hard', 'Grass'];
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

function getStatsFile(eventId) {
  const fp = path.join(MATCH_STATS_DIR, `match-stats-${eventId}.json`);
  return fs.existsSync(fp) ? fp : null;
}

function computeAvgs(pid, entries) {
  let statsCount = 0;
  let total1stIn = 0, total1stWon = 0, total2ndWon = 0, totalSvpt = 0;
  let totalAces = 0, totalDf = 0;
  let totalReturnWon = 0, totalOppSvpt = 0;

  for (const e of entries) {
    if (!e.tournamentId) continue;
    const fp = getStatsFile(e.tournamentId);
    if (!fp) continue;
    let stats;
    try { stats = JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { continue; }
    const isHome = stats.homeId === pid;
    const my = isHome ? stats.home : stats.away;
    const opp = isHome ? stats.away : stats.home;
    if (!my || !opp) continue;
    const svpt = my.firstServeOf || 0;
    if (svpt === 0) continue;
    statsCount++;
    totalAces += my.aces || 0;
    totalDf += my.doubleFaults || 0;
    total1stIn += my.firstServe || 0;
    total1stWon += my.winningOnFirstServe || 0;
    total2ndWon += my.winningOnSecondServe || 0;
    totalSvpt += svpt;
    const oppSvpt = opp.firstServeOf || 0;
    if (oppSvpt > 0) {
      totalReturnWon += oppSvpt - (opp.winningOnFirstServe || 0) - (opp.winningOnSecondServe || 0);
      totalOppSvpt += oppSvpt;
    }
  }

  if (statsCount === 0) return null;
  const serveWon  = totalSvpt ? ((total1stWon + total2ndWon) / totalSvpt) * 100 : 0;
  const returnWon = totalOppSvpt ? (totalReturnWon / totalOppSvpt) * 100 : 0;
  const firstServe = totalSvpt ? (total1stIn / totalSvpt) * 100 : 0;
  const firstWon  = total1stIn ? (total1stWon / total1stIn) * 100 : 0;
  const secondWon = (totalSvpt - total1stIn) > 0 ? (total2ndWon / (totalSvpt - total1stIn)) * 100 : 0;
  return { statsCount, serveWon, returnWon, combined: serveWon + returnWon, firstServe, firstWon, secondWon };
}

function checkThresholds(avgs) {
  const flags = [];
  for (const [key, { min, max }] of Object.entries(THRESHOLDS)) {
    const val = avgs[key];
    if (val < min) flags.push(`${key}=${val.toFixed(1)}% < ${min}`);
    if (val > max) flags.push(`${key}=${val.toFixed(1)}% > ${max}`);
  }
  return flags;
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

async function refetchPlayerStats(pid, entries) {
  let fetched = 0;
  for (const e of entries) {
    if (!e.tournamentId) continue;
    const fp = path.join(MATCH_STATS_DIR, `match-stats-${e.tournamentId}.json`);
    const homeId = e.homeId ?? pid;
    const awayId = homeId === pid ? e.opponentId : pid;
    try {
      const res = await fetch(`https://${HOST}/api/tennis/event/${e.tournamentId}/statistics`, { headers: HEADERS });
      if (!res.ok) continue;
      const raw = await res.json();
      const parsed = parseMatchStats(raw, homeId, awayId, e.tournamentId);
      if (parsed) {
        fs.writeFileSync(fp, JSON.stringify(parsed, null, 2));
        fetched++;
        await sleep(DELAY);
      }
    } catch {}
  }
  return fetched;
}

async function main() {
  const dates = getUpcomingDates();
  if (dates.length === 0) { console.log('No upcoming fixtures — nothing to validate.'); return; }

  const surfaces = detectActiveSurfaces(dates);
  const players = getUpcomingPlayers(dates);

  console.log(`Stats validation: ${players.size} players | ${dates[0]} to ${dates[dates.length - 1]} | surfaces: ${surfaces.join(', ')}`);
  if (DRY_RUN) console.log('DRY RUN\n'); else console.log('');

  let totalRefetched = 0, stillSuspicious = 0;

  for (const [playerId, { name }] of players) {
    const pid = parseInt(playerId);
    const indexPath = path.join(CACHE_DIR, `player-index-${playerId}.json`);
    if (!fs.existsSync(indexPath)) continue;
    let index;
    try { index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')); } catch { continue; }

    for (const surface of surfaces) {
      const entries = (index[surface] || []).filter(e => e.date >= MIN_DATE).slice(0, LAST_N);
      if (entries.length === 0) continue;

      const avgs = computeAvgs(pid, entries);
      if (!avgs) continue;

      const flags = checkThresholds(avgs);
      if (flags.length === 0) continue;

      console.log(`  SUSPICIOUS ${name.padEnd(26)} ${surface}: ${flags.join(' | ')} (${avgs.statsCount}/${entries.length} matches)`);

      if (DRY_RUN) { stillSuspicious++; continue; }

      const fetched = await refetchPlayerStats(pid, entries);
      totalRefetched += fetched;

      const avgs2 = computeAvgs(pid, entries);
      const flags2 = avgs2 ? checkThresholds(avgs2) : [];

      if (flags2.length === 0) {
        console.log(`             → fixed after re-fetch (${fetched} files refreshed)`);
      } else {
        console.log(`             → still suspicious after re-fetch: ${flags2.join(' | ')} — may be genuine`);
        stillSuspicious++;
      }
    }
  }

  console.log(`\n${'═'.repeat(60)}`);
  if (DRY_RUN) {
    console.log(`Dry run — suspicious players: ${stillSuspicious}`);
  } else {
    console.log(`Done. Files re-fetched: ${totalRefetched} | Still suspicious (likely genuine): ${stillSuspicious}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
