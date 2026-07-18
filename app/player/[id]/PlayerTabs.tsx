'use client';
import { useState, useEffect } from 'react';
import { PlayerSurfaceStats } from '@/lib/player-stats';

function fmtDate(s: string) {
  return new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function surfaceColor(s: string) {
  if (s === 'Clay') return '#f97316';
  if (s === 'Grass') return '#34d399';
  return '#60a5fa';
}

interface SingleMatchStats {
  firstServePct: number; firstServeWonPct: number; secondServeWonPct: number;
  aces: number; dfs: number; servePtsWonPct: number; returnPtsWonPct: number;
  return1stSrvWonPct: number; return2ndSrvWonPct: number;
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
    aces: my.aces || 0, dfs: my.doubleFaults || 0,
    servePtsWonPct: svpt > 0 ? (((my.winningOnFirstServe || 0) + (my.winningOnSecondServe || 0)) / svpt) * 100 : 0,
    returnPtsWonPct: oppSvpt > 0 ? (oppSvpt - (opp.winningOnFirstServe || 0) - (opp.winningOnSecondServe || 0)) / oppSvpt * 100 : 0,
    return1stSrvWonPct: opp1stIn > 0 ? (opp1stIn - (opp.winningOnFirstServe || 0)) / opp1stIn * 100 : 0,
    return2ndSrvWonPct: opp2ndPts > 0 ? (opp2ndPts - (opp.winningOnSecondServe || 0)) / opp2ndPts * 100 : 0,
  };
}

function StatRow({ label, v1, v2, higherIsBetter = true, isPercent = true }: {
  label: string; v1: number; v2: number; higherIsBetter?: boolean; isPercent?: boolean;
}) {
  const p1Better = higherIsBetter ? v1 > v2 : v1 < v2;
  const p2Better = higherIsBetter ? v2 > v1 : v2 < v1;
  return (
    <div className="grid grid-cols-[1fr_10rem_1fr] items-center py-1.5 border-t border-zinc-800">
      <div className={`text-right pr-5 font-mono text-sm font-bold ${p1Better ? 'text-emerald-400' : 'text-zinc-500'}`}>
        {v1.toFixed(1)}{isPercent ? '%' : ''}
      </div>
      <div className="text-center text-xs text-zinc-500 px-2">{label}</div>
      <div className={`text-left pl-5 font-mono text-sm font-bold ${p2Better ? 'text-emerald-400' : 'text-zinc-500'}`}>
        {v2.toFixed(1)}{isPercent ? '%' : ''}
      </div>
    </div>
  );
}

interface Props {
  playerId: string;
  clay: PlayerSurfaceStats;
  hard: PlayerSurfaceStats;
  grass: PlayerSurfaceStats;
}

export default function PlayerTabs({ playerId, clay, hard, grass }: Props) {
  const [active, setActive] = useState<'Clay' | 'Hard' | 'Grass'>('Clay');
  const [selectedMatchKey, setSelectedMatchKey] = useState<string | null>(null);
  const [selectedMatch, setSelectedMatch] = useState<{ tournamentId: number; opponentId: number; homeId?: number; playerName: string; opponentName: string } | null>(null);
  const [matchDetail, setMatchDetail] = useState<{ my: SingleMatchStats; opp: SingleMatchStats; playerName: string; opponentName: string } | null>(null);
  const [matchDetailLoading, setMatchDetailLoading] = useState(false);

  const statsMap = { Clay: clay, Hard: hard, Grass: grass };
  const s = statsMap[active];
  const sc = surfaceColor(active);
  const total = s.wins + s.losses;
  const winColor = s.wins >= s.losses ? '#34d399' : '#f87171';

  useEffect(() => {
    if (!selectedMatch) { setMatchDetail(null); return; }
    setMatchDetailLoading(true);
    setMatchDetail(null);
    const pid = parseInt(playerId);
    const homeId = selectedMatch.homeId ?? pid;
    const awayId = homeId === pid ? selectedMatch.opponentId : pid;
    fetch(`/api/match-stats?tournamentId=${selectedMatch.tournamentId}&homeId=${homeId}&awayId=${awayId}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return;
        const playerIsHome = data.homeId === pid;
        const myRaw = playerIsHome ? data.home : data.away;
        const oppRaw = playerIsHome ? data.away : data.home;
        if (!myRaw || !oppRaw) return;
        setMatchDetail({
          my: computeMatchStats(myRaw, oppRaw),
          opp: computeMatchStats(oppRaw, myRaw),
          playerName: selectedMatch.playerName,
          opponentName: selectedMatch.opponentName,
        });
      })
      .catch(() => {})
      .finally(() => setMatchDetailLoading(false));
  }, [selectedMatch, playerId]);

  const handleMatchClick = (m: PlayerSurfaceStats['matches'][0], playerName: string) => {
    const key = `${m.tournamentId}-${m.opponentId}`;
    if (selectedMatchKey === key) { setSelectedMatchKey(null); setSelectedMatch(null); return; }
    setSelectedMatchKey(key);
    setSelectedMatch({ tournamentId: m.tournamentId, opponentId: m.opponentId, homeId: m.homeId, playerName, opponentName: m.opponentName });
  };

  return (
    <>
      {/* Surface tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        {(['Clay', 'Hard', 'Grass'] as const).map(surf => {
          const st = statsMap[surf];
          const isActive = active === surf;
          const col = surfaceColor(surf);
          return (
            <button key={surf} onClick={() => { setActive(surf); setSelectedMatchKey(null); setSelectedMatch(null); }} style={{
              flex: 1, padding: '8px 4px',
              borderRadius: 10, fontWeight: 700, fontSize: 13,
              border: `1.5px solid ${isActive ? col : '#27272a'}`,
              background: isActive ? `${col}1a` : '#18181b',
              color: isActive ? col : '#52525b',
              cursor: 'pointer', textAlign: 'center',
            }}>
              {surf}
              <span style={{ display: 'block', fontSize: 11, fontWeight: 500, marginTop: 2, color: isActive ? col : '#3f3f46' }}>
                {(st.wins + st.losses) > 0 ? `${st.wins}–${st.losses}` : '—'}
              </span>
            </button>
          );
        })}
      </div>

      {total === 0 ? (
        <div style={{ textAlign: 'center', color: '#52525b', fontSize: 13, padding: '32px 0' }}>
          No {active.toLowerCase()} matches found
        </div>
      ) : (
        <>
          {/* Win rate summary */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl" style={{ padding: '12px 14px', marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 26, fontWeight: 900, color: winColor, lineHeight: 1, fontFamily: 'monospace' }}>{s.wins}–{s.losses}</span>
              <span style={{ fontSize: 12, color: '#52525b' }}>last {total}</span>
            </div>
            {s.form.length > 0 && (
              <div style={{ display: 'flex', gap: 4 }}>
                {s.form.map((w, i) => (
                  <span key={i} style={{ width: 11, height: 11, borderRadius: '50%', background: w ? '#34d399' : '#ef4444', display: 'inline-block' }} />
                ))}
              </div>
            )}
          </div>

          {/* Stats card */}
          {s.matchesWithStats > 0 && (
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl" style={{ padding: '10px 14px', marginBottom: 10 }}>
              <div style={{ fontSize: 10, fontWeight: 900, color: '#60a5fa', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 2 }}>Serve</div>
              {[
                { label: '1st Serve %', value: s.avg1stServe },
                { label: '1st Serve Won %', value: s.avg1stWon },
                { label: '2nd Serve Won %', value: s.avg2ndWon },
                { label: 'Aces / match', value: s.avgAces, isPercent: false },
                { label: 'Double Faults', value: s.avgDf, isPercent: false },
                { label: 'Serve Pts Won %', value: s.avgServeWon },
              ].map(r => (
                <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderTop: '1px solid #27272a' }}>
                  <span style={{ fontSize: 12, color: '#71717a' }}>{r.label}</span>
                  <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: '#d4d4d8' }}>{r.value.toFixed(1)}{r.isPercent !== false ? '%' : ''}</span>
                </div>
              ))}
              <div style={{ fontSize: 10, fontWeight: 900, color: '#fbbf24', textTransform: 'uppercase', letterSpacing: '0.1em', marginTop: 8, marginBottom: 2 }}>Return</div>
              {[
                { label: 'Return Pts Won %', value: s.avgReturnWon },
                { label: 'Ret 1st Srv Won %', value: s.avgReturn1stWon },
                { label: 'Ret 2nd Srv Won %', value: s.avgReturn2ndWon },
              ].map(r => (
                <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderTop: '1px solid #27272a' }}>
                  <span style={{ fontSize: 12, color: '#71717a' }}>{r.label}</span>
                  <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: '#d4d4d8' }}>{r.value.toFixed(1)}%</span>
                </div>
              ))}
              <div style={{ fontSize: 10, fontWeight: 900, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: '0.1em', marginTop: 8, marginBottom: 2 }}>Combined</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderTop: '1px solid #27272a' }}>
                <span style={{ fontSize: 12, color: '#71717a' }}>Serve + Return %</span>
                <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: '#d4d4d8' }}>{(s.avgServeWon + s.avgReturnWon).toFixed(1)}%</span>
              </div>
            </div>
          )}

          {/* Match history — clickable */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl" style={{ overflow: 'hidden' }}>
            <div style={{ padding: '8px 14px', borderBottom: '1px solid #27272a', fontSize: 11, fontWeight: 700, color: '#a1a1aa', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Recent {active} Matches
            </div>
            {s.matches.slice(0, 10).map((m, i) => {
              const key = `${m.tournamentId}-${m.opponentId}`;
              const isSelected = selectedMatchKey === key;
              return (
                <div key={i}>
                  <div
                    onClick={() => handleMatchClick(m, s.playerName)}
                    className="hover:bg-zinc-800/50 transition-colors"
                    style={{
                      padding: '8px 14px',
                      borderTop: i > 0 ? '1px solid #1f1f22' : 'none',
                      display: 'flex', alignItems: 'center', gap: 10,
                      cursor: 'pointer',
                      background: isSelected ? '#1c1c20' : 'transparent',
                    }}
                  >
                    <span style={{ fontSize: 12, fontWeight: 900, color: m.won ? '#34d399' : '#f87171', width: 14, flexShrink: 0 }}>
                      {m.won ? 'W' : 'L'}
                    </span>
                    <span style={{ fontSize: 13, color: '#d4d4d8', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {m.opponentName}
                    </span>
                    <span style={{ fontSize: 12, color: '#71717a', flexShrink: 0, fontFamily: 'monospace', letterSpacing: '-0.02em' }}>
                      {m.result}
                    </span>
                    <span style={{ fontSize: 11, color: '#52525b', flexShrink: 0 }}>
                      {fmtDate(m.date)}
                    </span>
                    <span style={{ fontSize: 10, color: isSelected ? sc : '#3f3f46', flexShrink: 0 }}>
                      {isSelected ? '▲' : '▼'}
                    </span>
                  </div>

                  {/* Inline match stats */}
                  {isSelected && (
                    <div style={{ background: '#111115', borderTop: `1px solid ${sc}30`, borderBottom: i < s.matches.slice(0, 10).length - 1 ? '1px solid #1f1f22' : 'none', padding: '0 0 8px' }}>
                      {matchDetailLoading ? (
                        <div style={{ textAlign: 'center', padding: '16px', color: '#52525b', fontSize: 12 }}>Loading stats…</div>
                      ) : matchDetail ? (
                        <div className="px-3 pt-3">
                          <div className="grid grid-cols-[1fr_10rem_1fr] items-center pb-1">
                            <div className="text-right text-xs font-black text-white truncate pr-2">{matchDetail.playerName}</div>
                            <div className="text-center text-xs text-zinc-500">Match Stats</div>
                            <div className="text-left text-xs font-black text-white truncate pl-2">{matchDetail.opponentName}</div>
                          </div>
                          <div className="text-xs font-black text-blue-400 uppercase tracking-widest py-1">Serve</div>
                          <StatRow label="1st Serve %" v1={matchDetail.my.firstServePct} v2={matchDetail.opp.firstServePct} />
                          <StatRow label="1st Srv Won %" v1={matchDetail.my.firstServeWonPct} v2={matchDetail.opp.firstServeWonPct} />
                          <StatRow label="2nd Srv Won %" v1={matchDetail.my.secondServeWonPct} v2={matchDetail.opp.secondServeWonPct} />
                          <StatRow label="Aces" v1={matchDetail.my.aces} v2={matchDetail.opp.aces} isPercent={false} />
                          <StatRow label="Double Faults" v1={matchDetail.my.dfs} v2={matchDetail.opp.dfs} higherIsBetter={false} isPercent={false} />
                          <StatRow label="Serve Pts Won %" v1={matchDetail.my.servePtsWonPct} v2={matchDetail.opp.servePtsWonPct} />
                          <div className="text-xs font-black text-amber-400 uppercase tracking-widest py-1 mt-1">Return</div>
                          <StatRow label="Return Pts Won %" v1={matchDetail.my.returnPtsWonPct} v2={matchDetail.opp.returnPtsWonPct} />
                          <StatRow label="Ret 1st Srv Won %" v1={matchDetail.my.return1stSrvWonPct} v2={matchDetail.opp.return1stSrvWonPct} />
                          <StatRow label="Ret 2nd Srv Won %" v1={matchDetail.my.return2ndSrvWonPct} v2={matchDetail.opp.return2ndSrvWonPct} />
                          <div className="text-xs font-black text-violet-400 uppercase tracking-widest py-1 mt-1">Combined</div>
                          <StatRow label="Serve + Return %" v1={matchDetail.my.servePtsWonPct + matchDetail.my.returnPtsWonPct} v2={matchDetail.opp.servePtsWonPct + matchDetail.opp.returnPtsWonPct} />
                        </div>
                      ) : (
                        <div style={{ textAlign: 'center', padding: '16px', color: '#52525b', fontSize: 12 }}>
                          No match stats on file.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
