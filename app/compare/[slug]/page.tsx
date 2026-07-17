import Link from 'next/link';
import { redirect } from 'next/navigation';
import { computePlayerSurfaceStats, PlayerSurfaceStats } from '@/lib/player-stats';

export const revalidate = 3600; // re-render at most once per hour

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmt(n: number, decimals = 1) { return n.toFixed(decimals); }

function fmtDate(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
}

function toTitleCase(slug: string) {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function surfaceColor(surface: string) {
  if (surface === 'Clay') return '#f97316';
  if (surface === 'Grass') return '#34d399';
  return '#60a5fa';
}

function buildNarrative(s1: PlayerSurfaceStats, s2: PlayerSurfaceStats, surface: string): string {
  const hasStats = s1.matchesWithStats > 0 && s2.matchesWithStats > 0;
  if (!hasStats) return '';
  const comb1 = s1.avgServeWon + s1.avgReturnWon;
  const comb2 = s2.avgServeWon + s2.avgReturnWon;
  const leader = comb1 > comb2 ? s1 : s2;
  const trailer = comb1 > comb2 ? s2 : s1;
  const diff = Math.abs(comb1 - comb2);
  const surface_lc = surface.toLowerCase();
  const record = `${leader.wins}W–${leader.losses}L vs ${trailer.wins}W–${trailer.losses}L`;
  return `On ${surface_lc}, ${leader.playerName} leads with ${fmt(Math.max(comb1, comb2))}% combined serve + return versus ${trailer.playerName}'s ${fmt(Math.min(comb1, comb2))}% — a ${fmt(diff)}pp gap. W-L records over last 10 matches on ${surface_lc}: ${leader.playerName} ${record}.`;
}

// ── Stat row component (server, no interactivity) ──────────────────────────────

function Row({ label, v1, v2, higherIsBetter = true, isPercent = true }: {
  label: string; v1: number; v2: number; higherIsBetter?: boolean; isPercent?: boolean;
}) {
  const p1Better = higherIsBetter ? v1 > v2 : v1 < v2;
  const p2Better = higherIsBetter ? v2 > v1 : v2 < v1;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 9rem 1fr', alignItems: 'center', padding: '6px 0', borderTop: '1px solid #27272a' }}>
      <div style={{ textAlign: 'right', paddingRight: 12, fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: p1Better ? '#34d399' : '#71717a' }}>
        {fmt(v1)}{isPercent ? '%' : ''}
      </div>
      <div style={{ textAlign: 'center', fontSize: 11, color: '#71717a' }}>{label}</div>
      <div style={{ textAlign: 'left', paddingLeft: 12, fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: p2Better ? '#34d399' : '#71717a' }}>
        {fmt(v2)}{isPercent ? '%' : ''}
      </div>
    </div>
  );
}

function SectionLabel({ children, color }: { children: string; color: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '8px 0 4px', fontSize: 11, fontWeight: 900, letterSpacing: '0.1em', textTransform: 'uppercase', color }} >
      {children}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

function parseSlug(slug: string): { p1: string; p2: string; surface: string } | null {
  // Format: {name1}-{name2}-{DDMMYY}-{surface}-{id1}-{id2}
  // Parse from the right so hyphenated names work fine
  const parts = slug.split('-');
  if (parts.length < 4) return null;
  const p2 = parts[parts.length - 1];
  const p1 = parts[parts.length - 2];
  const surface = parts[parts.length - 3];
  if (!/^\d+$/.test(p1) || !/^\d+$/.test(p2)) return null;
  if (!['Clay', 'Hard', 'Grass', 'All'].includes(surface)) return null;
  return { p1, p2, surface };
}

export default async function MatchSlugPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const parsed = parseSlug(slug);
  if (!parsed) redirect('/');

  const { p1, p2, surface } = parsed;
  const interactiveUrl = `/compare?p1=${p1}&p2=${p2}&surface=${surface}`;

  const [s1, s2] = await Promise.all([
    Promise.resolve(computePlayerSurfaceStats(p1, surface, 10)),
    Promise.resolve(computePlayerSurfaceStats(p2, surface, 10)),
  ]);

  const player1Name = s1.playerName;
  const player2Name = s2.playerName;
  const hasData = s1.matchesWithStats > 0 || s2.matchesWithStats > 0;
  const narrative = buildNarrative(s1, s2, surface);
  const sc = surfaceColor(surface);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SportsEvent',
    name: `${player1Name} vs ${player2Name}`,
    sport: 'Tennis',
    description: narrative || `${player1Name} vs ${player2Name} ${surface} surface stats — serve, return and combined performance data.`,
    url: `https://tennisdeepstats.com/compare/${slug}`,
    competitor: [
      { '@type': 'Person', name: player1Name },
      { '@type': 'Person', name: player2Name },
    ],
  };

  return (
    <div style={{ minHeight: '100vh', background: '#09090b', color: '#fff', padding: '16px', fontFamily: 'system-ui, sans-serif' }}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      <div style={{ maxWidth: 720, margin: '0 auto' }}>

        {/* Header + record cards combined */}
        <div style={{ marginBottom: 12 }}>
          <Link href="/" style={{ color: '#71717a', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>← Fixtures</Link>
          <div style={{ marginTop: 10, fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#71717a' }}>Tennis Deep Stats</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 8, marginTop: 8, alignItems: 'center' }}>
            {/* P1 */}
            <div style={{ background: '#18181b', border: '1px solid #27272a', borderRadius: 12, padding: '10px 12px' }}>
              <div style={{ fontWeight: 900, fontSize: 14 }}>{player1Name}</div>
              {s1.wins + s1.losses === 0 ? (
                <div style={{ fontSize: 12, color: '#52525b', marginTop: 2 }}>No {surface.toLowerCase()} data</div>
              ) : (
                <>
                  <div style={{ fontSize: 13, fontWeight: 700, color: s1.wins >= s1.losses ? '#34d399' : '#f87171', marginTop: 2 }}>{s1.wins}W–{s1.losses}L</div>
                  <div style={{ display: 'flex', gap: 3, marginTop: 5 }}>
                    {s1.form.map((w, j) => <span key={j} style={{ width: 9, height: 9, borderRadius: '50%', display: 'inline-block', background: w ? '#34d399' : '#ef4444' }} />)}
                  </div>
                </>
              )}
            </div>
            {/* VS */}
            <div style={{ textAlign: 'center', fontSize: 12, fontWeight: 700, color: '#52525b' }}>
              <div>vs</div>
              <div style={{ fontSize: 10, color: sc, fontWeight: 700, marginTop: 4 }}>{surface}</div>
            </div>
            {/* P2 */}
            <div style={{ background: '#18181b', border: '1px solid #27272a', borderRadius: 12, padding: '10px 12px' }}>
              <div style={{ fontWeight: 900, fontSize: 14 }}>{player2Name}</div>
              {s2.wins + s2.losses === 0 ? (
                <div style={{ fontSize: 12, color: '#52525b', marginTop: 2 }}>No {surface.toLowerCase()} data</div>
              ) : (
                <>
                  <div style={{ fontSize: 13, fontWeight: 700, color: s2.wins >= s2.losses ? '#34d399' : '#f87171', marginTop: 2 }}>{s2.wins}W–{s2.losses}L</div>
                  <div style={{ display: 'flex', gap: 3, marginTop: 5 }}>
                    {s2.form.map((w, j) => <span key={j} style={{ width: 9, height: 9, borderRadius: '50%', display: 'inline-block', background: w ? '#34d399' : '#ef4444' }} />)}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Two-column body: stats left, text + history right */}
        <style>{`
          .compare-body { display: flex; flex-direction: column; gap: 10px; }
          @media (min-width: 600px) {
            .compare-body { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; align-items: start; }
          }
        `}</style>
        <div className="compare-body" style={{ marginBottom: 10 }}>

          {/* Left column: stats numbers + narrative at bottom */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {hasData ? (
              <div style={{ background: '#18181b', border: '1px solid #27272a', borderRadius: 12, padding: '10px 12px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 7.5rem 1fr', marginBottom: 4 }}>
                  <div style={{ textAlign: 'right', paddingRight: 8, fontSize: 10, fontWeight: 900, color: '#a1a1aa', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{player1Name.split(' ').pop()}</div>
                  <div />
                  <div style={{ textAlign: 'left', paddingLeft: 8, fontSize: 10, fontWeight: 900, color: '#a1a1aa', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{player2Name.split(' ').pop()}</div>
                </div>
                <SectionLabel color="#60a5fa">Serve</SectionLabel>
                <Row label="1st Serve %" v1={s1.avg1stServe} v2={s2.avg1stServe} />
                <Row label="1st Serve Won %" v1={s1.avg1stWon} v2={s2.avg1stWon} />
                <Row label="2nd Serve Won %" v1={s1.avg2ndWon} v2={s2.avg2ndWon} />
                <Row label="Aces / match" v1={s1.avgAces} v2={s2.avgAces} isPercent={false} />
                <Row label="Dbl Faults" v1={s1.avgDf} v2={s2.avgDf} higherIsBetter={false} isPercent={false} />
                <Row label="Serve Pts Won %" v1={s1.avgServeWon} v2={s2.avgServeWon} />
                <SectionLabel color="#fbbf24">Return</SectionLabel>
                <Row label="Return Pts Won %" v1={s1.avgReturnWon} v2={s2.avgReturnWon} />
                <Row label="Ret 1st Srv Won %" v1={s1.avgReturn1stWon} v2={s2.avgReturn1stWon} />
                <Row label="Ret 2nd Srv Won %" v1={s1.avgReturn2ndWon} v2={s2.avgReturn2ndWon} />
                <SectionLabel color="#a78bfa">Combined</SectionLabel>
                <Row label="Serve + Return %" v1={s1.avgServeWon + s1.avgReturnWon} v2={s2.avgServeWon + s2.avgReturnWon} />
              </div>
            ) : (
              <div style={{ background: '#18181b', border: '1px solid #27272a', borderRadius: 12, padding: '16px', color: '#52525b', fontSize: 13, textAlign: 'center' }}>
                No stats available
              </div>
            )}
            {narrative && (
              <p style={{ fontSize: 12, color: '#a1a1aa', lineHeight: 1.6, background: '#18181b', border: '1px solid #27272a', borderRadius: 10, padding: '10px 12px', margin: 0 }}>
                {narrative}
              </p>
            )}
          </div>

          {/* Right column: match history both players */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[s1, s2].map((s, si) => (
              <div key={si} style={{ background: '#18181b', border: '1px solid #27272a', borderRadius: 10, overflow: 'hidden' }}>
                <div style={{ padding: '6px 10px', borderBottom: '1px solid #27272a', fontSize: 10, fontWeight: 700, color: '#a1a1aa', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  {s.playerName.split(' ').pop()} — Recent {surface}
                </div>
                {s.matches.slice(0, 10).map((m, i) => (
                  <div key={i} style={{ padding: '4px 10px', borderTop: i > 0 ? '1px solid #1f1f22' : 'none', display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
                    <span style={{ fontSize: 10, fontWeight: 900, color: m.won ? '#34d399' : '#f87171', width: 10, flexShrink: 0 }}>{m.won ? 'W' : 'L'}</span>
                    <span style={{ fontSize: 11, color: '#d4d4d8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      {m.opponentName.split(' ').pop()}
                    </span>
                    <span style={{ fontSize: 10, color: '#52525b', flexShrink: 0 }}>{fmtDate(m.date)}</span>
                  </div>
                ))}
                {s.matches.length === 0 && (
                  <div style={{ padding: '8px 10px', fontSize: 11, color: '#52525b' }}>No matches found</div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* CTA */}
        <Link
          href={interactiveUrl}
          style={{ display: 'block', background: '#1d4ed8', color: '#fff', textAlign: 'center', padding: '9px 16px', borderRadius: 10, fontWeight: 700, fontSize: 13, textDecoration: 'none', marginBottom: 12 }}
        >
          View Interactive Comparison + Individual Match Stats →
        </Link>

        <div style={{ textAlign: 'center', fontSize: 11, color: '#3f3f46' }}>
          tennisdeepstats.com — serve &amp; return stats before every ATP/WTA match
        </div>

      </div>
    </div>
  );
}

// ── Metadata ──────────────────────────────────────────────────────────────────

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ p1?: string; p2?: string; surface?: string }>;
}) {
  const { slug } = await params;
  const { p1, p2, surface } = await searchParams;

  const parts = slug.split('-vs-');
  const p1Name = toTitleCase(parts[0] || '');
  const rest = parts[1] || '';
  const p2Parts = rest.split('-');
  const p2Name = toTitleCase(p2Parts.slice(0, 2).join('-'));
  const surf = surface || 'Clay';

  let description = `${p1Name} vs ${p2Name} ${surf} surface stats — serve %, return %, combined serve+return performance. Data from last 10 ATP matches on ${surf.toLowerCase()}.`;

  if (p1 && p2) {
    try {
      const s1 = computePlayerSurfaceStats(p1, surf, 10);
      const s2 = computePlayerSurfaceStats(p2, surf, 10);
      const narrative = buildNarrative(s1, s2, surf);
      if (narrative) description = narrative;
    } catch {}
  }

  return {
    title: `${p1Name} vs ${p2Name} ${surf} Stats | Tennis Deep Stats`,
    description,
    openGraph: {
      title: `${p1Name} vs ${p2Name} — ${surf} Stats`,
      description,
      url: `https://tennisdeepstats.com/compare/${slug}?p1=${p1}&p2=${p2}&surface=${surf}`,
      siteName: 'Tennis Deep Stats',
    },
  };
}
