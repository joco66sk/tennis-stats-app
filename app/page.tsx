'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';

interface Fixture {
  id: number;
  date: string;
  player1?: { id: number; name: string; countryAcr?: string };
  player2?: { id: number; name: string; countryAcr?: string };
  tournament: {
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
            accumulated[key] = { wins: data.wins, losses: data.losses };
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
    const p1 = fixture.player1?.id || '';
    const p2 = fixture.player2?.id || '';
    const surface = normalizeSurface(fixture.tournament?.court?.name) || 'All';
    return `/compare?p1=${p1}&p2=${p2}&surface=${surface}`;
  };

  const getCategoryLabel = (rankName?: string) => {
    if (!rankName) return null;
    const n = rankName.toLowerCase();
    if (n.includes('grand slam')) return 'GS';
    if (n.includes('1000') || n.includes('masters')) return '1000';
    if (n.includes('500')) return '500';
    if (n.includes('250')) return '250';
    return null;
  };

  const getCategoryColor = (label?: string | null) => {
    if (label === 'GS') return 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/40';
    if (label === '1000') return 'bg-purple-500/20 text-purple-400 border border-purple-500/40';
    if (label === '500') return 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/40';
    return 'bg-zinc-700/50 text-zinc-400 border border-zinc-600';
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

  const getSurfaceColor = (surface?: string) => {
    if (surface === 'Clay') return 'bg-orange-500/20 text-orange-400 border border-orange-500/40';
    if (surface === 'Hard') return 'bg-blue-500/20 text-blue-400 border border-blue-500/40';
    if (surface === 'Grass') return 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40';
    return 'bg-zinc-700/50 text-zinc-400 border border-zinc-600';
  };

  const getSurfaceBorder = (surface?: string) => {
    if (surface === 'Clay') return 'border-l-orange-500';
    if (surface === 'Hard') return 'border-l-blue-500';
    if (surface === 'Grass') return 'border-l-emerald-500';
    return 'border-l-zinc-600';
  };

  const formatTime = (dateStr: string) => {
    return new Date(dateStr).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Paris',
    });
  };

  const grouped = fixtures.reduce((acc, f) => {
    const key = f.tournament?.name || 'Unknown Tournament';
    if (!acc[key]) acc[key] = [];
    acc[key].push(f);
    return acc;
  }, {} as Record<string, Fixture[]>);

  const isQualifying = (matches: Fixture[]) => matches.every(m => /^Q\d/i.test(m.round?.name ?? ''));
  const sortedGroups = Object.entries(grouped).sort(([, a], [, b]) => {
    const aQual = isQualifying(a) ? 1 : 0;
    const bQual = isQualifying(b) ? 1 : 0;
    if (aQual !== bQual) return aQual - bQual;
    // Among non-qualifying, higher rank first (GS > 1000 > 500 > 250)
    return (b[0]?.tournament?.rank?.id ?? 0) - (a[0]?.tournament?.rank?.id ?? 0);
  });

  return (
    <div className="min-h-screen bg-zinc-950 p-3 md:p-4">
      <div className="max-w-4xl mx-auto">
        <header className="mb-3">
          <h1 className="text-2xl font-black text-white tracking-tight uppercase">Tennis Deep Stats</h1>
          <p className="text-zinc-500 text-xs mt-0.5 uppercase tracking-wider">ATP Matches · Click to compare</p>
        </header>

        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-2.5 mb-3 flex items-center justify-between">
          <button onClick={() => changeDate(-1)} className="px-4 py-1.5 text-blue-400 hover:bg-zinc-800 rounded-lg transition text-sm font-semibold">← Prev</button>
          <div className="text-center">
            <div className="font-bold text-white text-sm">
              {selectedDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
            </div>
            {formatDate(selectedDate) !== formatDate(new Date()) && (
              <button onClick={() => setSelectedDate(new Date())} className="text-xs text-blue-400 hover:underline">Today</button>
            )}
          </div>
          <button onClick={() => changeDate(1)} className="px-4 py-1.5 text-blue-400 hover:bg-zinc-800 rounded-lg transition text-sm font-semibold">Next →</button>
        </div>
        <div className="flex justify-end mb-2">
          <button onClick={handleRefresh} disabled={refreshing || loading}
            className="text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-40 transition">
            {refreshing ? 'Refreshing...' : '↻ Refresh schedule'}
          </button>
        </div>

        {loading ? (
          <div className="text-center py-16 text-zinc-500">Loading matches...</div>
        ) : error ? (
          <div className="text-center py-16 text-red-400">Failed to load fixtures. API quota might be low.</div>
        ) : fixtures.length === 0 ? (
          <div className="text-center py-16 text-zinc-500">No matches found for this date.</div>
        ) : (
          <div className="space-y-2.5">
            {sortedGroups.map(([tournamentName, matches]) => {
              const isATP = (matches[0]?.tournament?.rank?.id ?? 0) >= 2;
              const surface = matches[0]?.tournament?.court?.name;
              const categoryLabel = getCategoryLabel(matches[0]?.tournament?.rank?.name);
              return (
                <div key={tournamentName} className={`bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden border-l-4 ${getSurfaceBorder(surface)}`}>
                  <div className="px-4 py-2 flex items-center justify-between border-b border-zinc-800">
                    <div className="flex items-center gap-2">
                      <span className="font-black text-white text-sm uppercase tracking-wide">{tournamentName}</span>
                      {categoryLabel && (
                        <span className={`px-2 py-0.5 text-xs font-bold rounded uppercase tracking-wide ${getCategoryColor(categoryLabel)}`}>
                          {categoryLabel}
                        </span>
                      )}
                    </div>
                    <span className={`px-2 py-0.5 text-xs font-bold rounded uppercase tracking-wide ${getSurfaceColor(surface)}`}>
                      {surface || 'Unknown'}
                    </span>
                  </div>

                  {matches.map((fixture, i) => {
                    const matchSurface = normalizeSurface(fixture.tournament?.court?.name) || 'Hard';
                    const p1Stats = fixture.player1?.id ? playerStats[`${fixture.player1.id}-${matchSurface}`] : undefined;
                    const p2Stats = fixture.player2?.id ? playerStats[`${fixture.player2.id}-${matchSurface}`] : undefined;
                    return (
                      <Link
                        key={fixture.id}
                        href={matchUrl(fixture)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`block px-4 py-3 hover:bg-zinc-800/60 active:bg-zinc-800 transition ${i > 0 ? 'border-t border-zinc-800' : ''}`}
                      >
                        <div className="grid grid-cols-[1fr_2.5rem_1fr_1.25rem] gap-2 items-start">
                          <div>
                            <div className="font-semibold text-white text-sm leading-tight">
                              {fixture.player1?.name}
                              {fixture.player1?.countryAcr && (
                                <span className="text-zinc-500 text-xs ml-1.5">{fixture.player1.countryAcr}</span>
                              )}
                            </div>
                            {isATP && (
                              <div className="mt-1">
                                {p1Stats
                                  ? <span className={`text-sm font-bold ${p1Stats.wins > p1Stats.losses ? 'text-emerald-400' : 'text-red-400'}`}>{p1Stats.wins}W-{p1Stats.losses}L</span>
                                  : <span className="text-xs text-zinc-600">—</span>
                                }
                              </div>
                            )}
                          </div>

                          <div className="text-center pt-0.5">
                            <div className="text-zinc-500 font-mono text-xs leading-tight">{formatTime(fixture.date)}</div>
                            {(() => { const r = formatRound(fixture.round?.name); return r && <div className="text-zinc-400 text-xs font-bold mt-0.5">{r}</div>; })()}
                            <div className="text-zinc-600 text-xs font-black mt-0.5">VS</div>
                          </div>

                          <div className="text-right">
                            <div className="font-semibold text-white text-sm leading-tight">
                              {fixture.player2?.countryAcr && (
                                <span className="text-zinc-500 text-xs mr-1.5">{fixture.player2.countryAcr}</span>
                              )}
                              {fixture.player2?.name}
                            </div>
                            {isATP && (
                              <div className="mt-1">
                                {p2Stats
                                  ? <span className={`text-sm font-bold ${p2Stats.wins > p2Stats.losses ? 'text-emerald-400' : 'text-red-400'}`}>{p2Stats.wins}W-{p2Stats.losses}L</span>
                                  : <span className="text-xs text-zinc-600">—</span>
                                }
                              </div>
                            )}
                          </div>

                          <div className="flex items-start justify-end pt-0.5">
                            <span className="text-blue-500 font-bold text-base leading-tight">→</span>
                          </div>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
