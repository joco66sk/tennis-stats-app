import fs from 'fs';
import path from 'path';
import Link from 'next/link';
import { redirect } from 'next/navigation';

export const revalidate = 3600;
export const dynamicParams = true;

const CACHE_DIR = path.join(process.cwd(), 'cache');
const MIN_STATS_DATE = '2024-01-01';

interface FixturePlayer {
  id: number;
  name: string;
  countryAcr?: string;
  ranking?: number;
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

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Stockholm',
  });
}

function fmtShortDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
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
  const ids = new Set<string>();
  for (const fp of getAllFixtureFiles()) {
    try {
      const { fixtures = [] } = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      for (const f of fixtures) {
        if (f.tournament?.id) ids.add(String(f.tournament.id));
      }
    } catch {}
  }
  return Array.from(ids).map(id => ({ id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  for (const fp of getAllFixtureFiles()) {
    try {
      const { fixtures = [] } = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      const f = fixtures.find((x: CachedFixture) => String(x.tournament?.id) === id);
      if (f) {
        const name = f.tournament.name;
        const surface = normalizeSurface(f.tournament?.court?.name);
        return {
          title: `${name} Draw & Stats | Tennis Deep Stats`,
          description: `${name} full draw on ${surface} — serve, return and win rate for every player.`,
          alternates: { canonical: `https://tennisdeepstats.com/tournament/${id}` },
          openGraph: {
            title: `${name} Draw & Stats`,
            description: `${name} full draw with ${surface.toLowerCase()} surface stats.`,
            url: `https://tennisdeepstats.com/tournament/${id}`,
            siteName: 'Tennis Deep Stats',
          },
        };
      }
    } catch {}
  }
  return { title: 'Tournament Draw | Tennis Deep Stats', description: 'ATP tournament draw with surface stats.' };
}

export default async function TournamentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) redirect('/');

  // Collect all matches for this tournament
  const seen = new Set<number>();
  const allFixtures: CachedFixture[] = [];
  for (const fp of getAllFixtureFiles()) {
    try {
      const { fixtures = [] } = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      for (const f of fixtures) {
        if (String(f.tournament?.id) === id && f.player1 && f.player2 && !seen.has(f.id)) {
          seen.add(f.id);
          allFixtures.push(f);
        }
      }
    } catch {}
  }

  if (allFixtures.length === 0) redirect('/');

  const surface = normalizeSurface(allFixtures[0].tournament?.court?.name);
  const tournamentName = allFixtures[0].tournament?.name || 'Tournament';
  const sc = surfaceColor(surface);
  const rankId = allFixtures[0].tournament?.rank?.id ?? 0;
  const tierLabel = rankId >= 4 ? 'Grand Slam' : rankId >= 3 ? 'Masters 1000' : rankId >= 2 ? 'ATP 250' : '';

  // Pre-compute stats for all unique players
  const statsCache = new Map<number, ReturnType<typeof getBasicStats>>();
  for (const f of allFixtures) {
    for (const p of [f.player1, f.player2]) {
      if (p?.id && !statsCache.has(p.id)) {
        statsCache.set(p.id, getBasicStats(p.id, surface));
      }
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

  // Date range
  const dates = [...new Set(allFixtures.map(f => f.date.slice(0, 10)))].sort();

  // Separate main draw and qualifying
  const mainRounds = sortedRounds.filter(([r]) => roundOrder(r) >= 0);
  const qualRounds = sortedRounds.filter(([r]) => roundOrder(r) < 0);

  const now = new Date();

  return (
    <div style={{ minHeight: '100vh', background: '#09090b', color: '#fff', padding: '16px', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: 640, margin: '0 auto' }}>

        {/* Nav */}
        <div style={{ marginBottom: 16 }}>
          <Link href="/" style={{ color: '#71717a', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>← Fixtures</Link>
          <div style={{ marginTop: 8, fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#71717a' }}>Tennis Deep Stats</div>
        </div>

        {/* Tournament header */}
        <div style={{ background: '#18181b', border: `1px solid #27272a`, borderRadius: 14, padding: '14px 16px', marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: sc, display: 'inline-block', flexShrink: 0 }} />
            <h1 style={{ fontSize: 20, fontWeight: 900, color: '#f4f4f5', margin: 0, lineHeight: 1 }}>{tournamentName}</h1>
            <span style={{ fontSize: 12, fontWeight: 700, color: sc, border: `1px solid ${sc}40`, borderRadius: 5, padding: '2px 8px', background: `${sc}12` }}>{surface}</span>
            {tierLabel && <span style={{ fontSize: 11, fontWeight: 700, color: '#71717a', border: '1px solid #27272a', borderRadius: 5, padding: '2px 7px' }}>{tierLabel}</span>}
          </div>
          <div style={{ fontSize: 12, color: '#52525b', marginTop: 8, paddingLeft: 20 }}>
            {fmtShortDate(dates[0])}{dates.length > 1 ? ` – ${fmtShortDate(dates[dates.length - 1])}` : ''} &nbsp;·&nbsp; {allFixtures.length} matches
          </div>
        </div>

        {/* Main draw */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {mainRounds.map(([roundName, roundFixtures]) => (
            <section key={roundName}>
              {/* Round header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <div style={{ flex: 1, height: 1, background: `${sc}30` }} />
                <span style={{ fontSize: 11, fontWeight: 900, letterSpacing: '0.12em', textTransform: 'uppercase', color: sc }}>
                  {formatRoundHeader(roundName)}
                </span>
                <div style={{ flex: 1, height: 1, background: `${sc}30` }} />
              </div>

              {/* Match cards */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {roundFixtures
                  .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
                  .map(f => {
                    const p1 = f.player1!;
                    const p2 = f.player2!;
                    const p1s = statsCache.get(p1.id);
                    const p2s = statsCache.get(p2.id);
                    const isPast = new Date(f.date) < now;
                    const cUrl = compareUrl(f, surface);

                    return (
                      <div key={f.id} style={{ position: 'relative', background: '#18181b', border: `1px solid ${isPast ? '#1f1f22' : '#27272a'}`, borderRadius: 12, padding: '11px 12px', opacity: isPast ? 0.65 : 1 }}>
                        {/* Full-card compare link sits behind content */}
                        <Link href={cUrl} target="_blank" rel="noopener noreferrer"
                          aria-label={`${p1.name} vs ${p2.name} — view stats`}
                          style={{ position: 'absolute', inset: 0, borderRadius: 12 }}
                          className="hover:bg-zinc-800/40 active:bg-zinc-800/60"
                        />
                        {/* Content sits above the card link */}
                        <div style={{ position: 'relative', zIndex: 1, display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: 6 }}>

                          {/* P1 — right aligned */}
                          <div style={{ textAlign: 'right', minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, marginBottom: p1s ? 4 : 0 }}>
                              {p1.ranking && <span style={{ fontSize: 11, color: '#52525b', flexShrink: 0 }}>#{p1.ranking}</span>}
                              <Link href={`/player/${p1.id}`}
                                style={{ fontSize: 15, fontWeight: 700, color: '#f4f4f5', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {p1.name}
                              </Link>
                            </div>
                            {p1s && (
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 5 }}>
                                <div style={{ display: 'flex', gap: 2 }}>
                                  {p1s.form.map((w, i) => <span key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: w ? '#34d399' : '#ef4444', display: 'inline-block' }} />)}
                                </div>
                                <span style={{ fontSize: 13, fontWeight: 800, color: p1s.wins > p1s.losses ? '#34d399' : '#f87171' }}>{p1s.pct}%</span>
                                <span style={{ fontSize: 10, color: '#3f3f46' }}>{p1s.wins}-{p1s.losses}</span>
                              </div>
                            )}
                          </div>

                          {/* Center */}
                          <div style={{ textAlign: 'center', padding: '0 8px', flexShrink: 0 }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: '#3f3f46', letterSpacing: '0.1em' }}>VS</div>
                            <div style={{ fontSize: 12, fontWeight: 600, color: '#a1a1aa', marginTop: 3, whiteSpace: 'nowrap' }}>{formatTime(f.date)}</div>
                          </div>

                          {/* P2 — left aligned */}
                          <div style={{ textAlign: 'left', minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 4, marginBottom: p2s ? 4 : 0 }}>
                              {p2.ranking && <span style={{ fontSize: 11, color: '#52525b', flexShrink: 0 }}>#{p2.ranking}</span>}
                              <Link href={`/player/${p2.id}`}
                                style={{ fontSize: 15, fontWeight: 700, color: '#f4f4f5', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {p2.name}
                              </Link>
                            </div>
                            {p2s && (
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 5 }}>
                                <span style={{ fontSize: 13, fontWeight: 800, color: p2s.wins > p2s.losses ? '#34d399' : '#f87171' }}>{p2s.pct}%</span>
                                <span style={{ fontSize: 10, color: '#3f3f46' }}>{p2s.wins}-{p2s.losses}</span>
                                <div style={{ display: 'flex', gap: 2 }}>
                                  {p2s.form.map((w, i) => <span key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: w ? '#34d399' : '#ef4444', display: 'inline-block' }} />)}
                                </div>
                              </div>
                            )}
                          </div>

                        </div>
                      </div>
                    );
                  })}
              </div>
            </section>
          ))}
        </div>

        {/* Qualifying — collapsed at bottom */}
        {qualRounds.length > 0 && (
          <details style={{ marginTop: 24 }}>
            <summary style={{ fontSize: 11, fontWeight: 700, color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.1em', cursor: 'pointer', padding: '4px 0' }}>
              Qualifying ({qualRounds.reduce((n, [, f]) => n + f.length, 0)} matches)
            </summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20, marginTop: 12 }}>
              {qualRounds.map(([roundName, roundFixtures]) => (
                <section key={roundName}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <div style={{ flex: 1, height: 1, background: '#27272a' }} />
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#52525b' }}>{roundName}</span>
                    <div style={{ flex: 1, height: 1, background: '#27272a' }} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {roundFixtures
                      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
                      .map(f => {
                        const p1 = f.player1!;
                        const p2 = f.player2!;
                        const isPast = new Date(f.date) < now;
                        return (
                          <Link key={f.id} href={compareUrl(f, surface)} target="_blank" rel="noopener noreferrer"
                            style={{ display: 'block', textDecoration: 'none', background: '#18181b', border: '1px solid #1f1f22', borderRadius: 10, padding: '8px 12px', opacity: isPast ? 0.5 : 0.8 }}
                            className="hover:bg-zinc-800/40">
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span style={{ fontSize: 13, color: '#a1a1aa', flex: 1 }}>{p1.name}</span>
                              <span style={{ fontSize: 11, color: '#3f3f46' }}>vs</span>
                              <span style={{ fontSize: 13, color: '#a1a1aa', flex: 1, textAlign: 'right' }}>{p2.name}</span>
                            </div>
                          </Link>
                        );
                      })}
                  </div>
                </section>
              ))}
            </div>
          </details>
        )}

        <div style={{ textAlign: 'center', fontSize: 11, color: '#3f3f46', marginTop: 20 }}>
          tennisdeepstats.com — serve &amp; return stats before every ATP match
        </div>
      </div>
    </div>
  );
}
