#!/usr/bin/env node
/**
 * Pre-fetches fixture files for today + next N days.
 * Usage:
 *   node scripts/prefetch-fixtures.js        (today + 3 days)
 *   node scripts/prefetch-fixtures.js 5      (today + 5 days)
 *   node scripts/prefetch-fixtures.js 6 --past=2
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
const DAYS_AHEAD = parseInt(process.argv[2] || '3', 10);
const DAYS_PAST = (() => { const m = process.argv.find(a => a.startsWith('--past=')); return m ? parseInt(m.split('=')[1], 10) : 0; })();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getCetDate(offsetDays = 0) {
  const d = new Date(Date.now() + 2 * 60 * 60 * 1000 + offsetDays * 86400000);
  return d.toISOString().split('T')[0];
}

function getStockholmDate(timestamp) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date(timestamp * 1000));
}

function groundTypeToSurface(groundType) {
  if (!groundType) return null;
  const g = groundType.toLowerCase();
  if (g.includes('clay')) return 'Clay';
  if (g.includes('grass')) return 'Grass';
  if (g.includes('hard')) return 'Hard';
  return null;
}

function tennisPointsToRankId(points) {
  if (!points) return 0;
  if (points >= 2000) return 4;
  if (points >= 1000) return 3;
  if (points >= 250) return 2;
  return 1;
}

// Transforms a Sofascore event into the fixture shape expected by page.tsx
function transformEvent(event) {
  const surface = groundTypeToSurface(event.groundType)
    || groundTypeToSurface(event.tournament?.uniqueTournament?.groundType);
  const tp = event.tournament?.uniqueTournament?.tennisPoints ?? 0;
  const rankId = tennisPointsToRankId(tp);
  return {
    id: event.id,
    date: new Date(event.startTimestamp * 1000).toISOString(),
    player1: event.homeTeam ? {
      id: event.homeTeam.id,
      name: event.homeTeam.name,
      countryAcr: event.homeTeam.country?.alpha2 || undefined,
      ranking: event.homeTeam.ranking || undefined,
    } : undefined,
    player2: event.awayTeam ? {
      id: event.awayTeam.id,
      name: event.awayTeam.name,
      countryAcr: event.awayTeam.country?.alpha2 || undefined,
      ranking: event.awayTeam.ranking || undefined,
    } : undefined,
    tournament: {
      id: event.tournament?.uniqueTournament?.id,
      name: event.tournament?.uniqueTournament?.name || event.tournament?.name || '',
      court: surface ? { name: surface } : undefined,
      rank: { id: rankId, name: rankId >= 4 ? 'Grand Slam' : rankId >= 3 ? 'Masters 1000' : 'ATP250' },
    },
    round: event.roundInfo ? { name: event.roundInfo.name } : undefined,
  };
}

async function fetchFixtures(date) {
  const cacheFile = path.join(CACHE_DIR, `fixtures-${date}.json`);

  if (fs.existsSync(cacheFile)) {
    const existing = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    if ((existing.fixtures?.length ?? 0) > 0 && existing.fetchedAt) {
      const age = Date.now() - existing.fetchedAt;
      if (age < 90 * 60 * 1000) {
        console.log(`  ${date}: skipped (fetched ${Math.round(age / 60000)}m ago)`);
        return;
      }
    }
  }

  console.log(`  ${date}: fetching...`);
  const [y, m, d] = date.split('-');
  const url = `https://${HOST}/api/tennis/category/3/events/${parseInt(d)}/${parseInt(m)}/${y}`;

  let events = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.status === 429) { await sleep(attempt * 10000); continue; }
      if (!res.ok) { console.log(`  ${date}: HTTP ${res.status}`); break; }
      const json = await res.json();
      events = json.events ?? [];
      break;
    } catch (e) { console.log(`  ${date}: error — ${e.message}`); break; }
  }

  const seen = new Set();
  const fixtures = events
    .filter(e => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      if (!e.homeTeam || !e.awayTeam) return false;
      if ((e.homeTeam.name || '').includes('/') || (e.awayTeam.name || '').includes('/')) return false;
      const tp = e.tournament?.uniqueTournament?.tennisPoints ?? 0;
      if (tp < 250) return false;
      // Only include events whose local start date matches the requested date
      return e.startTimestamp && getStockholmDate(e.startTimestamp) === date;
    })
    .map(transformEvent)
    .sort((a, b) => (b.tournament?.rank?.id ?? 0) - (a.tournament?.rank?.id ?? 0));

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
  console.log(`Prefetching fixtures: ${DAYS_PAST} days past, today, ${DAYS_AHEAD} days ahead...`);
  for (let i = -DAYS_PAST; i <= DAYS_AHEAD; i++) {
    await fetchFixtures(getCetDate(i));
    if (i < DAYS_AHEAD) await sleep(500);
  }
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
