'use client';
import { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

interface MatchSummary {
  id: string;
  date: string;
  result: string;
  won: boolean;
  opponentName: string;
  tournamentId: number;
  opponentId: number;
}

interface PlayerStats {
  playerName: string;
  wins: number;
  losses: number;
  matchesWithStats: number;
  avgAces: number;
  avgDf: number;
  avg1stServe: number;
  avg1stWon: number;
  avg2ndWon: number;
  avgBpSaved: number;
  avgServeWon: number;
  avgReturnWon: number;
  avgReturn1stWon: number;
  avgReturn2ndWon: number;
  form: boolean[];
  matches: MatchSummary[];
}

interface SingleMatchStats {
  firstServePct: number;
  firstServeWonPct: number;
  secondServeWonPct: number;
  aces: number;
  dfs: number;
  servePtsWonPct: number;
  returnPtsWonPct: number;
  return1stSrvWonPct: number;
  return2ndSrvWonPct: number;
}

interface SelectedMatch {
  matchId: string;
  tournamentId: number;
  playerId: number;
  opponentId: number;
  playerName: string;
  opponentName: string;
  result: string;
  date: string;
  side: 'left' | 'right';
}

function computeMatchStats(my: any, opp: any): SingleMatchStats {
  const svpt = my.firstServeOf || 0;
  const first1stIn = my.firstServe || 0;
  const secondPts = svpt - first1stIn;
  const oppSvpt = opp.firstServeOf || 0;
  const opp1stIn = opp.firstServe || 0;
  const opp2ndPts = oppSvpt - opp1stIn;
  return {
    firstServePct: svpt > 0 ? (first1stIn / svpt) * 100 : 0,
    firstServeWonPct: first1stIn > 0 ? ((my.winningOnFirstServe || 0) / first1stIn) * 100 : 0,
    secondServeWonPct: secondPts > 0 ? ((my.winningOnSecondServe || 0) / secondPts) * 100 : 0,
    aces: my.aces || 0,
    dfs: my.doubleFaults || 0,
    servePtsWonPct: svpt > 0 ? (((my.winningOnFirstServe || 0) + (my.winningOnSecondServe || 0)) / svpt) * 100 : 0,
    returnPtsWonPct: oppSvpt > 0 ? (oppSvpt - (opp.winningOnFirstServe || 0) - (opp.winningOnSecondServe || 0)) / oppSvpt * 100 : 0,
    return1stSrvWonPct: opp1stIn > 0 ? (opp1stIn - (opp.winningOnFirstServe || 0)) / opp1stIn * 100 : 0,
    return2ndSrvWonPct: opp2ndPts > 0 ? (opp2ndPts - (opp.winningOnSecondServe || 0)) / opp2ndPts * 100 : 0,
  };
}

function StatRow({ label, v1, v2, higherIsBetter = true, isPercent = true }: {
  label: string; v1: number; v2: number;
  higherIsBetter?: boolean; isPercent?: boolean;
}) {
  const n1 = v1 ?? 0;
  const n2 = v2 ?? 0;
  const p1Better = higherIsBetter ? n1 > n2 : n1 < n2;
  const p2Better = higherIsBetter ? n2 > n1 : n2 < n1;
  return (
    <div className="grid grid-cols-[1fr_9rem_1fr] items-center py-1.5 border-t border-zinc-800">
      <div className={`text-right pr-3 font-mono text-sm font-bold ${p1Better ? 'text-emerald-400' : 'text-zinc-500'}`}>
        {n1.toFixed(1)}{isPercent ? '%' : ''}
      </div>
      <div className="text-center text-xs text-zinc-500">{label}</div>
      <div className={`text-left pl-3 font-mono text-sm font-bold ${p2Better ? 'text-emerald-400' : 'text-zinc-500'}`}>
        {n2.toFixed(1)}{isPercent ? '%' : ''}
      </div>
    </div>
  );
}

function formatMatchDate(dateStr: string) {
  const d = new Date(dateStr);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short',
    ...(sameYear ? {} : { year: '2-digit' }),
  });
}

function FormDots({ form, align = 'left' }: { form: boolean[]; align?: 'left' | 'right' }) {
  return (
    <div className={`flex gap-1 ${align === 'right' ? 'justify-end' : ''}`}>
      {form.map((w, i) => (
        <span key={i} className={`w-2.5 h-2.5 rounded-full inline-block ${w ? 'bg-emerald-400' : 'bg-red-500'}`} />
      ))}
    </div>
  );
}

function CompareContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const player1Id = searchParams.get('p1') || '';
  const player2Id = searchParams.get('p2') || '';
  const surface = searchParams.get('surface') || 'Clay';
  const [lastN, setLastN] = useState(10);
  const [stats1, setStats1] = useState<PlayerStats | null>(null);
  const [stats2, setStats2] = useState<PlayerStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [selectedMatch, setSelectedMatch] = useState<SelectedMatch | null>(null);
  const [matchDetail, setMatchDetail] = useState<{ left: SingleMatchStats; right: SingleMatchStats } | null>(null);
  const [matchDetailLoading, setMatchDetailLoading] = useState(false);

  useEffect(() => {
    if (stats1 && stats2) {
      document.title = `${stats1.playerName} vs ${stats2.playerName} | Tennis Deep Stats`;
    }
  }, [stats1, stats2]);

  useEffect(() => {
    if (!player1Id || !player2Id || player1Id === 'undefined' || player2Id === 'undefined') return;

    const cacheKey = `cmp-v23-${player1Id}-${player2Id}-${surface}-${lastN}`;
    const SESSION_TTL = 2 * 60 * 60 * 1000;
    try {
      const cached = sessionStorage.getItem(cacheKey);
      if (cached) {
        const { stats1: s1, stats2: s2, cachedAt } = JSON.parse(cached);
        if (Date.now() - (cachedAt ?? 0) < SESSION_TTL) {
          setStats1(s1);
          setStats2(s2);
          return;
        }
        sessionStorage.removeItem(cacheKey);
      }
    } catch {}

    const controller = new AbortController();
    setLoading(true);
    setError('');
    setStats1(null);
    setStats2(null);
    setSelectedMatch(null);
    setMatchDetail(null);

    Promise.all([
      fetch(`/api/player-surface-stats?playerId=${player1Id}&surface=${surface}&limit=${lastN}`, { signal: controller.signal }).then(r => { if (!r.ok) throw new Error('Failed to load P1'); return r.json(); }),
      fetch(`/api/player-surface-stats?playerId=${player2Id}&surface=${surface}&limit=${lastN}`, { signal: controller.signal }).then(r => { if (!r.ok) throw new Error('Failed to load P2'); return r.json(); }),
    ])
      .then(([d1, d2]) => {
        setStats1(d1);
        setStats2(d2);
        const hasData = (d1.wins + d1.losses) > 0 && (d2.wins + d2.losses) > 0;
        if (hasData) {
          try { sessionStorage.setItem(cacheKey, JSON.stringify({ stats1: d1, stats2: d2, cachedAt: Date.now() })); } catch {}
        }
      })
      .catch(e => { if (e.name !== 'AbortError') setError(e instanceof Error ? e.message : 'Failed to load stats'); })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [player1Id, player2Id, surface, lastN]);

  useEffect(() => {
    if (!selectedMatch) { setMatchDetail(null); return; }
    setMatchDetailLoading(true);
    setMatchDetail(null);
    fetch(`/api/match-stats?tournamentId=${selectedMatch.tournamentId}&p1=${selectedMatch.playerId}&p2=${selectedMatch.opponentId}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return;
        const isP1 = data.player1Stats?.player1Id === selectedMatch.playerId;
        const my = isP1 ? data.player1Stats : data.player2Stats;
        const opp = isP1 ? data.player2Stats : data.player1Stats;
        if (!my || !opp) return;
        const myStats = computeMatchStats(my, opp);
        const oppStats = computeMatchStats(opp, my);
        setMatchDetail(selectedMatch.side === 'left'
          ? { left: myStats, right: oppStats }
          : { left: oppStats, right: myStats }
        );
      })
      .catch(() => {})
      .finally(() => setMatchDetailLoading(false));
  }, [selectedMatch]);

  const surfaceColor = () => {
    if (surface === 'Clay') return 'text-orange-400';
    if (surface === 'Hard') return 'text-blue-400';
    if (surface === 'Grass') return 'text-emerald-400';
    return 'text-zinc-400';
  };

  const handleShare = async () => {
    const url = window.location.href;
    const title = stats1 && stats2 ? `${stats1.playerName} vs ${stats2.playerName} on ${surface} | Tennis Deep Stats` : 'Tennis Deep Stats';
    if (navigator.share) {
      try { await navigator.share({ title, url }); } catch {}
    } else {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleMatchClick = (m: MatchSummary, side: 'left' | 'right', playerId: string, playerName: string) => {
    if (selectedMatch?.matchId === m.id && selectedMatch?.side === side) {
      setSelectedMatch(null);
    } else {
      setSelectedMatch({
        matchId: m.id,
        tournamentId: m.tournamentId,
        playerId: parseInt(playerId),
        opponentId: m.opponentId,
        playerName,
        opponentName: m.opponentName,
        result: m.result,
        date: m.date,
        side,
      });
    }
  };

  const centerLeft = selectedMatch?.side === 'left'
    ? selectedMatch.playerName
    : selectedMatch?.side === 'right'
    ? selectedMatch.opponentName
    : stats1?.playerName ?? '';

  const centerRight = selectedMatch?.side === 'right'
    ? selectedMatch.playerName
    : selectedMatch?.side === 'left'
    ? selectedMatch.opponentName
    : stats2?.playerName ?? '';

  return (
    <div className="min-h-screen bg-zinc-950 p-3 md:p-4">
      <div className="max-w-5xl mx-auto">
        <header className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => router.push('/')} className="text-zinc-400 hover:text-white text-sm font-semibold transition">← Back</button>
            <div>
              <h1 className="text-2xl font-black text-white tracking-tight uppercase">Tennis Deep Stats</h1>
              <p className="text-zinc-500 text-xs uppercase tracking-wider">
                Player Comparison · <span className={surfaceColor()}>{surface}</span>
              </p>
            </div>
          </div>
          <a
            href="https://rapidapi.com/jjrm365-kIFr3Nx_odV/api/tennis-api-atp-wta-itf"
            target="_blank"
            rel="noopener noreferrer"
            className="text-right"
          >
            <div className="text-xs text-zinc-500 uppercase tracking-wider">Powered by</div>
            <div className="text-sm font-black text-white uppercase tracking-tight hover:text-blue-400 transition">Matchstat</div>
          </a>
        </header>

        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 mb-3 flex items-center gap-3">
          <span className="text-zinc-500 text-xs uppercase tracking-wider">Last</span>
          <select
            className="bg-zinc-800 border border-zinc-700 text-white rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-blue-500"
            value={lastN} onChange={e => { setLastN(parseInt(e.target.value)); setSelectedMatch(null); }}>
            <option value={5}>5 matches</option>
            <option value={10}>10 matches</option>
          </select>
          {error && <span className="text-red-400 text-xs">{error}</span>}
          {stats1 && stats2 && (
            <button
              onClick={handleShare}
              className="ml-auto flex items-center gap-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-white rounded-lg px-3 py-1.5 text-xs font-semibold transition"
            >
              {copied ? '✓ Copied!' : '⬆ Share'}
            </button>
          )}
        </div>

        {loading && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-10 text-center">
            <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-blue-400 font-bold text-sm uppercase tracking-widest">Loading stats...</p>
            <p className="text-zinc-600 text-xs mt-1">First load builds cache — instant next time</p>
          </div>
        )}

        {!loading && stats1 && stats2 && (
          <div>
          <p className="md:hidden text-center text-zinc-600 text-xs mb-2">← swipe to see full comparison →</p>
          <div className="overflow-x-auto pb-1">
          <div className="grid grid-cols-[1fr_2fr_1fr] gap-2 min-w-[620px]">

            {/* Left player card */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden flex flex-col">
              <div className="px-3 py-2.5 border-b border-zinc-800">
                <div className="font-black text-white text-sm truncate">{stats1.playerName}</div>
                {stats1.wins + stats1.losses === 0 ? (
                  <div className="text-xs text-zinc-500 mt-0.5">No {surface.toLowerCase()} history</div>
                ) : (
                  <>
                    <div className={`text-sm font-bold mt-0.5 ${stats1.wins > stats1.losses ? 'text-emerald-400' : 'text-red-400'}`}>
                      {stats1.wins}W–{stats1.losses}L
                    </div>
                    <div className="mt-1.5"><FormDots form={stats1.form} /></div>
                  </>
                )}
              </div>
              <div className="overflow-y-auto divide-y divide-zinc-800/60">
                {stats1.matches.slice(0, lastN).map((m, i) => (
                  <button
                    key={i}
                    onClick={() => handleMatchClick(m, 'left', player1Id, stats1.playerName)}
                    className={`w-full px-3 py-2 flex items-start gap-2 text-left transition ${
                      selectedMatch?.matchId === m.id && selectedMatch?.side === 'left'
                        ? 'bg-blue-900/30 border-l-2 border-blue-500'
                        : 'hover:bg-zinc-800/50 cursor-pointer'
                    }`}
                  >
                    <span className={`text-xs font-black mt-0.5 shrink-0 w-4 ${m.won ? 'text-emerald-400' : 'text-red-400'}`}>{m.won ? 'W' : 'L'}</span>
                    <div className="min-w-0">
                      <div className="text-xs text-zinc-300 truncate">vs {m.opponentName}</div>
                      <div className="text-xs text-zinc-600">{m.result}</div>
                      <div className="text-xs text-zinc-700">{formatMatchDate(m.date)}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Center stats panel */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
              <div className="grid grid-cols-3 border-b border-zinc-800 bg-zinc-800/40">
                <div className="px-3 py-2.5 text-center">
                  <div className="font-black text-white text-xs uppercase tracking-tight truncate">{centerLeft}</div>
                </div>
                <div className="px-2 py-2.5 text-center border-x border-zinc-800">
                  {selectedMatch ? (
                    <>
                      <div className="text-zinc-300 text-xs font-bold">{selectedMatch.result}</div>
                      <div className="text-zinc-500 text-xs">{formatMatchDate(selectedMatch.date)}</div>
                    </>
                  ) : (
                    <>
                      <div className="text-zinc-500 text-xs uppercase tracking-wider">
                        Last {stats1.wins + stats1.losses}/{stats2.wins + stats2.losses}
                      </div>
                      <div className={`text-xs font-bold ${surfaceColor()}`}>{surface}</div>
                    </>
                  )}
                </div>
                <div className="px-3 py-2.5 text-center">
                  <div className="font-black text-white text-xs uppercase tracking-tight truncate">{centerRight}</div>
                </div>
              </div>

              <div className="px-3 pb-2">
                {selectedMatch ? (
                  <>
                    <div className="py-2 text-center">
                      <button onClick={() => setSelectedMatch(null)} className="text-zinc-500 hover:text-zinc-300 text-xs transition">
                        ← overview
                      </button>
                    </div>
                    {matchDetailLoading && (
                      <div className="py-6 text-center text-zinc-500 text-xs">Loading match stats...</div>
                    )}
                    {!matchDetailLoading && !matchDetail && (
                      <div className="py-6 text-center text-zinc-500 text-xs">No stats available for this match</div>
                    )}
                    {!matchDetailLoading && matchDetail && (
                      <>
                        <div className="py-2 text-center">
                          <span className="text-xs font-black text-blue-400 uppercase tracking-widest">Serve</span>
                        </div>
                        <StatRow label="1st Serve %" v1={matchDetail.left.firstServePct} v2={matchDetail.right.firstServePct} />
                        <StatRow label="1st Serve Won %" v1={matchDetail.left.firstServeWonPct} v2={matchDetail.right.firstServeWonPct} />
                        <StatRow label="2nd Serve Won %" v1={matchDetail.left.secondServeWonPct} v2={matchDetail.right.secondServeWonPct} />
                        <StatRow label="Aces" v1={matchDetail.left.aces} v2={matchDetail.right.aces} isPercent={false} />
                        <StatRow label="Dbl Faults" v1={matchDetail.left.dfs} v2={matchDetail.right.dfs} higherIsBetter={false} isPercent={false} />
                        <StatRow label="Serve Pts Won %" v1={matchDetail.left.servePtsWonPct} v2={matchDetail.right.servePtsWonPct} />
                        <div className="py-2 text-center mt-1">
                          <span className="text-xs font-black text-amber-400 uppercase tracking-widest">Return</span>
                        </div>
                        <StatRow label="Return Pts Won %" v1={matchDetail.left.returnPtsWonPct} v2={matchDetail.right.returnPtsWonPct} />
                        <StatRow label="Ret 1st Srv Won %" v1={matchDetail.left.return1stSrvWonPct} v2={matchDetail.right.return1stSrvWonPct} />
                        <StatRow label="Ret 2nd Srv Won %" v1={matchDetail.left.return2ndSrvWonPct} v2={matchDetail.right.return2ndSrvWonPct} />
                        <div className="py-2 text-center mt-1">
                          <span className="text-xs font-black text-violet-400 uppercase tracking-widest">Combined</span>
                        </div>
                        <StatRow label="Serve + Return %" v1={matchDetail.left.servePtsWonPct + matchDetail.left.returnPtsWonPct} v2={matchDetail.right.servePtsWonPct + matchDetail.right.returnPtsWonPct} />
                      </>
                    )}
                  </>
                ) : (
                  <>
                    {(stats1.wins + stats1.losses === 0 || stats2.wins + stats2.losses === 0) && (
                      <div className="py-3 text-center text-zinc-500 text-xs">
                        {stats1.wins + stats1.losses === 0 ? stats1.playerName : stats2.playerName} has no {surface.toLowerCase()} match history — stats unavailable
                      </div>
                    )}
                    <div className="py-2 text-center">
                      <span className="text-xs font-black text-blue-400 uppercase tracking-widest">Serve</span>
                    </div>
                    <StatRow label="1st Serve %" v1={stats1.avg1stServe} v2={stats2.avg1stServe} />
                    <StatRow label="1st Serve Won %" v1={stats1.avg1stWon} v2={stats2.avg1stWon} />
                    <StatRow label="2nd Serve Won %" v1={stats1.avg2ndWon} v2={stats2.avg2ndWon} />
                    <StatRow label="Aces / match" v1={stats1.avgAces} v2={stats2.avgAces} isPercent={false} />
                    <StatRow label="Dbl Faults" v1={stats1.avgDf} v2={stats2.avgDf} higherIsBetter={false} isPercent={false} />
                    <StatRow label="Serve Pts Won %" v1={stats1.avgServeWon} v2={stats2.avgServeWon} />
                    <div className="py-2 text-center mt-1">
                      <span className="text-xs font-black text-amber-400 uppercase tracking-widest">Return</span>
                    </div>
                    <StatRow label="Return Pts Won %" v1={stats1.avgReturnWon} v2={stats2.avgReturnWon} />
                    <StatRow label="Ret 1st Srv Won %" v1={stats1.avgReturn1stWon} v2={stats2.avgReturn1stWon} />
                    <StatRow label="Ret 2nd Srv Won %" v1={stats1.avgReturn2ndWon} v2={stats2.avgReturn2ndWon} />
                    <div className="py-2 text-center mt-1">
                      <span className="text-xs font-black text-violet-400 uppercase tracking-widest">Combined</span>
                    </div>
                    <StatRow label="Serve + Return %" v1={stats1.avgServeWon + stats1.avgReturnWon} v2={stats2.avgServeWon + stats2.avgReturnWon} />
                  </>
                )}
              </div>
            </div>

            {/* Right player card */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden flex flex-col">
              <div className="px-3 py-2.5 border-b border-zinc-800 text-right">
                <div className="font-black text-white text-sm truncate">{stats2.playerName}</div>
                {stats2.wins + stats2.losses === 0 ? (
                  <div className="text-xs text-zinc-500 mt-0.5">No {surface.toLowerCase()} history</div>
                ) : (
                  <>
                    <div className={`text-sm font-bold mt-0.5 ${stats2.wins > stats2.losses ? 'text-emerald-400' : 'text-red-400'}`}>
                      {stats2.wins}W–{stats2.losses}L
                    </div>
                    <div className="mt-1.5"><FormDots form={stats2.form} align="right" /></div>
                  </>
                )}
              </div>
              <div className="overflow-y-auto divide-y divide-zinc-800/60">
                {stats2.matches.slice(0, lastN).map((m, i) => (
                  <button
                    key={i}
                    onClick={() => handleMatchClick(m, 'right', player2Id, stats2.playerName)}
                    className={`w-full px-3 py-2 flex items-start gap-2 justify-end text-right transition ${
                      selectedMatch?.matchId === m.id && selectedMatch?.side === 'right'
                        ? 'bg-blue-900/30 border-r-2 border-blue-500'
                        : 'hover:bg-zinc-800/50 cursor-pointer'
                    }`}
                  >
                    <div className="min-w-0 text-right">
                      <div className="text-xs text-zinc-300 truncate">vs {m.opponentName}</div>
                      <div className="text-xs text-zinc-600">{m.result}</div>
                      <div className="text-xs text-zinc-700">{formatMatchDate(m.date)}</div>
                    </div>
                    <span className={`text-xs font-black mt-0.5 shrink-0 w-4 text-right ${m.won ? 'text-emerald-400' : 'text-red-400'}`}>{m.won ? 'W' : 'L'}</span>
                  </button>
                ))}
              </div>
            </div>

          </div>
          </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ComparePage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-zinc-950 flex items-center justify-center text-zinc-500">Loading...</div>}>
      <CompareContent />
    </Suspense>
  );
}
