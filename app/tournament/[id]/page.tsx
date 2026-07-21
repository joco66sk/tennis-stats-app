import fs from 'fs';
import path from 'path';
import { redirect } from 'next/navigation';
import TournamentDrawClient from './TournamentDrawClient';

export const revalidate = 3600;
export const dynamicParams = true;

const CACHE_DIR = path.join(process.cwd(), 'cache');
const MIN_STATS_DATE = '2024-01-01';

interface FixturePlayer {
  id: number;
  name: string;
  countryAcr?: string;
  ranking?: number;
  seed?: string;
}

interface CachedFixture {
  id: number;
  date: string;
  player1?: FixturePlayer;
  player2?: FixturePlayer;
  tournament: { id?: number; name: string; court?: { name: string }; rank?: { id?: number } };
  round?: { name: string };
}

function normalizeSurface(s?: string): string {
  if (!s) return 'Hard';
  if (s === 'I.hard' || s === 'Carpet') return 'Hard';
  return s;
}

function surfaceColor(s: string): string {
  if (s === 'Clay') return '#f97316';
  if (s === 'Grass') return '#34d399';
  return '#60a5fa';
}

function roundOrder(name?: string): number {
  if (!name) return 99;
  const n = name.toLowerCase();
  if (n.includes('qualif')) return -1;
  if (n.includes('128')) return 1;
  if (n.includes('64')) return 2;
  if (n.includes('32')) return 3;
  if (n.includes('16')) return 4;
  if (n.includes('quarter')) return 5;
  if (n.includes('semi')) return 6;
  if (n.includes('final')) return 7;
  return 99;
}

function formatRoundHeader(name?: string): string {
  if (!name) return '';
  const n = name.toLowerCase();
  if (n.includes('qualif')) return name;
  if (n.includes('128')) return 'Round of 128';
  if (n.includes('64')) return 'Round of 64';
  if (n.includes('32')) return 'Round of 32';
  if (n.includes('16')) return 'Round of 16';
  if (n.includes('quarter')) return 'Quarterfinals';
  if (n.includes('semi')) return 'Semifinals';
  if (n.includes('final')) return 'Final';
  return name;
}

function fmtShortDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function tournamentNameSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function toTournamentSlug(id: string | number, name: string, year: string | number): string {
  return `${id}-${tournamentNameSlug(name)}-${year}`;
}

function loadArchive(): Record<string, { id: number; name: string; surface: string; tier: number; year: string; startDate: string; endDate: string }> {
  const fp = path.join(CACHE_DIR, 'tournament-archive.json');
  if (!fs.existsSync(fp)) return {};
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')).tournaments || {}; }
  catch { return {}; }
}

function getMatchResult(eventId: number, p1Id: number): { score: string; p1Won: boolean } | null {
  const fp = path.join(CACHE_DIR, `player-index-${p1Id}.json`);
  if (!fs.existsSync(fp)) return null;
  try {
    const index = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    for (const s of ['Clay', 'Hard', 'Grass']) {
      const entry = (index[s] ?? []).find((e: any) => e.tournamentId === eventId);
      if (entry) return { score: entry.result || '', p1Won: entry.won };
    }
    return null;
  } catch { return null; }
}

function getBasicStats(playerId: string | number, surface: string) {
  const fp = path.join(CACHE_DIR, `player-index-${playerId}.json`);
  if (!fs.existsSync(fp)) return null;
  try {
    const index = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    const entries: any[] = (index[surface] ?? [])
      .filter((e: any) => e.date >= MIN_STATS_DATE)
      .slice(0, 10);
    if (entries.length === 0) return null;
    const wins = entries.filter(e => e.won).length;
    const losses = entries.length - wins;
    const total = wins + losses;
    return {
      wins, losses,
      form: entries.slice(0, 5).map(e => e.won as boolean),
      pct: total > 0 ? Math.round(wins / total * 100) : 0,
    };
  } catch { return null; }
}

function playerNameSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function playerUrl(id: number, name: string): string {
  return `/player/${id}-${playerNameSlug(name)}`;
}

function slugifyName(name: string): string {
  return (name.split(/[\s-]/).pop() || name)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function compareUrl(f: CachedFixture, surface: string): string {
  const p1id = f.player1?.id || '';
  const p2id = f.player2?.id || '';
  const p1slug = slugifyName(f.player1?.name || String(p1id));
  const p2slug = slugifyName(f.player2?.name || String(p2id));
  const d = new Date(f.date);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yy = String(d.getUTCFullYear()).slice(-2);
  return `/compare/${p1slug}-${p2slug}-${dd}${mm}${yy}-${surface}-${p1id}-${p2id}`;
}

function getAllFixtureFiles(): string[] {
  const dates: string[] = [];
  for (let i = -14; i <= 14; i++) {
    const d = new Date(Date.now() + 2 * 60 * 60 * 1000 + i * 86400000);
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates
    .map(date => path.join(CACHE_DIR, `fixtures-${date}.json`))
    .filter(fs.existsSync);
}

export async function generateStaticParams() {
  const slugs = new Set<string>();

  // Current fixture window
  for (const fp of getAllFixtureFiles()) {
    try {
      const { fixtures = [] } = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      for (const f of fixtures) {
        const t = f.tournament;
        if (!t?.id || !t.name) continue;
        const year = (f.date || '').slice(0, 4) || new Date().getFullYear().toString();
        slugs.add(toTournamentSlug(t.id, t.name, year));
      }
    } catch {}
  }

  // All archived tournaments
  const archive = loadArchive();
  for (const entry of Object.values(archive)) {
    slugs.add(toTournamentSlug(entry.id, entry.name, entry.year));
  }

  return Array.from(slugs).map(id => ({ id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numericId = id.split('-')[0];

  // Try fixture files first, then archive
  for (const fp of getAllFixtureFiles()) {
    try {
      const { fixtures = [] } = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      const f = fixtures.find((x: CachedFixture) => String(x.tournament?.id) === numericId);
      if (f) {
        const name = f.tournament.name;
        const surface = normalizeSurface(f.tournament?.court?.name);
        const year = (f.date || '').slice(0, 4);
        const slug = toTournamentSlug(numericId, name, year);
        return {
          title: `${name} ${year} Draw & Stats | Tennis Deep Stats`,
          description: `${name} ${year} full draw on ${surface} — serve, return and win rate for every player.`,
          alternates: { canonical: `https://tennisdeepstats.com/tournament/${slug}` },
          openGraph: {
            title: `${name} ${year} Draw & Stats`,
            description: `${name} ${year} full draw with ${surface.toLowerCase()} surface stats.`,
            url: `https://tennisdeepstats.com/tournament/${slug}`,
            siteName: 'Tennis Deep Stats',
          },
        };
      }
    } catch {}
  }

  const archive = loadArchive();
  const entry = archive[numericId];
  if (entry) {
    const slug = toTournamentSlug(entry.id, entry.name, entry.year);
    return {
      title: `${entry.name} ${entry.year} Draw & Stats | Tennis Deep Stats`,
      description: `${entry.name} ${entry.year} full draw on ${entry.surface} — serve, return and win rate for every player.`,
      alternates: { canonical: `https://tennisdeepstats.com/tournament/${slug}` },
    };
  }

  return { title: 'Tournament Draw | Tennis Deep Stats', description: 'ATP tournament draw with surface stats.' };
}

export default async function TournamentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const numericId = id.split('-')[0];
  if (!/^\d+$/.test(numericId)) redirect('/');

  const seen = new Set<number>();
  const allFixtures: CachedFixture[] = [];
  for (const fp of getAllFixtureFiles()) {
    try {
      const { fixtures = [] } = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      for (const f of fixtures) {
        if (String(f.tournament?.id) === numericId && f.player1 && f.player2 && !seen.has(f.id)) {
          seen.add(f.id);
          allFixtures.push(f);
        }
      }
    } catch {}
  }

  if (allFixtures.length === 0) redirect('/');

  const surface = normalizeSurface(allFixtures[0].tournament?.court?.name);
  const tournamentName = allFixtures[0].tournament?.name || 'Tournament';
  const year = (allFixtures[0].date || '').slice(0, 4);
  const sc = surfaceColor(surface);
  const rankId = allFixtures[0].tournament?.rank?.id ?? 0;
  const tierLabel = rankId >= 4 ? 'Grand Slam' : rankId >= 3 ? 'Masters 1000' : rankId >= 2 ? 'ATP 250' : '';

  // Redirect old numeric-only URLs to slug
  if (/^\d+$/.test(id)) redirect(`/tournament/${toTournamentSlug(numericId, tournamentName, year)}`);

  // Pre-compute stats for all unique players
  const statsCacheRaw = new Map<number, ReturnType<typeof getBasicStats>>();
  for (const f of allFixtures) {
    for (const p of [f.player1, f.player2]) {
      if (p?.id && !statsCacheRaw.has(p.id)) {
        statsCacheRaw.set(p.id, getBasicStats(p.id, surface));
      }
    }
  }

  const now = new Date();

  // Pre-compute match results for past fixtures
  const resultsCacheRaw = new Map<number, { score: string; p1Won: boolean } | null>();
  for (const f of allFixtures) {
    if (new Date(f.date) < now && f.player1?.id) {
      resultsCacheRaw.set(f.id, getMatchResult(f.id, f.player1.id));
    }
  }

  // Group by round
  const byRound = new Map<string, CachedFixture[]>();
  for (const f of allFixtures) {
    const rname = f.round?.name || 'Unknown';
    if (!byRound.has(rname)) byRound.set(rname, []);
    byRound.get(rname)!.push(f);
  }
  const sortedRounds = [...byRound.entries()]
    .sort(([a], [b]) => roundOrder(a) - roundOrder(b));

  const dates = [...new Set(allFixtures.map(f => f.date.slice(0, 10)))].sort();
  const dateRange = `${fmtShortDate(dates[0])}${dates.length > 1 ? ` – ${fmtShortDate(dates[dates.length - 1])}` : ''}`;

  const mainRoundsRaw = sortedRounds.filter(([r]) => roundOrder(r) >= 0);
  const qualRoundsRaw = sortedRounds.filter(([r]) => roundOrder(r) < 0);

  const parseSeed = (s?: string) => { const n = parseInt(s ?? ''); return isNaN(n) ? Infinity : n; };
  const bracketKey = (f: CachedFixture) => {
    const s1 = parseSeed(f.player1?.seed);
    const s2 = parseSeed(f.player2?.seed);
    const best = Math.min(s1, s2);
    if (best === 1) return -1;
    if (best === 2) return 1e9;
    if (best < Infinity) return best;
    return 500 + Math.min(f.player1?.ranking ?? 999, f.player2?.ranking ?? 999);
  };

  const toDrawFixture = (f: CachedFixture) => ({
    id: f.id,
    date: f.date,
    player1: f.player1!,
    player2: f.player2!,
    round: f.round?.name || '',
    compareUrl: compareUrl(f, surface),
    player1Url: playerUrl(f.player1!.id, f.player1!.name),
    player2Url: playerUrl(f.player2!.id, f.player2!.name),
  });

  const mainRounds = mainRoundsRaw.map(([roundName, fixtures]) => ({
    roundName: formatRoundHeader(roundName),
    fixtures: [...fixtures].sort((a, b) => bracketKey(a) - bracketKey(b)).map(toDrawFixture),
  }));

  const qualRounds = qualRoundsRaw.map(([roundName, fixtures]) => ({
    roundName,
    fixtures: fixtures.map(toDrawFixture),
  }));

  const statsCache: Record<number, ReturnType<typeof getBasicStats>> = {};
  statsCacheRaw.forEach((v, k) => { statsCache[k] = v; });

  const resultsCache: Record<number, { score: string; p1Won: boolean } | null> = {};
  resultsCacheRaw.forEach((v, k) => { resultsCache[k] = v; });

  return (
    <TournamentDrawClient
      tournamentName={tournamentName}
      year={year}
      surface={surface}
      sc={sc}
      tierLabel={tierLabel}
      dateRange={dateRange}
      totalMatches={allFixtures.length}
      mainRounds={mainRounds}
      qualRounds={qualRounds}
      statsCache={statsCache}
      resultsCache={resultsCache}
    />
  );
}
