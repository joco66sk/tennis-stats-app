'use client';
import { useState } from 'react';
import { PlayerSurfaceStats } from '@/lib/player-stats';

function fmt(n: number, d = 1) { return n.toFixed(d); }

function fmtDate(s: string) {
  return new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function surfaceColor(s: string) {
  if (s === 'Clay') return '#f97316';
  if (s === 'Grass') return '#34d399';
  return '#60a5fa';
}

function StatRow({ label, value, isPercent = true }: { label: string; value: number; isPercent?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderTop: '1px solid #27272a' }}>
      <span style={{ fontSize: 12, color: '#71717a' }}>{label}</span>
      <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: '#d4d4d8' }}>
        {fmt(value)}{isPercent ? '%' : ''}
      </span>
    </div>
  );
}

interface Props {
  clay: PlayerSurfaceStats;
  hard: PlayerSurfaceStats;
  grass: PlayerSurfaceStats;
}

export default function PlayerTabs({ clay, hard, grass }: Props) {
  const [active, setActive] = useState<'Clay' | 'Hard' | 'Grass'>('Clay');
  const statsMap = { Clay: clay, Hard: hard, Grass: grass };
  const s = statsMap[active];
  const sc = surfaceColor(active);
  const total = s.wins + s.losses;
  const pct = total > 0 ? Math.round(s.wins / total * 100) : 0;
  const winColor = s.wins >= s.losses ? '#34d399' : '#f87171';

  return (
    <>
      {/* Surface tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        {(['Clay', 'Hard', 'Grass'] as const).map(surf => {
          const st = statsMap[surf];
          const tot = st.wins + st.losses;
          const isActive = active === surf;
          const col = surfaceColor(surf);
          return (
            <button key={surf} onClick={() => setActive(surf)} style={{
              flex: 1, padding: '8px 4px',
              borderRadius: 10, fontWeight: 700, fontSize: 13,
              border: `1.5px solid ${isActive ? col : '#27272a'}`,
              background: isActive ? `${col}1a` : '#18181b',
              color: isActive ? col : '#52525b',
              cursor: 'pointer', textAlign: 'center',
            }}>
              {surf}
              <span style={{ display: 'block', fontSize: 11, fontWeight: 500, marginTop: 2, color: isActive ? col : '#3f3f46' }}>
                {tot > 0 ? `${st.wins}–${st.losses}` : '—'}
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
          {/* Win rate + form */}
          <div style={{
            background: '#18181b', border: `1px solid #27272a`, borderRadius: 12,
            padding: '12px 14px', marginBottom: 10,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span style={{ fontSize: 30, fontWeight: 900, color: winColor, lineHeight: 1 }}>{pct}%</span>
              <span style={{ fontSize: 13, color: '#52525b' }}>{s.wins}W–{s.losses}L</span>
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
            <div style={{ background: '#18181b', border: '1px solid #27272a', borderRadius: 12, padding: '10px 14px', marginBottom: 10 }}>
              <div style={{ fontSize: 10, fontWeight: 900, color: '#60a5fa', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 2 }}>Serve</div>
              <StatRow label="1st Serve %" value={s.avg1stServe} />
              <StatRow label="1st Serve Won %" value={s.avg1stWon} />
              <StatRow label="2nd Serve Won %" value={s.avg2ndWon} />
              <StatRow label="Aces / match" value={s.avgAces} isPercent={false} />
              <StatRow label="Double Faults" value={s.avgDf} isPercent={false} />
              <StatRow label="Serve Pts Won %" value={s.avgServeWon} />
              <div style={{ fontSize: 10, fontWeight: 900, color: '#fbbf24', textTransform: 'uppercase', letterSpacing: '0.1em', marginTop: 8, marginBottom: 2 }}>Return</div>
              <StatRow label="Return Pts Won %" value={s.avgReturnWon} />
              <StatRow label="Ret 1st Srv Won %" value={s.avgReturn1stWon} />
              <StatRow label="Ret 2nd Srv Won %" value={s.avgReturn2ndWon} />
              <div style={{ fontSize: 10, fontWeight: 900, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: '0.1em', marginTop: 8, marginBottom: 2 }}>Combined</div>
              <StatRow label="Serve + Return %" value={s.avgServeWon + s.avgReturnWon} />
              {/* Win rate bar */}
              <div style={{ borderTop: '1px solid #27272a', marginTop: 6, paddingTop: 8 }}>
                <div style={{ height: 6, background: '#27272a', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: winColor, borderRadius: 3 }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                  <span style={{ fontSize: 10, color: '#52525b' }}>{s.wins} wins</span>
                  <span style={{ fontSize: 10, color: '#52525b' }}>{s.losses} losses</span>
                </div>
              </div>
            </div>
          )}

          {/* Match history */}
          <div style={{ background: '#18181b', border: '1px solid #27272a', borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ padding: '8px 14px', borderBottom: '1px solid #27272a', fontSize: 11, fontWeight: 700, color: '#a1a1aa', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Recent {active} Matches
            </div>
            {s.matches.slice(0, 10).map((m, i) => (
              <div key={i} style={{ padding: '7px 14px', borderTop: i > 0 ? '1px solid #1f1f22' : 'none', display: 'flex', alignItems: 'center', gap: 10 }}>
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
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
