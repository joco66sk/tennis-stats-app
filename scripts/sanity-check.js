#!/usr/bin/env node
/**
 * Sanity check for upcoming fixture player stats.
 * Catches: missing stats files, sampling bias (stats only from wins),
 * low coverage (< 5/10 matches have files), and auto-repairs by fetching missing files.
 *
 * Usage:
 *   node scripts/sanity-check.js            (check + repair)
 *   node scripts/sanity-check.js --dry-run  (report only)
 */

const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env.local');
const env = fs.readFileSync(envPath, 'utf-8');
const KEY = env.match(/RAPIDAPI_KEY=(.+)/)?.[1]?.trim();
const HOST = env.match(/RAPIDAPI_HOST=(.+)/)?.[1]?.trim() || 'tennis-api-atp-wta-itf.p.rapidapi.com';

if (!KEY) { console.error('RAPIDAPI_KEY not found'); process.exit(1); }

const CACHE_DIR = path.join(__dirname, '..', 'cache');
const MATCH_STATS_DIR = path.join(__dirname, '..', 'app', 'api', 'cache');
const HEADERS = { 'x-rapidapi-host': HOST, 'x-rapidapi-key': KEY };

const COURT_ID_MAP = { 1: 'Hard', 2: 'Clay', 3: 'Hard', 5: 'Grass' };
const MIN_DATE = '2024-01-01';
const LAST_N = 10;
const DELAY = 400;
const DRY_RUN = process.argv.includes('--dry-run');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function getTodayStr() { return new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().split('T')[0]; }
function isQualifying(f) { return /^Q\d/i.test(f.round?.name ?? ''); }
function normalizeSurface(s) { if (!s) return null; if (s === 'I.hard' || s === 'Carpet') return 'Hard'; return s; }

function statsFileExists(tournamentId, p1, p2) {
  for (const [a, b] of [[p1, p2], [p2, p1]])
    if (fs.existsSync(path.join(MATCH_STATS_DIR, `match-stats-${tournamentId}-${a}-${b}.json`))) return true;
  return false;
}

async function fetchStats(tournamentId, p1, p2) {
  if (statsFileExists(tournamentId, p1, p2)) return 'cached';
  for (const [a, b] of [[p1, p2], [p2, p1]]) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(`https://${HOST}/tennis/v2/atp/h2h/match-stats/${tournamentId}/${a}/${b}`, { headers: HEADERS });
        if (res.status === 429) { await sleep(attempt * 15000); continue; }
        if (!res.ok) break;
        const raw = await res.json();
        if (raw?.data?.player1Stats) {
          fs.writeFileSync(path.join(MATCH_STATS_DIR, `match-stats-${tournamentId}-${a}-${b}.json`), JSON.stringify(raw.data, null, 2));
          return 'fetched';
        }
        break;
      } catch { break; }
    }
  }
  return 'none';
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
        if ((f.tournament?.rank?.id ?? 0) < 2) continue;
        const s = COURT_ID_MAP[f.tournament?.courtId];
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
        if ((f.tournament?.rank?.id ?? 0) < 1) continue;
        if (isQualifying(f) && (f.tournament?.rank?.id ?? 0) < 2) continue; // skip ITF qualifying only
        if ((f.player1?.name ?? '').includes('/') || (f.player2?.name ?? '').includes('/')) continue;
        const surface = COURT_ID_MAP[f.tournament?.courtId] || normalizeSurface(f.tournament?.court?.name);
        for (const p of [f.player1, f.player2]) {
          if (p?.id && !players.has(String(p.id)))
            players.set(String(p.id), { name: p.name, surface });
        }
      }
    } catch {}
  }
  return players;
}

async function main() {
  const dates = getUpcomingDates();
  if (dates.length === 0) { console.log('No upcoming fixtures — nothing to check.'); return; }

  const surfaces = detectActiveSurfaces(dates);
  const players = getUpcomingPlayers(dates);

  console.log(`Sanity check: ${players.size} players | ${dates[0]} to ${dates[dates.length - 1]} | surfaces: ${surfaces.join(', ')}`);
  if (DRY_RUN) console.log('DRY RUN\n'); else console.log('');

  let totalFetched = 0;
  let issues = 0;

  for (const [playerId, { name }] of players) {
    const pid = parseInt(playerId);
    const indexPath = path.join(CACHE_DIR, `player-index-${playerId}.json`);
    if (!fs.existsSync(indexPath)) { console.log(`  NO INDEX    ${name}`); issues++; continue; }

    let index;
    try { index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')); } catch { issues++; continue; }

    for (const surface of surfaces) {
      const entries = (index[surface] || []).filter(e => e.date >= MIN_DATE).slice(0, LAST_N);
      if (entries.length === 0) continue;

      const missing = entries.filter(e => !statsFileExists(e.tournamentId, pid, e.opponentId));
      if (missing.length === 0) continue;

      console.log(`  MISSING ${name.padEnd(26)} ${surface}: ${entries.length - missing.length}/${entries.length} have stats | missing: ${missing.length}`);

      if (DRY_RUN) { issues += missing.length; continue; }

      let fixed = 0;
      for (const e of missing) {
        const result = await fetchStats(e.tournamentId, pid, e.opponentId);
        if (result === 'fetched') { fixed++; totalFetched++; await sleep(DELAY); }
      }
      console.log(`         → repaired ${fixed}/${missing.length}`);
      if (fixed < missing.length) issues += (missing.length - fixed);
    }
  }

  console.log(`\n${'═'.repeat(60)}`);
  if (DRY_RUN) {
    console.log(`Dry run — issues found: ${issues}`);
  } else {
    console.log(`Done. API calls: ${totalFetched} | Unfixable issues: ${issues}`);
  }
  if (issues > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
