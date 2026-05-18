#!/usr/bin/env node
/**
 * Deep-verifies fixture data correctness.
 *
 * For clean players: one compact summary line.
 * For any issue: expands to show the exact file, field values, and what the
 * code would do with them — so you know the precise problem, not just "something's wrong".
 *
 * Issues detected:
 *   - Missing player-matches cache
 *   - Zero matches on the fixture surface
 *   - Stats perspective: player ID in stats file doesn't match either player slot
 *   - Stats sanity: impossible serve numbers (div/0, out-of-range %)
 *   - Surface detection: shows the source (courtId / court.name / surfmap / unknown)
 *   - Stale / shallow cache: old age, < 3 pages on non-deepSeeded file
 *   - Duplicate match IDs in cache
 *
 * Usage:
 *   node scripts/verify-fixtures.js               today
 *   node scripts/verify-fixtures.js 2026-05-10    specific date
 *   node scripts/verify-fixtures.js 2026-05-10 5  limit=5 matches
 *   node scripts/verify-fixtures.js 2026-05-10 10 --all   show match list for OK players too
 */

const fs   = require('fs');
const path = require('path');

const CACHE_DIR       = path.join(__dirname, '..', 'cache');
const MATCH_STATS_DIR = path.join(__dirname, '..', 'app', 'api', 'cache');
const COURT_ID_MAP    = { 1: 'Hard', 2: 'Clay', 3: 'Hard', 5: 'Grass' };

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeSurface(s) {
  if (!s) return null;
  if (s === 'I.hard' || s === 'Carpet') return 'Hard';
  return s;
}

function getMatchSurface(m, surfaceMap) {
  const courtId = m.tournament?.courtId;
  if (COURT_ID_MAP[courtId]) return { surface: COURT_ID_MAP[courtId], source: `courtId:${courtId}` };
  const name = m.tournament?.court?.name;
  if (name) return { surface: normalizeSurface(name), source: 'court.name' };
  const mapped = surfaceMap[m.tournamentId];
  if (mapped) return { surface: normalizeSurface(mapped), source: 'surfmap' };
  return { surface: null, source: '?' };
}

function loadSurfaceMap() {
  const map = {};
  try {
    for (const file of fs.readdirSync(CACHE_DIR)) {
      if (!/^surfaces-\d{4}\.json$/.test(file)) continue;
      const data = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf-8'));
      for (const [id, surface] of Object.entries(data))
        map[parseInt(id)] = surface;
    }
  } catch {}
  return map;
}

function loadMatchStats(tournamentId, p1id, p2id) {
  for (const [a, b] of [[p1id, p2id], [p2id, p1id]]) {
    const fp = path.join(MATCH_STATS_DIR, `match-stats-${tournamentId}-${a}-${b}.json`);
    if (fs.existsSync(fp)) {
      try { return { data: JSON.parse(fs.readFileSync(fp, 'utf-8')), file: `match-stats-${tournamentId}-${a}-${b}.json` }; }
      catch {}
    }
  }
  return null;
}

function fmtPct(num, den) {
  if (!den || den === 0) return 'n/a';
  return (num / den * 100).toFixed(0) + '%';
}

function computeStats(s, pid) {
  if (!s) return null;
  const svPct  = fmtPct(s.firstServe, s.firstServeOf);
  const fswPct = fmtPct(s.winningOnFirstServe, s.firstServe);
  const sswPct = fmtPct(s.winningOnSecondServe, s.firstServeOf - s.firstServe);
  return `1sv:${svPct} 1sw:${fswPct} 2sw:${sswPct} ace:${s.aces ?? '?'} df:${s.doubleFaults ?? '?'} bp:${s.breakPointSavedGm ?? '?'}/${s.breakPointFacedGm ?? '?'}`;
}

function sanityCheck(s) {
  const issues = [];
  if (!s.firstServeOf || s.firstServeOf === 0) { issues.push('firstServeOf=0 (division by zero)'); return issues; }
  const sv = s.firstServe / s.firstServeOf;
  if (sv < 0.30) issues.push(`1sv%=${(sv*100).toFixed(0)}% (suspiciously low, <30%)`);
  if (sv > 0.95) issues.push(`1sv%=${(sv*100).toFixed(0)}% (impossibly high, >95%)`);
  if (s.firstServe > s.firstServeOf) issues.push('firstServe > firstServeOf (impossible)');
  if ((s.aces ?? 0) > 40)  issues.push(`aces=${s.aces} (suspiciously high)`);
  if ((s.doubleFaults ?? 0) > 30) issues.push(`doubleFaults=${s.doubleFaults} (suspiciously high)`);
  return issues;
}

function getTodayStr() {
  return new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().split('T')[0];
}

// Scans fixture files between afterDate and beforeDate to find dates where
// `pid` appears in a match for `tournId` — these are the dates to run
// prebuild-cache.js on to fetch the missing opponents.
function findMissingOpponentDates(pid, tournId, afterDate, beforeDate) {
  const dates = [];
  try {
    for (const file of fs.readdirSync(CACHE_DIR)) {
      if (!/^fixtures-(\d{4}-\d{2}-\d{2})\.json$/.test(file)) continue;
      const fileDate = file.slice(9, 19);
      if (afterDate && fileDate <= afterDate) continue;
      if (fileDate >= beforeDate) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf-8'));
        const hasMatch = (data.fixtures || []).some(
          f => f.tournamentId === tournId && (f.player1Id === pid || f.player2Id === pid)
        );
        if (hasMatch && !dates.includes(fileDate)) dates.push(fileDate);
      } catch {}
    }
  } catch {}
  return dates.sort();
}

// ── Main ──────────────────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const date      = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || getTodayStr();
const LIMIT     = parseInt(args.find(a => /^\d+$/.test(a)) || '10');
const SHOW_ALL       = args.includes('--all');
const ATP_ONLY       = !args.includes('--all-levels');
const SKIP_QUALIFYING = !args.includes('--with-qualifying');
const today     = getTodayStr();
// Stale threshold: 4h for today's fixtures, 24h for tomorrow, ignore for past
const STALE_H  = date === today ? 4 : (date > today ? 24 : Infinity);

const fixturePath = path.join(CACHE_DIR, `fixtures-${date}.json`);
if (!fs.existsSync(fixturePath)) {
  console.error(`No fixture cache for ${date}.\nRun: node scripts/prebuild-cache.js ${date}`);
  process.exit(1);
}

const fixtureData = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
const allFixtures = (fixtureData.fixtures || []).filter(f =>
  f.player1?.id && f.player2?.id &&
  !String(f.player1?.name ?? '').includes('/') && !String(f.player2?.name ?? '').includes('/')
);
let fixtures = ATP_ONLY ? allFixtures.filter(f => (f.tournament?.rank?.id ?? 0) >= 2) : allFixtures;
const skippedChallengerITF = allFixtures.length - fixtures.length;
const skippedQualifying = SKIP_QUALIFYING ? fixtures.filter(f => /^Q\d/i.test(f.round?.name ?? '')).length : 0;
if (SKIP_QUALIFYING) fixtures = fixtures.filter(f => !/^Q\d/i.test(f.round?.name ?? ''));
const surfaceMap  = loadSurfaceMap();

const skipNotes = [
  ATP_ONLY && skippedChallengerITF > 0 ? `skipping ${skippedChallengerITF} Challenger/ITF` : null,
  SKIP_QUALIFYING && skippedQualifying > 0 ? `skipping ${skippedQualifying} qualifying` : null,
].filter(Boolean).join(', ');
console.log(`\nVerifying ${fixtures.length} fixtures for ${date}  (last ${LIMIT} surface matches${SHOW_ALL ? ', --all' : ''}${skipNotes ? ` — ${skipNotes}` : ''})`);

let totalIssues  = 0;
let totalChecked = 0;

// Group fixtures by tournament for cleaner output
const byTournament = [];
const seen = new Map();
for (const f of fixtures) {
  const key = f.tournament?.name || 'Unknown';
  if (!seen.has(key)) { seen.set(key, []); byTournament.push([key, seen.get(key)]); }
  seen.get(key).push(f);
}

for (const [tournName, matches] of byTournament) {
  const sample    = matches[0];
  const surface   = normalizeSurface(sample.tournament?.court?.name) || 'Unknown';
  const courtId   = sample.tournament?.courtId;
  const surfLabel = courtId ? `${surface} · courtId:${courtId}` : surface;

  console.log(`\n${'─'.repeat(62)}`);
  console.log(`${tournName}  [${surfLabel}]`);

  for (const fixture of matches) {
    const round = fixture.round?.name || '';

    for (const player of [fixture.player1, fixture.player2]) {
      const pid       = player.id;
      const matchPath = path.join(CACHE_DIR, `player-matches-${pid}.json`);

      // ── Missing cache ────────────────────────────────────────────────────
      if (!fs.existsSync(matchPath)) {
        console.log(`  ✗ ${player.name.padEnd(24)} NO CACHE FILE  → npm run cache:date ${date}`);
        totalIssues++;
        continue;
      }

      const matchData    = JSON.parse(fs.readFileSync(matchPath, 'utf-8'));
      const allMatches   = matchData.matches || [];
      const ageH         = ((Date.now() - (matchData.cachedAt ?? 0)) / 3600000).toFixed(0);
      const pages        = matchData.pages ?? '?';
      const deepSeeded   = matchData.deepSeeded ? 'deep' : `${pages}p`;
      const cacheNote    = `cache:${ageH}h ${deepSeeded}`;

      // ── Duplicate IDs ────────────────────────────────────────────────────
      const idCounts = {};
      for (const m of allMatches) idCounts[m.id] = (idCounts[m.id] || 0) + 1;
      const dupes = Object.entries(idCounts).filter(([, c]) => c > 1).map(([id]) => id);

      // ── Surface filter — same logic as the app ───────────────────────────
      const sorted         = [...allMatches].sort((a, b) => new Date(b.date) - new Date(a.date));
      const surfaceMatches = sorted.filter(m => getMatchSurface(m, surfaceMap).surface === surface).slice(0, LIMIT);

      if (surfaceMatches.length === 0) {
        const found = [...new Set(sorted.map(m => getMatchSurface(m, surfaceMap).surface).filter(Boolean))];
        console.log(`  ? ${player.name.padEnd(24)} 0 ${surface} matches  (surfaces in cache: ${found.join(', ') || 'none'})  ${cacheNote}`);
        totalIssues++;
        continue;
      }

      const wins   = surfaceMatches.filter(m => m.match_winner === pid).length;
      const losses = surfaceMatches.length - wins;

      // ── Tournament-completeness check ────────────────────────────────────
      // Detects missing intermediate rounds (e.g. Rublev in QF but last cached
      // match was R3 three days earlier — R4 is missing from cache).
      const printLines = [];
      let   hasError   = false;

      const tournId = fixture.tournamentId;
      const fixtureDate = (fixture.date || '').slice(0, 10);
      const tournInCache = allMatches
        .filter(m => m.tournamentId === tournId)
        .sort((a, b) => new Date(b.date) - new Date(a.date));

      if (tournInCache.length > 0) {
        const lastTM    = tournInCache[0];
        const lastDate  = (lastTM.date || '').slice(0, 10);
        const gapDays   = Math.round((new Date(fixtureDate) - new Date(lastDate)) / 86400000);
        if (gapDays >= 3) {
          const oppName = lastTM.player1Id === pid ? lastTM.player2?.name : lastTM.player1?.name;
          printLines.push(`       ⚠ TOURNAMENT GAP: last cached match was ${lastDate} vs ${oppName || '?'} — ${gapDays}d before this fixture`);
          printLines.push(`         ${tournInCache.length} match(es) from this tournament in cache; intermediate round(s) likely missing`);

          // Scan intermediate fixture files to find the missing opponents
          const missingDates = findMissingOpponentDates(pid, tournId, lastDate, fixtureDate);
          if (missingDates.length > 0) {
            printLines.push(`         Missing rounds found in fixture files on: ${missingDates.join(', ')}`);
            for (const md of missingDates)
              printLines.push(`         Fix: node scripts/prebuild-cache.js ${md}`);
          } else {
            printLines.push(`         Fix: node scripts/prebuild-cache.js ${today}  (re-fetch after API lag clears)`);
          }
          hasError = true;
        }
      } else if (fixtureDate < today) {
        // Past fixture — player should have at least one match from this tournament
        const missingDates = findMissingOpponentDates(pid, tournId, null, fixtureDate);
        printLines.push(`       ⚠ TOURNAMENT GAP: 0 matches from this tournament in cache`);
        if (missingDates.length > 0) {
          for (const md of missingDates)
            printLines.push(`         Fix: node scripts/prebuild-cache.js ${md}`);
        }
        hasError = true;
      }

      for (let i = 0; i < surfaceMatches.length; i++) {
        const m      = surfaceMatches[i];
        const dateS  = (m.date || '').slice(0, 10);
        const opp    = m.player1Id === pid ? m.player2?.name : m.player1?.name;
        const wl     = m.match_winner === pid ? 'W' : (m.match_winner == null ? '?' : 'L');
        const result = m.result || '—';
        const { surface: detectedSurf, source: surfSource } = getMatchSurface(m, surfaceMap);
        const surfTag = detectedSurf === surface ? `[${surfSource}]` : `[${surfSource}→${detectedSurf} ← WRONG]`;
        const baseLine = `    ${wl}  ${dateS}  ${(opp || 'Unknown').padEnd(22)}  ${result.padEnd(16)}`;

        // Winner sanity
        if (m.match_winner != null && m.match_winner !== m.player1Id && m.match_winner !== m.player2Id) {
          printLines.push(`${baseLine}  ⚠ match_winner=${m.match_winner} ≠ player1Id(${m.player1Id}) or player2Id(${m.player2Id})`);
          hasError = true;
          continue;
        }

        // Stats file check
        const found = loadMatchStats(m.tournamentId, m.player1Id, m.player2Id);
        if (found) {
          const { data: stats, file: statsFile } = found;
          const statsP1id = stats.player1Stats?.player1Id;
          const statsP2id = stats.player2Stats?.player2Id;
          const isP1      = statsP1id === pid;
          const isP2      = statsP2id === pid;
          const myStats   = isP1 ? stats.player1Stats : (isP2 ? stats.player2Stats : null);
          const statStr   = myStats ? computeStats(myStats) : null;
          const sane      = myStats ? sanityCheck(myStats) : [];

          if (!isP1 && !isP2) {
            printLines.push(`${baseLine}  ${surfTag}`);
            printLines.push(`       ✗ STATS MISMATCH  file: ${statsFile}`);
            printLines.push(`         file has: p1Stats.player1Id=${statsP1id}  p2Stats.player2Id=${statsP2id}`);
            printLines.push(`         expected pid ${pid} in either slot — this match's stats will be SKIPPED by the app`);
            hasError = true;
          } else if (sane.length > 0) {
            printLines.push(`${baseLine}  ${surfTag}`);
            printLines.push(`       ✗ STATS SANITY FAIL: ${sane.join(', ')}`);
            printLines.push(`         file: ${statsFile}  pid:${pid} is ${isP1 ? 'p1' : 'p2'}`);
            hasError = true;
          } else if (detectedSurf !== surface) {
            printLines.push(`${baseLine}  ${surfTag}  ← wrong surface, should not appear in ${surface} filter`);
            hasError = true;
          } else if (SHOW_ALL) {
            printLines.push(`${baseLine}  ${statStr}  ${surfTag}`);
          }
        } else {
          // No stats file
          if (detectedSurf !== surface) {
            printLines.push(`${baseLine}  [no stats]  ${surfTag}  ← wrong surface`);
            hasError = true;
          } else if (SHOW_ALL) {
            printLines.push(`${baseLine}  [no stats]  ${surfTag}`);
          }
        }
      }

      // ── Stale / shallow cache warnings (don't count as ✗ errors) ────────
      const cacheWarnings = [];
      if (parseInt(ageH) > STALE_H) cacheWarnings.push(`cache ${ageH}h old`);
      if (!matchData.deepSeeded && (matchData.pages ?? 1) < 3)
        cacheWarnings.push(`only ${pages}p fetched (non-deepSeeded needs 3)`);
      if (dupes.length > 0)
        cacheWarnings.push(`${dupes.length} duplicate match ID(s): ${dupes.slice(0,3).join(', ')}`);

      const hasIssues = hasError;
      if (hasIssues) totalIssues++;
      totalChecked++;

      const statsCount = surfaceMatches.filter(m => loadMatchStats(m.tournamentId, m.player1Id, m.player2Id)).length;
      const icon       = hasIssues ? '✗' : '✓';
      const roundTag   = round ? `  [${round}]` : '';
      const warnStr    = cacheWarnings.length > 0 ? `  ⚠ ${cacheWarnings.join(' | ')}` : '';
      console.log(`  ${icon} ${player.name.padEnd(24)} ${wins}W-${losses}L  ${surfaceMatches.length}/${LIMIT} ${surface}  stats:${statsCount}/${surfaceMatches.length}  ${cacheNote}${roundTag}${warnStr}`);

      for (const l of printLines) console.log(l);
    }
  }
}

console.log(`\n${'═'.repeat(62)}`);
console.log(`Checked ${totalChecked} players across ${fixtures.length} fixtures`);
if (totalIssues === 0) {
  console.log('All data looks correct.');
} else {
  console.log(`Issues: ${totalIssues}  (✗ entries above — each shows exact field values and what the app does with them)`);
}
if (!SHOW_ALL) console.log('Tip: add --all to show every match line, not just problem ones.');
