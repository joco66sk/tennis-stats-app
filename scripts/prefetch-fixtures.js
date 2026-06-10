#!/usr/bin/env node
/**
 * Pre-fetches fixture files for today + next N days.
 * Usage:
 *   node scripts/prefetch-fixtures.js        (today + 3 days)
 *   node scripts/prefetch-fixtures.js 5      (today + 5 days)
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
const DAYS_AHEAD = parseInt(process.argv[2] || '3', 10);
const DAYS_PAST = (() => { const m = process.argv.find(a => a.startsWith('--past=')); return m ? parseInt(m.split('=')[1], 10) : 0; })();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getCetDate(offsetDays = 0) {
  const d = new Date(Date.now() + 2 * 60 * 60 * 1000 + offsetDays * 86400000);
  return d.toISOString().split('T')[0];
}

async function safeFetch(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.status === 429) { await sleep(attempt * 10000); continue; }
      if (!res.ok) return [];
      const json = await res.json();
      return json.data ?? [];
    } catch { return []; }
  }
  return [];
}

async function fetchFixtures(date) {
  const cacheFile = path.join(CACHE_DIR, `fixtures-${date}.json`);

  // Skip only if very recently fetched (< 90 min) — always re-fetch to catch rain delays / withdrawals
  if (fs.existsSync(cacheFile)) {
    const existing = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    if ((existing.fixtures?.length ?? 0) > 0) {
      const age = Date.now() - fs.statSync(cacheFile).mtimeMs;
      if (age < 90 * 60 * 1000) {
        console.log(`  ${date}: skipped (fetched ${Math.round(age / 60000)}m ago)`);
        return;
      }
    }
  }

  console.log(`  ${date}: fetching...`);
  const year = new Date().getFullYear();

  const [p1, p2, p3, cal1, cal2, cal3] = await Promise.all([
    safeFetch(`https://${HOST}/tennis/v2/atp/fixtures/${date}?include=tournament,tournament.court,tournament.rank,round&filter=PlayerGroup:singles&pageSize=50&pageNo=1`),
    safeFetch(`https://${HOST}/tennis/v2/atp/fixtures/${date}?include=tournament,tournament.court,tournament.rank,round&filter=PlayerGroup:singles&pageSize=50&pageNo=2`),
    safeFetch(`https://${HOST}/tennis/v2/atp/fixtures/${date}?include=tournament,tournament.court,tournament.rank,round&filter=PlayerGroup:singles&pageSize=50&pageNo=3`),
    safeFetch(`https://${HOST}/tennis/v2/atp/tournament/calendar/${year}?include=court&pageSize=50&pageNo=1`),
    safeFetch(`https://${HOST}/tennis/v2/atp/tournament/calendar/${year}?include=court&pageSize=50&pageNo=2`),
    safeFetch(`https://${HOST}/tennis/v2/atp/tournament/calendar/${year}?include=court&pageSize=50&pageNo=3`),
  ]);

  const calendarMap = Object.fromEntries([...cal1, ...cal2, ...cal3].map(t => [t.id, t]));

  const seen = new Set();
  const fixtures = [...p1, ...p2, ...p3]
    .filter(f => { if (seen.has(f.id)) return false; seen.add(f.id); return true; })
    .filter(f => !String(f.player1?.name ?? '').includes('/') && !String(f.player2?.name ?? '').includes('/'))
    .map(f => ({
      ...f,
      tournament: {
        ...f.tournament,
        rank: calendarMap[f.tournamentId]?.rank ?? f.tournament?.rank,
      },
    }))
    .sort((a, b) => (b.tournament?.rank?.id ?? 0) - (a.tournament?.rank?.id ?? 0));

  // Don't overwrite a non-empty cache with 0 results
  if (fixtures.length === 0 && fs.existsSync(cacheFile)) {
    const existing = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    if ((existing.fixtures?.length ?? 0) > 0) {
      console.log(`  ${date}: API returned 0, keeping existing ${existing.fixtures.length} fixtures`);
      return;
    }
  }

  fs.writeFileSync(cacheFile, JSON.stringify({ date, fixtures, count: fixtures.length, fetchedAt: Date.now() }, null, 2));
  console.log(`  ${date}: saved ${fixtures.length} fixtures`);
}

async function main() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const totalDays = DAYS_PAST + DAYS_AHEAD;
  console.log(`Prefetching fixtures: ${DAYS_PAST} days past, today, ${DAYS_AHEAD} days ahead...`);
  for (let i = -DAYS_PAST; i <= DAYS_AHEAD; i++) {
    await fetchFixtures(getCetDate(i));
    if (i < DAYS_AHEAD) await sleep(500);
  }
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
