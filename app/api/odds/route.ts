import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { CACHE_DIR, initCache } from '@/lib/shared';

const ODDS_API_KEY = process.env.ODDS_API_KEY!;
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const CACHE_FILE = path.join(CACHE_DIR, 'tennis-odds.json');
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours → ~120 calls/month max

// /sports is free and doesn't count toward quota
// We pick only the single most prestigious active tennis sport so we make exactly 1 paid call per refresh
function sportPriority(sport: any): number {
  const key: string = sport.key?.toLowerCase() || '';
  if (['french_open', 'roland', 'wimbledon', 'us_open', 'australian_open'].some(k => key.includes(k))) return 4;
  if (['madrid', 'rome', 'monte_carlo', 'canada', 'toronto', 'montreal', 'cincinnati', 'shanghai', 'paris', 'miami', 'indian_wells'].some(k => key.includes(k))) return 3;
  if (key.includes('500')) return 2;
  return 1;
}

const PREFERRED_BOOKS = ['pinnacle', 'bet365', 'betfair_ex_eu', 'unibet_eu', 'williamhill'];

function extractOdds(event: any): { home: number; away: number } | null {
  let outcomes = null;

  for (const bookKey of PREFERRED_BOOKS) {
    const book = event.bookmakers?.find((b: any) => b.key === bookKey);
    const market = book?.markets?.find((m: any) => m.key === 'h2h');
    if (market?.outcomes?.length >= 2) { outcomes = market.outcomes; break; }
  }

  if (!outcomes) {
    for (const book of (event.bookmakers || [])) {
      const market = book.markets?.find((m: any) => m.key === 'h2h');
      if (market?.outcomes?.length >= 2) { outcomes = market.outcomes; break; }
    }
  }

  if (!outcomes) return null;

  const homeOdds = outcomes.find((o: any) => o.name === event.home_team)?.price;
  const awayOdds = outcomes.find((o: any) => o.name === event.away_team)?.price;
  if (!homeOdds || !awayOdds) return null;
  return { home: homeOdds, away: awayOdds };
}

export async function GET() {
  initCache();
  if (isCacheValid()) {
    return NextResponse.json(JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')));
  }

  console.log('Fetching fresh tennis odds (1 API call)');

  try {
    // Free call — doesn't count toward quota
    const sportsRes = await fetch(`${ODDS_API_BASE}/sports?apiKey=${ODDS_API_KEY}`);
    if (!sportsRes.ok) throw new Error(`Sports list failed: ${sportsRes.status}`);
    const sports: any[] = await sportsRes.json();

    const tennisSports = sports
      .filter(s => s.group === 'Tennis' && s.active)
      .sort((a, b) => sportPriority(b) - sportPriority(a));

    if (tennisSports.length === 0) {
      const result = { odds: [], fetchedAt: new Date().toISOString() };
      writeCache(result);
      return NextResponse.json(result);
    }

    // Exactly 1 paid API call — top-priority active tennis tournament
    const sport = tennisSports[0];
    console.log(`Fetching odds for: ${sport.title} (${sport.key})`);
    const res = await fetch(
      `${ODDS_API_BASE}/sports/${sport.key}/odds?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal&dateFormat=iso`
    );

    const events: any[] = res.ok ? await res.json() : [];

    const odds = events
      .map((event: any) => {
        const matchOdds = extractOdds(event);
        if (!matchOdds) return null;
        return {
          homeTeam: event.home_team,
          awayTeam: event.away_team,
          homeOdds: matchOdds.home,
          awayOdds: matchOdds.away,
          commenceTime: event.commence_time,
        };
      })
      .filter(Boolean);

    const result = { odds, sport: sport.title, fetchedAt: new Date().toISOString() };
    writeCache(result);
    return NextResponse.json(result);
  } catch (err) {
    console.error('Odds fetch error:', err);
    if (fs.existsSync(CACHE_FILE)) {
      return NextResponse.json(JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')));
    }
    return NextResponse.json({ odds: [] });
  }
}

function isCacheValid(): boolean {
  if (!fs.existsSync(CACHE_FILE)) return false;
  return Date.now() - fs.statSync(CACHE_FILE).mtimeMs < CACHE_TTL;
}

function writeCache(data: any) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf-8');
}
