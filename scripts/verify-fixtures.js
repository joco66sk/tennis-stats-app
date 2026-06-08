#!/usr/bin/env node
/**
 * Deep-verifies fixture data correctness using player-index-*.json format.
 *
 * For clean players: one compact summary line.
 * For any issue: expands to show the exact file, field values, and what the
 * code would do with them — so you know the precise problem, not just "something's wrong".
 *
 * Issues detected:
 *   - Missing player-index cache
 *   - Zero matches on the fixture surface (post-2025)
 *   - Stats perspective: player ID in stats file doesn't match either player slot
 *   - Stats sanity: impossible serve numbers (div/0, out-of-range %)
 *
 * Usage:
 *   node scripts/verify-fixtures.js               today
 *   node scripts/verify-fixtures.js 2026-05-10    specific date
 *   node scripts/verify-fixtures.js 2026-05-10 5  limit=5 matches
 *   node scripts/verify-fixtures.js 2026-05-10 10 --all   show match list for OK players too
 *   node scripts/verify-fixtures.js --all-levels  include Challenger/ITF
 */

const fs   = require('fs');
const path = require('path');

const CACHE_DIR       = path.join(__dirname, '..', 'cache');
const MATCH_STATS_DIR = path.join(__dirname, '..', 'app', 'api', 'cache');
const COURT_ID_MAP    = { 1: 'Hard', 2: 'Clay', 3: 'Hard', 5: 'Grass' };
const MIN_STATS_DATE  = '2025-01-01';

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeSurface(s) {
  if (!s) return null;
  if (s === 'I.hard' || s === 'Carpet') return 'Hard';
  return s;
}

function loadMatchStats(tournamentId, pid, opponentId) {
  for (const [a, b] of [[pid, opponentId], [opponentId, pid]]) {
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

function computeStats(s) {
  if (!s) return null;
  const svPct  = fmtPct(s.firstServe, s.firstServeOf);
  const fswPct = fmtPct(s.winningOnFirstServe, s.firstServe);
  const sswPct = fmtPct(s.winningOnSecondServe, s.firstServeOf - s.firstServe);
  return `1sv:${svPct} 1sw:${fswPct} 2sw:${sswPct} ace:${s.aces ?? '?'} df:${s.doubleFaults ?? '?'}`;
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

// ── Main ──────────────────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const date      = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || getTodayStr();
const LIMIT     = parseInt(args.find(a => /^\d+$/.test(a)) || '10');
const SHOW_ALL       = args.includes('--all');
const ATP_ONLY       = !args.includes('--all-levels');
const SKIP_QUALIFYING = !args.includes('--with-qualifying');

const fixturePath = path.join(CACHE_DIR, `fixtures-${date}.json`);
if (!fs.existsSync(fixturePath)) {
  console.error(`No fixture cache for ${date}.\nRun: node scripts/prefetch-fixtures.js`);
  process.exit(1);
}

const fixtureData = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
const allFixtures = (fixtureData.fixtures || []).filter(f =>
  f.player1?.id && f.player2?.id &&
  !String(f.player1?.name ?? '').includes('/') && !String(f.player2?.name ?? '').includes('/')
);
let fixtures = ATP_ONLY ? allFixtures.filter(f => (f.tournament?.rank?.id ?? 0) >= 1) : allFixtures;
const skippedITF = allFixtures.length - fixtures.length;
const skippedQualifying = SKIP_QUALIFYING ? fixtures.filter(f => /^Q\d/i.test(f.round?.name ?? '')).length : 0;
if (SKIP_QUALIFYING) fixtures = fixtures.filter(f => !/^Q\d/i.test(f.round?.name ?? ''));

const skipNotes = [
  ATP_ONLY && skippedITF > 0 ? `skipping ${skippedITF} ITF` : null,
  SKIP_QUALIFYING && skippedQualifying > 0 ? `skipping ${skippedQualifying} qualifying` : null,
].filter(Boolean).join(', ');
console.log(`\nVerifying ${fixtures.length} fixtures for ${date}  (last ${LIMIT} surface matches post-${MIN_STATS_DATE}${SHOW_ALL ? ', --all' : ''}${skipNotes ? ` — ${skipNotes}` : ''})`);

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
  const courtId   = sample.tournament?.courtId;
  const surface   = COURT_ID_MAP[courtId] || normalizeSurface(sample.tournament?.court?.name) || 'Unknown';
  const surfLabel = courtId ? `${surface} · courtId:${courtId}` : surface;

  console.log(`\n${'─'.repeat(62)}`);
  console.log(`${tournName}  [${surfLabel}]`);

  for (const fixture of matches) {
    const round = fixture.round?.name || '';

    for (const player of [fixture.player1, fixture.player2]) {
      const pid       = player.id;
      const indexPath = path.join(CACHE_DIR, `player-index-${pid}.json`);

      // ── Missing index ────────────────────────────────────────────────────
      if (!fs.existsSync(indexPath)) {
        console.log(`  ✗ ${player.name.padEnd(24)} NO INDEX FILE  → node scripts/prebuild-cache.js ${date}`);
        totalIssues++;
        continue;
      }

      let indexData;
      try { indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8')); }
      catch { console.log(`  ✗ ${player.name.padEnd(24)} INDEX PARSE ERROR`); totalIssues++; continue; }

      // ── Surface filter — same logic as the app ───────────────────────────
      const surfaceEntries = (indexData[surface] || [])
        .filter(e => e.date >= MIN_STATS_DATE)
        .slice(0, LIMIT);

      if (surfaceEntries.length === 0) {
        const found = ['Clay', 'Hard', 'Grass'].filter(s => (indexData[s] || []).filter(e => e.date >= MIN_STATS_DATE).length > 0);
        const rawCounts = ['Clay', 'Hard', 'Grass'].map(s => `${s}:${(indexData[s] || []).length}`).join(' ');
        console.log(`  ? ${player.name.padEnd(24)} 0 ${surface} matches post-${MIN_STATS_DATE}  (all: ${rawCounts})`);
        totalIssues++;
        continue;
      }

      const wins   = surfaceEntries.filter(e => e.won).length;
      const losses = surfaceEntries.length - wins;
      const printLines = [];
      let   hasError   = false;

      for (const e of surfaceEntries) {
        const wl     = e.won ? 'W' : 'L';
        const result = e.result || '—';
        const baseLine = `    ${wl}  ${e.date}  ${(e.opponentName || 'Unknown').padEnd(22)}  ${result.padEnd(16)}`;

        const found = loadMatchStats(e.tournamentId, pid, e.opponentId);
        if (found) {
          const { data: stats, file: statsFile } = found;
          const statsP1id = stats.player1Stats?.player1Id;
          const statsP2id = stats.player2Stats?.player2Id;
          const isP1      = statsP1id === pid;
          const isP2      = statsP2id === pid;
          const myStats   = isP1 ? stats.player1Stats : (isP2 ? stats.player2Stats : null);
          const sane      = myStats ? sanityCheck(myStats) : [];

          if (!isP1 && !isP2) {
            printLines.push(`${baseLine}`);
            printLines.push(`       ✗ STATS MISMATCH  file: ${statsFile}`);
            printLines.push(`         file has: p1Stats.player1Id=${statsP1id}  p2Stats.player2Id=${statsP2id}`);
            printLines.push(`         expected pid ${pid} in either slot — stats will be SKIPPED by the app`);
            hasError = true;
          } else if (sane.length > 0) {
            printLines.push(`${baseLine}`);
            printLines.push(`       ✗ STATS SANITY FAIL: ${sane.join(', ')}`);
            printLines.push(`         file: ${statsFile}  pid:${pid} is ${isP1 ? 'p1' : 'p2'}`);
            hasError = true;
          } else if (SHOW_ALL) {
            const statStr = myStats ? computeStats(myStats) : '[no stats]';
            printLines.push(`${baseLine}  ${statStr}`);
          }
        } else {
          // No stats file — not an error, just noted with --all
          if (SHOW_ALL) printLines.push(`${baseLine}  [no stats]`);
        }
      }

      const statsCount = surfaceEntries.filter(e => loadMatchStats(e.tournamentId, pid, e.opponentId)).length;
      // Warn if player has enough matches but zero stats files — likely a missing prebuild
      if (!hasError && statsCount === 0 && surfaceEntries.length >= 3) {
        printLines.push(`       ⚠ NO STATS: ${surfaceEntries.length} ${surface} matches found but 0 stats files — run: node scripts/prebuild-match-stats.js upcoming`);
        hasError = true;
      }

      if (hasError) totalIssues++;
      totalChecked++;

      const icon       = hasError ? '✗' : '✓';
      const roundTag   = round ? `  [${round}]` : '';
      const updatedAt  = indexData.updatedAt ? new Date(indexData.updatedAt).toISOString().slice(0, 16).replace('T', ' ') : '?';
      console.log(`  ${icon} ${player.name.padEnd(24)} ${wins}W-${losses}L  ${surfaceEntries.length}/${LIMIT} ${surface}  stats:${statsCount}/${surfaceEntries.length}  updated:${updatedAt}${roundTag}`);

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
