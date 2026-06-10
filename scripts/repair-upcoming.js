#!/usr/bin/env node
/**
 * Verify + repair upcoming fixture data in one pass.
 * Runs after prebuild-cache and prebuild-match-stats as a safety net.
 *
 * For each player in the next 4 days of ATP fixtures:
 *   - Missing player index → fetches it
 *   - Missing stats file for any of their last 10 surface matches → fetches it
 *   - Zero surface matches (genuine API gap) → warns, cannot fix
 *
 * Exit code 1 if unfixable issues remain after repair attempts.
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
const HOST = env.match(/RAPIDAPI_HOST=(.+)/)?.[1]?.trim() || 'tennis-api-atp-wta-itf.p.rapidapi.com';

if (!KEY) { console.error('RAPIDAPI_KEY not found in .env.local'); process.exit(1); }

const CACHE_DIR = path.join(__dirname, '..', 'cache');
const MATCH_STATS_DIR = path.join(__dirname, '..', 'app', 'api', 'cache');
const HEADERS = { 'x-rapidapi-host': HOST, 'x-rapidapi-key': KEY };

const COURT_ID_MAP = { 1: 'Hard', 2: 'Clay', 3: 'Hard', 5: 'Grass' };
const ALL_SURFACES = ['Clay', 'Hard', 'Grass'];
const MIN_DATE = '2024-01-01';
const LAST_N = 10;
const DELAY = 400;
const MAX_PAGES = 5;
const DRY_RUN = process.argv.includes('--dry-run');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getTodayStr() {
  return new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().split('T')[0];
}

function normalizeSurface(s) {
  if (!s) return null;
  if (s === 'I.hard' || s === 'Carpet') return 'Hard';
  return s;
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

// ── Upcoming fixture data ─────────────────────────────────────────────────────

function getUpcomingDates() {
  return Array.from({ length: 5 }, (_, d) => {
    const dt = new Date(Date.now() + 2 * 60 * 60 * 1000 + d * 86400000);
    return dt.toISOString().split('T')[0];
  }).filter(d => {
    const fp = path.join(CACHE_DIR, `fixtures-${d}.json`);
    if (!fs.existsSync(fp)) return false;
    try { const data = JSON.parse(fs.readFileSync(fp, 'utf-8')); return (data.fixtures?.length ?? 0) > 0; }
    catch { return false; }
  });
}

function detectActiveSurfaces(dates) {
  const detected = new Set();
  for (const date of dates) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `fixtures-${date}.json`), 'utf-8'));
      for (const f of (data.fixtures || [])) {
        if ((f.tournament?.rank?.id ?? 0) < 2) continue; // ATP250+ only
        const s = COURT_ID_MAP[f.tournament?.courtId];
        if (s) detected.add(s);
      }
    } catch {}
  }
  return detected.size > 0 ? [...detected] : ALL_SURFACES;
}

function getUpcomingPlayers(dates) {
  const players = new Map(); // id -> { name, surface }
  for (const date of dates) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `fixtures-${date}.json`), 'utf-8'));
      for (const f of (data.fixtures || [])) {
        if ((f.tournament?.rank?.id ?? 0) < 1) continue; // skip ITF
        if ((f.player1?.name ?? '').includes('/') || (f.player2?.name ?? '').includes('/')) continue;
        const surface = COURT_ID_MAP[f.tournament?.courtId] || normalizeSurface(f.tournament?.court?.name);
        for (const p of [f.player1, f.player2]) {
          if (p?.id && !players.has(String(p.id))) {
            players.set(String(p.id), { name: p.name, surface });
          }
        }
      }
    } catch {}
  }
  return players;
}

// ── Player index fetch (minimal, for repair only) ─────────────────────────────

async function fetchAndSaveIndex(playerId, targetSurface) {
  const pid = parseInt(playerId);
  const existing = { Clay: [], Hard: [], Grass: [] };
  const fp = path.join(CACHE_DIR, `player-index-${playerId}.json`);
  if (fs.existsSync(fp)) {
    try { Object.assign(existing, JSON.parse(fs.readFileSync(fp, 'utf-8'))); } catch {}
  }

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://${HOST}/tennis/v2/atp/player/past-matches/${playerId}?pageSize=100&pageNo=${page}&include=tournament,tournament.court`;
    let matches = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, { headers: HEADERS });
        if (res.status === 429) { await sleep(attempt * 15000); continue; }
        if (!res.ok) break;
        matches = (await res.json()).data ?? [];
        break;
      } catch { break; }
    }
    if (matches.length === 0) break;

    for (const m of matches) {
      const surface = getSurface(m);
      if (!surface) continue;
      const isP1 = m.player1Id === pid;
      const opponentId = isP1 ? m.player2Id : m.player1Id;
      const opponentName = isP1 ? m.player2?.name : m.player1?.name;
      const entry = {
        id: String(m.id),
        date: (m.date || '').slice(0, 10),
        tournamentId: m.tournamentId,
        tournamentName: m.tournament?.name,
        opponentId,
        opponentName,
        won: m.match_winner === pid,
        result: m.result,
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
    if (matches.length < 100) break;
    await sleep(DELAY);
  }

  existing.updatedAt = Date.now();
  fs.writeFileSync(fp, JSON.stringify(existing, null, 2));
  return existing;
}

// ── Stats file fetch ──────────────────────────────────────────────────────────

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
        if (res.status === 429) { await sleep(attempt * 15000); continue; }
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

function statsFileExists(tournamentId, p1, p2) {
  for (const [a, b] of [[p1, p2], [p2, p1]]) {
    if (fs.existsSync(path.join(MATCH_STATS_DIR, `match-stats-${tournamentId}-${a}-${b}.json`))) return true;
  }
  return false;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const dates = getUpcomingDates();
  if (dates.length === 0) { console.log('No upcoming fixtures found — nothing to repair.'); return; }

  const surfaces = detectActiveSurfaces(dates);
  const players = getUpcomingPlayers(dates);

  console.log(`Repair check: ${players.size} players | dates: ${dates.join(', ')} | surfaces: ${surfaces.join(', ')}`);
  if (DRY_RUN) console.log('DRY RUN — no API calls will be made\n');
  else console.log('');

  let repairedIndexes = 0;
  let repairedStats = 0;
  let warnings = 0;

  for (const [playerId, { name, surface: fixtureSurface }] of players) {
    const pid = parseInt(playerId);
    const indexPath = path.join(CACHE_DIR, `player-index-${playerId}.json`);
    let index = null;

    // ── 1. Check / repair player index ───────────────────────────────────────
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

    // ── 2. Check surface coverage ─────────────────────────────────────────────
    const surfaceIssues = [];
    for (const s of surfaces) {
      const entries = (index[s] || []).filter(e => e.date >= MIN_DATE);
      if (entries.length === 0) surfaceIssues.push(s);
    }
    if (surfaceIssues.length > 0) {
      console.log(`  WARN 0 matches ${name.padEnd(24)} surfaces: ${surfaceIssues.join(', ')} (API gap or pre-2024)`);
      warnings++;
    }

    // ── 3. Check / repair stats files ─────────────────────────────────────────
    const missingStats = [];
    for (const s of surfaces) {
      const entries = (index[s] || []).filter(e => e.date >= MIN_DATE).slice(0, LAST_N);
      for (const e of entries) {
        if (!statsFileExists(e.tournamentId, pid, e.opponentId)) {
          missingStats.push({ tournamentId: e.tournamentId, p1: pid, p2: e.opponentId, surface: s, date: e.date });
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
    for (const { tournamentId, p1, p2 } of missingStats) {
      const result = await fetchStats(tournamentId, p1, p2);
      if (result === 'fetched') { fixed++; repairedStats++; await sleep(DELAY); }
    }
    console.log(` ${fixed}/${missingStats.length} fixed`);
  }

  // ── Final report ─────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  if (DRY_RUN) {
    console.log(`Dry run complete. Warnings: ${warnings}`);
  } else {
    console.log(`Repair complete. Indexes fetched: ${repairedIndexes} | Stats fetched: ${repairedStats} | Warnings (unfixable): ${warnings}`);
  }

  if (warnings > 0) {
    console.log('Warnings above = genuine API gaps (player has no recorded matches on this surface since 2024).');
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
