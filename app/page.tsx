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

  const slugifyName = (name: string) =>
    (name.split(/[\s-]/).pop() || name)
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]/g, '');

  const matchUrl = (fixture: Fixture) => {
    const p1id = fixture.player1?.id || '';
    const p2id = fixture.player2?.id || '';
    const surface = normalizeSurface(fixture.tournament?.court?.name) || 'Clay';
    const p1slug = slugifyName(fixture.player1?.name || String(p1id));
    const p2slug = slugifyName(fixture.player2?.name || String(p2id));
    const d = new Date(fixture.date);
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const yy = String(d.getUTCFullYear()).slice(-2);
    return `/compare/${p1slug}-${p2slug}-${dd}${mm}${yy}-${surface}-${p1id}-${p2id}`;
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

  const getSurfaceAccent = (surface?: string) => {
    if (surface === 'Clay') return { bg: 'rgba(249,115,22,0.08)', border: '#f97316', dot: '#f97316' };
    if (surface === 'Grass') return { bg: 'rgba(52,211,153,0.08)', border: '#34d399', dot: '#34d399' };
    return { bg: 'rgba(96,165,250,0.08)', border: '#60a5fa', dot: '#60a5fa' };
  };

  return (
    <div className="min-h-screen bg-zinc-950" style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <div className="max-w-2xl mx-auto px-3 py-4">

        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-xs font-bold tracking-[0.2em] text-zinc-500 uppercase mb-0.5">Tennis Deep Stats</div>
            <div className="text-xl font-black text-white tracking-tight">
              {selectedDate.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {formatDate(selectedDate) !== formatDate(new Date()) && (
              <button onClick={() => setSelectedDate(new Date())}
                className="px-3 py-1.5 text-xs font-bold text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded-lg hover:bg-blue-500/20 transition">
                Today
              </button>
            )}
            <button onClick={handleRefresh} disabled={refreshing || loading}
              className="text-zinc-600 hover:text-zinc-400 disabled:opacity-30 transition text-base leading-none">
              ↻
            </button>
          </div>
        </div>

        {/* Date navigation */}
        <div className="flex items-center gap-2 mb-4">
          <button onClick={() => changeDate(-1)}
            className="flex-1 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-zinc-400 hover:text-white hover:border-zinc-700 transition text-sm font-semibold">
            ← Prev
          </button>
          <button onClick={() => changeDate(1)}
            className="flex-1 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-zinc-400 hover:text-white hover:border-zinc-700 transition text-sm font-semibold">
            Next →
          </button>
        </div>

        {loading ? (
          <div className="text-center py-20 text-zinc-600 text-sm">Loading matches…</div>
        ) : error ? (
          <div className="text-center py-20 text-red-400 text-sm">Failed to load fixtures.</div>
        ) : fixtures.length === 0 ? (
          <div className="text-center py-20 text-zinc-600 text-sm">No matches scheduled.</div>
        ) : (
          <div className="space-y-3">
            {sortedGroups.map(([tournamentName, matches]) => {
              const isATP = (matches[0]?.tournament?.rank?.id ?? 0) >= 2;
              const surface = matches[0]?.tournament?.court?.name;
              const categoryLabel = getCategoryLabel(matches[0]?.tournament?.rank?.id);
              const accent = getSurfaceAccent(surface);
              return (
                <div key={tournamentName}
                  style={{ background: '#18181b', border: '1px solid #27272a', borderRadius: 16, overflow: 'hidden' }}>

                  {/* Tournament header */}
                  <div style={{ background: accent.bg, borderBottom: '1px solid #27272a', padding: '11px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 9, height: 9, borderRadius: '50%', background: accent.dot, display: 'inline-block', flexShrink: 0 }} />
                      <span style={{ fontWeight: 800, color: '#fff', fontSize: 16, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{tournamentName}</span>
                      {categoryLabel && categoryLabel !== 'ATP' && (
                        <span style={{ fontSize: 11, fontWeight: 700, color: accent.dot, background: 'transparent', border: `1px solid ${accent.dot}`, borderRadius: 4, padding: '1px 6px', opacity: 0.9 }}>{categoryLabel}</span>
                      )}
                    </div>
                    <span style={{ fontSize: 13, fontWeight: 700, color: accent.dot, opacity: 0.85 }}>{surface}</span>
                  </div>

                  {/* Match rows — pill badge style */}
                  {matches.map((fixture, i) => {
                    const matchSurface = normalizeSurface(fixture.tournament?.court?.name) || 'Hard';
                    const p1Stats = fixture.player1?.id ? playerStats[`${fixture.player1.id}-${matchSurface}`] : undefined;
                    const p2Stats = fixture.player2?.id ? playerStats[`${fixture.player2.id}-${matchSurface}`] : undefined;
                    const round = formatRound(fixture.round?.name);
                    const badge = (stats: typeof p1Stats) => {
                      if (!isATP || !stats) return null;
                      const win = stats.wins > stats.losses;
                      return (
                        <span style={{
                          fontSize: 12, fontWeight: 800,
                          color: win ? '#34d399' : '#f87171',
                          background: win ? 'rgba(52,211,153,0.1)' : 'rgba(248,113,113,0.1)',
                          border: `1px solid ${win ? 'rgba(52,211,153,0.25)' : 'rgba(248,113,113,0.25)'}`,
                          borderRadius: 6, padding: '2px 7px', flexShrink: 0,
                        }}>{stats.wins}–{stats.losses}</span>
                      );
                    };
                    return (
                      <Link
                        key={fixture.id}
                        href={matchUrl(fixture)}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ display: 'block', padding: '11px 14px', borderTop: i > 0 ? '1px solid #27272a' : 'none', textDecoration: 'none' }}
                        className="hover:bg-zinc-800/50 active:bg-zinc-800"
                      >
                        {/* Player 1 */}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <div style={{ fontSize: 16, fontWeight: 700, color: '#f4f4f5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                            {fixture.player1?.name}
                            {fixture.player1?.countryAcr && <span style={{ fontSize: 11, color: '#52525b', marginLeft: 6 }}>{fixture.player1.countryAcr}</span>}
                          </div>
                          {badge(p1Stats)}
                        </div>

                        {/* Divider */}
                        <div style={{ borderTop: '1px solid #27272a', margin: '8px 0' }} />

                        {/* Player 2 */}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <div style={{ fontSize: 16, fontWeight: 700, color: '#f4f4f5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                            {fixture.player2?.name}
                            {fixture.player2?.countryAcr && <span style={{ fontSize: 11, color: '#52525b', marginLeft: 6 }}>{fixture.player2.countryAcr}</span>}
                          </div>
                          {badge(p2Stats)}
                        </div>

                        {/* Footer: time + round */}
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 7 }}>
                          <span style={{ fontSize: 11, color: '#52525b', fontVariantNumeric: 'tabular-nums' }}>{formatTime(fixture.date)}</span>
                          {round && <><span style={{ fontSize: 11, color: '#3f3f46' }}>·</span><span style={{ fontSize: 11, color: '#52525b' }}>{round}</span></>}
                        </div>
                      </Link>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}

        <footer className="mt-8 flex items-center justify-between">
          <img src="https://s01.flagcounter.com/count/JxLo/bg_FFFFFF/txt_000000/border_CCCCCC/columns_8/maxflags_250/viewers_0/labels_1/pageviews_1/flags_0/percent_0/" alt="" className="absolute w-px h-px opacity-0 pointer-events-none" />
          <a href="https://info.flagcounter.com/JxLo" target="_blank" rel="noopener noreferrer"
            className="px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-600 hover:text-zinc-400 transition text-xs font-bold tracking-widest uppercase">
            Visitor Counter
          </a>
          <a href="mailto:contact@tennisdeepstats.com"
            className="px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-600 hover:text-zinc-400 transition text-xs font-bold tracking-widest uppercase">
            Contact
          </a>
        </footer>
      </div>
    </div>
  );
}
