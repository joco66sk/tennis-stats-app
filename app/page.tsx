'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';

interface Fixture {
  id: number;
  date: string;
  player1?: { id: number; name: string; countryAcr?: string; ranking?: number };
  player2?: { id: number; name: string; countryAcr?: string; ranking?: number };
  tournament: {
    id?: number;
    name: string;
    rankId?: number;
    court?: { name: string };
    rank?: { id?: number; name?: string };
  };
  round?: { name: string };
}

interface PlayerSurfaceStat {
  wins: number;
  losses: number;
  form: boolean[];
}

export default function Home() {
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [playerStats, setPlayerStats] = useState<Record<string, PlayerSurfaceStat>>({});
  const [refreshing, setRefreshing] = useState(false);

  const normalizeSurface = (s?: string) => {
    if (!s) return s;
    if (s === 'I.hard' || s === 'Carpet') return 'Hard';
    return s;
  };

  const formatDate = (date: Date) => {
    const cetDate = new Date(date.getTime() + 2 * 60 * 60 * 1000);
    return cetDate.toISOString().split('T')[0];
  };

  const changeDate = (days: number) => {
    const newDate = new Date(selectedDate);
    newDate.setDate(newDate.getDate() + days);
    setSelectedDate(newDate);
  };

  const loadFixtures = (date: Date, force = false, retryCount = 0) => {
    setLoading(true);
    setError(false);
    setPlayerStats({});  // clear when changing date so stale stats don't show for wrong players
    const url = `/api/fixtures?date=${formatDate(date)}${force ? '&refresh=true' : ''}`;
    fetch(url)
      .then(r => {
        if (!r.ok) throw new Error('Failed to fetch');
        return r.json();
      })
      .then(data => {
        const filtered = (data.fixtures || []).filter((f: Fixture) =>
          !f.player1?.name?.includes('/') &&
          !f.player2?.name?.includes('/') &&
          (f.tournament?.rank?.id ?? 0) >= 2
        );
        if (filtered.length === 0 && retryCount < 2) {
          setTimeout(() => loadFixtures(date, force, retryCount + 1), 3000);
          return;
        }
        setFixtures(filtered);
        setLoading(false);
        setRefreshing(false);
      })
      .catch(err => {
        console.error(err);
        if (retryCount < 2) {
          setTimeout(() => loadFixtures(date, force, retryCount + 1), 3000);
          return;
        }
        setFixtures([]);
        setError(true);
        setLoading(false);
        setRefreshing(false);
      });
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadFixtures(selectedDate, true);
  };

  useEffect(() => {
    loadFixtures(selectedDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate]);

  useEffect(() => {
    if (fixtures.length === 0) return;

    const dateKey = `fixture-stats-${formatDate(selectedDate)}`;
    const cached = sessionStorage.getItem(dateKey);
    if (cached) {
      try { setPlayerStats(JSON.parse(cached)); } catch {}
    }

    const atpFixtures = fixtures.filter(f => (f.tournament?.rank?.id ?? 0) >= 2);

    const toFetch = new Map<string, { playerId: number; surface: string }>();
    atpFixtures.forEach(f => {
      const surface = normalizeSurface(f.tournament?.court?.name) || 'Hard';
      if (f.player1?.id) toFetch.set(`${f.player1.id}-${surface}`, { playerId: f.player1.id, surface });
      if (f.player2?.id) toFetch.set(`${f.player2.id}-${surface}`, { playerId: f.player2.id, surface });
    });

    const entries = Array.from(toFetch.values());
    let cancelled = false;
    const accumulated: Record<string, PlayerSurfaceStat> = cached ? JSON.parse(cached) : {};

    const pending = [...entries];
    const runWorker = async () => {
      while (true) {
        if (cancelled) break;
        const entry = pending.shift();
        if (!entry) break;
        const { playerId, surface } = entry;
        const key = `${playerId}-${surface}`;
        if (accumulated[key]) continue;
        try {
          const res = await fetch(`/api/player-surface-stats?playerId=${playerId}&surface=${surface}&limit=10&basic=true`);
          if (!res.ok || cancelled) continue;
          const data = await res.json();
          if (!cancelled && (data.wins ?? 0) + (data.losses ?? 0) > 0) {
            accumulated[key] = { wins: data.wins, losses: data.losses, form: data.form ?? [] };
            setPlayerStats(prev => ({ ...prev, [key]: accumulated[key] }));
            try { sessionStorage.setItem(dateKey, JSON.stringify(accumulated)); } catch {}
          }
        } catch {}
      }
    };

    const workerCount = Math.min(5, entries.length);
    Promise.allSettled(Array.from({ length: workerCount }, runWorker));

    return () => { cancelled = true; };
  }, [fixtures]);

  const matchUrl = (fixture: Fixture) => {
    const p1id = fixture.player1?.id || '';
    const p2id = fixture.player2?.id || '';
    const surface = normalizeSurface(fixture.tournament?.court?.name) || 'Clay';
    return `/compare?p1=${p1id}&p2=${p2id}&surface=${surface}`;
  };

  const getCategoryLabel = (rankId?: number) => {
    if (rankId === 4) return 'GS';
    if (rankId === 3) return '1000';
    if (rankId === 2) return 'ATP';
    return null;
  };

  const formatRound = (roundName?: string) => {
    if (!roundName) return null;
    const n = roundName.toLowerCase();
    if (n.includes('semi')) return 'SF';
    if (n.includes('quarter')) return 'QF';
    if (n.includes('final')) return 'F';
    if (n.includes('16')) return 'R16';
    if (n.includes('32')) return 'R32';
    if (n.includes('64')) return 'R64';
    if (n.includes('128')) return 'R128';
    if (n.includes('first') || n === 'r1') return 'R1';
    if (n.includes('second') || n === 'r2') return 'R2';
    if (n.includes('third') || n === 'r3') return 'R3';
    return roundName;
  };

  const formatTime = (dateStr: string) => {
    return new Date(dateStr).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Stockholm',
    });
  };

  const grouped = fixtures.reduce((acc, f) => {
    const key = f.tournament?.name || 'Unknown Tournament';
    if (!acc[key]) acc[key] = [];
    acc[key].push(f);
    return acc;
  }, {} as Record<string, Fixture[]>);

  Object.values(grouped).forEach(matches =>
    matches.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
  );

  const categoryPriority = (label: string | null) => {
    if (label === 'GS') return 4;
    if (label === '1000') return 3;
    if (label === '500') return 2;
    if (label === '250') return 1;
    return 0;
  };

  const isQualifying = (matches: Fixture[]) => matches.every(m => /^Q\d/i.test(m.round?.name ?? ''));
  const sortedGroups = Object.entries(grouped).sort(([, a], [, b]) => {
    const aQual = isQualifying(a) ? 1 : 0;
    const bQual = isQualifying(b) ? 1 : 0;
    if (aQual !== bQual) return aQual - bQual;
    const aPriority = categoryPriority(getCategoryLabel(a[0]?.tournament?.rank?.id));
    const bPriority = categoryPriority(getCategoryLabel(b[0]?.tournament?.rank?.id));
    return bPriority - aPriority;
  });

  const surfaceHex = (s?: string) => s === 'Clay' ? '#f97316' : s === 'Grass' ? '#34d399' : '#60a5fa';

  return (
    <div style={{ minHeight: '100vh', background: '#09090b', fontFamily: 'system-ui, -apple-system, sans-serif', color: '#fff' }}>
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '14px 14px 32px' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 900, letterSpacing: '0.18em', textTransform: 'uppercase', color: '#ccff00', marginBottom: 2 }}>Tennis Deep Stats</div>
            <div style={{ fontSize: 20, fontWeight: 900, color: '#f4f4f5', lineHeight: 1.1 }}>
              {selectedDate.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {formatDate(selectedDate) !== formatDate(new Date()) && (
              <button onClick={() => setSelectedDate(new Date())}
                style={{ padding: '6px 10px', fontSize: 11, fontWeight: 700, color: '#60a5fa', background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.2)', borderRadius: 8, cursor: 'pointer' }}>
                Today
              </button>
            )}
            <button onClick={handleRefresh} disabled={refreshing || loading}
              style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 10px', background: '#18181b', border: '1px solid #27272a', borderRadius: 8, color: '#71717a', fontSize: 12, fontWeight: 600, cursor: 'pointer', opacity: (refreshing || loading) ? 0.3 : 1 }}>
              <span style={{ fontSize: 14, lineHeight: 1 }}>↻</span>
              Refresh
            </button>
          </div>
        </div>

        {/* Date navigation */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
          <button onClick={() => changeDate(-1)}
            style={{ flex: 1, padding: '8px 0', background: '#18181b', border: '1px solid #27272a', borderRadius: 10, color: '#71717a', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
            ← Prev
          </button>
          <button onClick={() => changeDate(1)}
            style={{ flex: 1, padding: '8px 0', background: '#18181b', border: '1px solid #27272a', borderRadius: 10, color: '#71717a', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
            Next →
          </button>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '80px 0', color: '#52525b', fontSize: 14 }}>Loading matches…</div>
        ) : error ? (
          <div style={{ textAlign: 'center', padding: '80px 0', color: '#f87171', fontSize: 14 }}>Failed to load fixtures.</div>
        ) : fixtures.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '80px 0', color: '#52525b', fontSize: 14 }}>No matches scheduled.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            {sortedGroups.map(([tournamentName, matches]) => {
              const rawSurface = matches[0]?.tournament?.court?.name;
              const surface = normalizeSurface(rawSurface) || 'Hard';
              const sc = surfaceHex(surface);
              const categoryLabel = getCategoryLabel(matches[0]?.tournament?.rank?.id);
              const tournamentId = matches[0]?.tournament?.id;
              return (
                <div key={tournamentName}>
                  {/* Tournament label — minimal divider */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: sc, display: 'inline-block', flexShrink: 0 }} />
                    <span style={{ fontSize: 11, fontWeight: 900, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#a1a1aa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tournamentName}</span>
                    {categoryLabel && categoryLabel !== 'ATP' && (
                      <span style={{ fontSize: 9, fontWeight: 800, color: sc, border: `1px solid ${sc}50`, borderRadius: 3, padding: '1px 5px', flexShrink: 0 }}>{categoryLabel}</span>
                    )}
                    <div style={{ flex: 1, height: 1, background: '#1c1c1f' }} />
                    {tournamentId && (
                      <Link href={`/tournament/${tournamentId}`}
                        style={{ fontSize: 10, fontWeight: 700, color: sc, textDecoration: 'none', border: `1px solid ${sc}40`, borderRadius: 4, padding: '2px 6px', flexShrink: 0 }}>
                        Draw
                      </Link>
                    )}
                  </div>

                  {/* Match cards — vertical stacked */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {matches.map((fixture) => {
                      const matchSurface = normalizeSurface(fixture.tournament?.court?.name) || 'Hard';
                      const p1Stats = fixture.player1?.id ? playerStats[`${fixture.player1.id}-${matchSurface}`] : undefined;
                      const p2Stats = fixture.player2?.id ? playerStats[`${fixture.player2.id}-${matchSurface}`] : undefined;
                      const round = formatRound(fixture.round?.name);

                      const renderPlayer = (player: Fixture['player1'], stats: PlayerSurfaceStat | undefined) => {
                        const total = stats ? stats.wins + stats.losses : 0;
                        const pct = total > 0 ? Math.round(stats!.wins / total * 100) : 0;
                        const col = pct >= 50 ? '#34d399' : '#f87171';
                        return (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                            {/* Name + ranking */}
                            <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 5, overflow: 'hidden' }}>
                              {player?.ranking && <span style={{ fontSize: 10, fontWeight: 700, color: '#3f3f46', flexShrink: 0 }}>#{player.ranking}</span>}
                              <span style={{ fontSize: 16, fontWeight: 800, color: '#f4f4f5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {player?.name}
                              </span>
                            </div>
                            {/* Stats: form + bar + pct */}
                            {stats && total > 0 ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0 }}>
                                {(stats.form?.length ?? 0) > 0 && (
                                  <div style={{ display: 'flex', gap: 2 }}>
                                    {stats.form.map((w, j) => <span key={j} style={{ width: 5, height: 5, borderRadius: '50%', background: w ? '#34d399' : '#ef4444', display: 'inline-block' }} />)}
                                  </div>
                                )}
                                <div style={{ width: 44, height: 3, background: '#27272a', borderRadius: 2 }}>
                                  <div style={{ width: `${pct}%`, height: '100%', background: col, borderRadius: 2 }} />
                                </div>
                                <span style={{ fontSize: 13, fontWeight: 900, color: col, width: 32, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{pct}%</span>
                              </div>
                            ) : (
                              <span style={{ fontSize: 12, color: '#2d2d30', flexShrink: 0 }}>—</span>
                            )}
                          </div>
                        );
                      };

                      return (
                        <Link key={fixture.id} href={matchUrl(fixture)}
                          style={{ display: 'block', textDecoration: 'none', background: '#111113', border: '1px solid #1c1c1f', borderRadius: 12, padding: '10px 12px' }}
                          className="hover:border-zinc-700 active:bg-zinc-900 transition-colors">

                          {/* Time + round */}
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, marginBottom: 8 }}>
                            <span style={{ fontSize: 11, color: '#52525b', fontVariantNumeric: 'tabular-nums' }}>{formatTime(fixture.date)}</span>
                            {round && <span style={{ fontSize: 9, fontWeight: 800, color: sc, border: `1px solid ${sc}40`, borderRadius: 3, padding: '1px 5px', letterSpacing: '0.04em' }}>{round}</span>}
                          </div>

                          {/* P1 */}
                          {renderPlayer(fixture.player1, p1Stats)}

                          {/* Separator */}
                          <div style={{ height: 1, background: '#1c1c1f', margin: '8px 0' }} />

                          {/* P2 */}
                          {renderPlayer(fixture.player2, p2Stats)}

                        </Link>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <footer style={{ marginTop: 32, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <img src="https://s01.flagcounter.com/count/JxLo/bg_FFFFFF/txt_000000/border_CCCCCC/columns_8/maxflags_250/viewers_0/labels_1/pageviews_1/flags_0/percent_0/" alt="" style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }} />
          <a href="https://info.flagcounter.com/JxLo" target="_blank" rel="noopener noreferrer"
            style={{ padding: '6px 10px', background: '#18181b', border: '1px solid #27272a', borderRadius: 8, color: '#3f3f46', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', textDecoration: 'none' }}>
            Visitors
          </a>
          <a href="mailto:contact@tennisdeepstats.com"
            style={{ padding: '6px 10px', background: '#18181b', border: '1px solid #27272a', borderRadius: 8, color: '#3f3f46', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', textDecoration: 'none' }}>
            Contact
          </a>
        </footer>
      </div>
    </div>
  );
}
