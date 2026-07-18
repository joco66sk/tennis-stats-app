'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';

interface PlayerBasicStats { wins: number; losses: number; form: boolean[]; pct: number; }
interface MatchResult { score: string; p1Won: boolean; }
interface FixturePlayer { id: number; name: string; countryAcr?: string; ranking?: number; }
interface DrawFixture {
  id: number; date: string;
  player1: FixturePlayer; player2: FixturePlayer;
  round: string; compareUrl: string;
}
interface SingleMatchStats {
  firstServePct: number; firstServeWonPct: number; secondServeWonPct: number;
  aces: number; dfs: number; servePtsWonPct: number; returnPtsWonPct: number;
  return1stSrvWonPct: number; return2ndSrvWonPct: number;
}

export interface Props {
  tournamentName: string; surface: string; sc: string; tierLabel: string;
  dateRange: string; totalMatches: number;
  mainRounds: { roundName: string; fixtures: DrawFixture[] }[];
  qualRounds: { roundName: string; fixtures: DrawFixture[] }[];
  statsCache: Record<number, PlayerBasicStats | null>;
  resultsCache: Record<number, MatchResult | null>;
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

function StatChip({ s, align }: { s: PlayerBasicStats | null | undefined; align: 'left' | 'right' }) {
  if (!s) return null;
  const col = s.wins >= s.losses ? '#34d399' : '#f87171';
  const dots = s.form.map((w, i) => (
    <span key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: w ? '#34d399' : '#ef4444', display: 'inline-block' }} />
  ));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: align === 'right' ? 'flex-end' : 'flex-start' }}>
      {align === 'left' && <div style={{ display: 'flex', gap: 2 }}>{dots}</div>}
      <span style={{ fontSize: 12, fontWeight: 800, color: col, fontFamily: 'monospace' }}>{s.wins}–{s.losses}</span>
      {align === 'right' && <div style={{ display: 'flex', gap: 2 }}>{dots}</div>}
    </div>
  );
}

export default function TournamentDrawClient({
  tournamentName, surface, sc, tierLabel, dateRange, totalMatches,
  mainRounds, qualRounds, statsCache, resultsCache,
}: Props) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedFixture, setSelectedFixture] = useState<DrawFixture | null>(null);
  const [matchDetail, setMatchDetail] = useState<{ left: SingleMatchStats; right: SingleMatchStats; p1Name: string; p2Name: string } | null>(null);
  const [matchDetailLoading, setMatchDetailLoading] = useState(false);

  useEffect(() => {
    if (!selectedFixture) { setMatchDetail(null); return; }
    setMatchDetailLoading(true);
    setMatchDetail(null);
    fetch(`/api/match-stats?tournamentId=${selectedFixture.id}&homeId=${selectedFixture.player1.id}&awayId=${selectedFixture.player2.id}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return;
        const p1IsHome = data.homeId === selectedFixture.player1.id;
        const p1Raw = p1IsHome ? data.home : data.away;
        const p2Raw = p1IsHome ? data.away : data.home;
        if (!p1Raw || !p2Raw) return;
        setMatchDetail({
          left: computeMatchStats(p1Raw, p2Raw),
          right: computeMatchStats(p2Raw, p1Raw),
          p1Name: selectedFixture.player1.name,
          p2Name: selectedFixture.player2.name,
        });
      })
      .catch(() => {})
      .finally(() => setMatchDetailLoading(false));
  }, [selectedFixture]);

  const handleCardClick = (f: DrawFixture) => {
    if (selectedId === f.id) { setSelectedId(null); setSelectedFixture(null); return; }
    setSelectedId(f.id);
    setSelectedFixture(f);
  };

  const renderRoundFixtures = (fixtures: DrawFixture[]) => {
    const now = new Date();
    return fixtures
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
      .map(f => {
        const isPast = new Date(f.date) < now;
        const p1 = f.player1;
        const p2 = f.player2;
        const p1s = statsCache[p1.id];
        const p2s = statsCache[p2.id];
        const result = resultsCache[f.id];
        const p1Won = result?.p1Won;
        const p2Won = result ? !result.p1Won : undefined;
        const isSelected = selectedId === f.id;

        return (
          <div key={f.id} style={{ marginBottom: 6 }}>
            {/* Match card */}
            <div
              onClick={() => handleCardClick(f)}
              className="hover:bg-zinc-800/50 transition-colors"
              style={{
                background: isSelected ? '#1c1c20' : '#18181b',
                border: isSelected ? `1px solid ${sc}60` : '1px solid #27272a',
                borderRadius: isSelected ? '12px 12px 0 0' : 12,
                padding: '11px 12px',
                opacity: isPast ? 0.8 : 1,
                cursor: 'pointer',
              }}
            >
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: 6 }}>
                {/* P1 right */}
                <div style={{ textAlign: 'right', minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, marginBottom: p1s ? 3 : 0 }}>
                    {p1.ranking && <span style={{ fontSize: 11, color: '#52525b' }}>#{p1.ranking}</span>}
                    <Link href={`/player/${p1.id}`} onClick={e => e.stopPropagation()}
                      style={{ fontSize: 15, fontWeight: 700, color: p1Won ? '#f4f4f5' : p2Won ? '#52525b' : '#e4e4e7', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p1.name}
                    </Link>
                    {p1Won && <span style={{ fontSize: 11, color: '#34d399', flexShrink: 0 }}>W</span>}
                  </div>
                  <StatChip s={p1s} align="right" />
                </div>

                {/* Center */}
                <div style={{ textAlign: 'center', padding: '0 8px', flexShrink: 0 }}>
                  {result?.score ? (
                    <div style={{ fontSize: 12, fontWeight: 800, color: '#e4e4e7', whiteSpace: 'nowrap', letterSpacing: '0.04em' }}>{result.score}</div>
                  ) : (
                    <>
                      <div style={{ fontSize: 9, fontWeight: 900, color: sc, letterSpacing: '0.14em' }}>VS</div>
                      <div style={{ fontSize: 11, color: '#52525b', marginTop: 2, whiteSpace: 'nowrap' }}>
                        {new Date(f.date).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Stockholm' })}
                      </div>
                    </>
                  )}
                </div>

                {/* P2 left */}
                <div style={{ textAlign: 'left', minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 4, marginBottom: p2s ? 3 : 0 }}>
                    {p2Won && <span style={{ fontSize: 11, color: '#34d399', flexShrink: 0 }}>W</span>}
                    {p2.ranking && <span style={{ fontSize: 11, color: '#52525b' }}>#{p2.ranking}</span>}
                    <Link href={`/player/${p2.id}`} onClick={e => e.stopPropagation()}
                      style={{ fontSize: 15, fontWeight: 700, color: p2Won ? '#f4f4f5' : p1Won ? '#52525b' : '#e4e4e7', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p2.name}
                    </Link>
                  </div>
                  <StatChip s={p2s} align="left" />
                </div>
              </div>
            </div>

            {/* Inline stats panel */}
            {isSelected && (
              <div style={{ background: '#111115', border: `1px solid ${sc}40`, borderTop: 'none', borderRadius: '0 0 12px 12px', paddingBottom: 8 }}>
                {matchDetailLoading ? (
                  <div style={{ textAlign: 'center', padding: '20px', color: '#52525b', fontSize: 12 }}>Loading stats…</div>
                ) : matchDetail ? (
                  <div className="px-3 pt-3">
                    <div className="grid grid-cols-[1fr_10rem_1fr] items-center pb-2">
                      <Link href={`/player/${p1.id}`} className="text-right text-xs font-black text-white truncate pr-2 hover:text-emerald-400 transition">{matchDetail.p1Name}</Link>
                      <div className="text-center text-xs text-zinc-500">Match Stats</div>
                      <Link href={`/player/${p2.id}`} className="text-left text-xs font-black text-white truncate pl-2 hover:text-emerald-400 transition">{matchDetail.p2Name}</Link>
                    </div>
                    <div className="text-xs font-black text-blue-400 uppercase tracking-widest py-1">Serve</div>
                    <StatRow label="1st Serve %" v1={matchDetail.left.firstServePct} v2={matchDetail.right.firstServePct} />
                    <StatRow label="1st Srv Won %" v1={matchDetail.left.firstServeWonPct} v2={matchDetail.right.firstServeWonPct} />
                    <StatRow label="2nd Srv Won %" v1={matchDetail.left.secondServeWonPct} v2={matchDetail.right.secondServeWonPct} />
                    <StatRow label="Aces" v1={matchDetail.left.aces} v2={matchDetail.right.aces} isPercent={false} />
                    <StatRow label="Double Faults" v1={matchDetail.left.dfs} v2={matchDetail.right.dfs} higherIsBetter={false} isPercent={false} />
                    <StatRow label="Serve Pts Won %" v1={matchDetail.left.servePtsWonPct} v2={matchDetail.right.servePtsWonPct} />
                    <div className="text-xs font-black text-amber-400 uppercase tracking-widest py-1 mt-1">Return</div>
                    <StatRow label="Return Pts Won %" v1={matchDetail.left.returnPtsWonPct} v2={matchDetail.right.returnPtsWonPct} />
                    <StatRow label="Ret 1st Srv Won %" v1={matchDetail.left.return1stSrvWonPct} v2={matchDetail.right.return1stSrvWonPct} />
                    <StatRow label="Ret 2nd Srv Won %" v1={matchDetail.left.return2ndSrvWonPct} v2={matchDetail.right.return2ndSrvWonPct} />
                    <div className="text-xs font-black text-violet-400 uppercase tracking-widest py-1 mt-1">Combined</div>
                    <StatRow label="Serve + Return %" v1={matchDetail.left.servePtsWonPct + matchDetail.left.returnPtsWonPct} v2={matchDetail.right.servePtsWonPct + matchDetail.right.returnPtsWonPct} />
                    <div className="pt-3 text-center">
                      <Link href={f.compareUrl} className="text-xs text-zinc-500 hover:text-zinc-300 transition underline underline-offset-2">
                        Full surface comparison →
                      </Link>
                    </div>
                  </div>
                ) : (
                  <div style={{ textAlign: 'center', padding: '20px', color: '#52525b', fontSize: 12 }}>
                    No match stats available.{' '}
                    <Link href={f.compareUrl} style={{ color: '#60a5fa', textDecoration: 'none' }}>View surface stats →</Link>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      });
  };

  return (
    <div className="min-h-screen bg-zinc-950 p-4" style={{ fontFamily: 'system-ui, sans-serif', color: '#fff' }}>
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        {/* Nav */}
        <div style={{ marginBottom: 16 }}>
          <Link href="/" className="text-zinc-500 hover:text-white text-sm font-semibold transition">← Fixtures</Link>
          <div style={{ marginTop: 8, fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#71717a' }}>Tennis Deep Stats</div>
        </div>

        {/* Tournament header */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl" style={{ padding: '14px 16px', marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: sc, display: 'inline-block', flexShrink: 0 }} />
            <h1 style={{ fontSize: 20, fontWeight: 900, color: '#f4f4f5', margin: 0, lineHeight: 1 }}>{tournamentName}</h1>
            <span style={{ fontSize: 12, fontWeight: 700, color: sc, border: `1px solid ${sc}40`, borderRadius: 5, padding: '2px 8px', background: `${sc}12` }}>{surface}</span>
            {tierLabel && <span style={{ fontSize: 11, fontWeight: 700, color: '#71717a', border: '1px solid #27272a', borderRadius: 5, padding: '2px 7px' }}>{tierLabel}</span>}
          </div>
          <div style={{ fontSize: 12, color: '#52525b', marginTop: 8, paddingLeft: 20 }}>
            {dateRange} &nbsp;·&nbsp; {totalMatches} matches
          </div>
        </div>

        {/* Main draw */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {mainRounds.map(({ roundName, fixtures }) => (
            <section key={roundName}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <div style={{ flex: 1, height: 1, background: `${sc}30` }} />
                <span style={{ fontSize: 11, fontWeight: 900, letterSpacing: '0.12em', textTransform: 'uppercase', color: sc }}>{roundName}</span>
                <div style={{ flex: 1, height: 1, background: `${sc}30` }} />
              </div>
              {renderRoundFixtures(fixtures)}
            </section>
          ))}
        </div>

        {/* Qualifying */}
        {qualRounds.length > 0 && (
          <details style={{ marginTop: 24 }}>
            <summary style={{ fontSize: 11, fontWeight: 700, color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.1em', cursor: 'pointer', padding: '4px 0' }}>
              Qualifying ({qualRounds.reduce((n, { fixtures }) => n + fixtures.length, 0)} matches)
            </summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 12 }}>
              {qualRounds.map(({ roundName, fixtures }) => (
                <section key={roundName}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <div style={{ flex: 1, height: 1, background: '#27272a' }} />
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#52525b' }}>{roundName}</span>
                    <div style={{ flex: 1, height: 1, background: '#27272a' }} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {fixtures.map(f => (
                      <Link key={f.id} href={f.compareUrl}
                        className="block bg-zinc-900 border border-zinc-800 rounded-xl hover:bg-zinc-800/50 transition-colors"
                        style={{ padding: '8px 12px', textDecoration: 'none' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 13, color: '#a1a1aa', flex: 1 }}>{f.player1.name}</span>
                          <span style={{ fontSize: 11, color: '#3f3f46' }}>vs</span>
                          <span style={{ fontSize: 13, color: '#a1a1aa', flex: 1, textAlign: 'right' }}>{f.player2.name}</span>
                        </div>
                      </Link>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </details>
        )}

        <div style={{ textAlign: 'center', fontSize: 11, color: '#3f3f46', marginTop: 24, paddingBottom: 16 }}>
          tennisdeepstats.com — serve &amp; return stats before every ATP match
        </div>
      </div>
    </div>
  );
}
