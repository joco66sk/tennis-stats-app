import { MetadataRoute } from 'next';
import fs from 'fs';
import path from 'path';
import { slugifyLastName, playerNameSlug, tournamentNameSlug } from '@/lib/slugs';

const BASE = 'https://tennisdeepstats.com';
const CACHE_DIR = path.join(process.cwd(), 'cache');

function normalizeSurface(s?: string): string {
  if (!s) return 'Hard';
  if (s === 'I.hard' || s === 'Carpet') return 'Hard';
  return s;
}

function dateRange(daysBack: number, daysAhead: number): string[] {
  return Array.from({ length: daysBack + daysAhead + 1 }, (_, i) => {
    const d = new Date(Date.now() + 2 * 60 * 60 * 1000 + (i - daysBack) * 86400000);
    return d.toISOString().split('T')[0];
  });
}

function loadFixtures(date: string): any[] {
  const fp = path.join(CACHE_DIR, `fixtures-${date}.json`);
  if (!fs.existsSync(fp)) return [];
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')).fixtures ?? []; }
  catch { return []; }
}

// Only upcoming matches — past compare pages are too thin for Google
function compareUrls(): MetadataRoute.Sitemap {
  const today = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().split('T')[0];
  const dates = dateRange(0, 6); // today + 6 days ahead only
  const seen = new Set<string>();
  const entries: MetadataRoute.Sitemap = [];

  for (const date of dates) {
    const fixtures = loadFixtures(date);
    const dd = date.slice(8, 10);
    const mm = date.slice(5, 7);
    const yy = date.slice(2, 4);

    for (const f of fixtures) {
      const rankId = f.tournament?.rank?.id ?? 0;
      if (rankId < 2) continue;
      if (f.player1?.name?.includes('/') || f.player2?.name?.includes('/')) continue;
      if (!f.player1?.id || !f.player2?.id) continue;

      const surface = normalizeSurface(f.tournament?.court?.name) || 'Hard';
      const p1Slug = slugifyLastName(f.player1.name);
      const p2Slug = slugifyLastName(f.player2.name);
      const slug = `${p1Slug}-${p2Slug}-${dd}${mm}${yy}-${surface}-${f.player1.id}-${f.player2.id}`;
      const url = `${BASE}/compare/${slug}`;

      if (seen.has(url)) continue;
      seen.add(url);

      entries.push({
        url,
        lastModified: new Date(date),
        changeFrequency: date === today ? 'hourly' : 'daily',
        priority: 0.7,
      });
    }
  }

  return entries;
}

function tournamentUrls(): MetadataRoute.Sitemap {
  const seen = new Set<string>();
  const entries: MetadataRoute.Sitemap = [];

  // From archive (covers past tournaments)
  const archivePath = path.join(CACHE_DIR, 'tournament-archive.json');
  if (fs.existsSync(archivePath)) {
    try {
      const { tournaments = {} } = JSON.parse(fs.readFileSync(archivePath, 'utf-8'));
      for (const t of Object.values(tournaments) as any[]) {
        if (!t?.id || !t.name) continue;
        const slug = `${t.id}-${tournamentNameSlug(t.name)}-${t.year}`;
        const url = `${BASE}/tournament/${slug}`;
        if (seen.has(url)) continue;
        seen.add(url);
        entries.push({ url, lastModified: new Date(t.endDate || t.startDate), changeFrequency: 'weekly', priority: 0.7 });
      }
    } catch {}
  }

  return entries;
}

function playerUrls(): MetadataRoute.Sitemap {
  const seen = new Set<string>();
  const entries: MetadataRoute.Sitemap = [];

  // All players from upcoming + recent fixtures
  for (const date of dateRange(7, 14)) {
    const fixtures = loadFixtures(date);
    for (const f of fixtures) {
      for (const p of [f.player1, f.player2]) {
        if (!p?.id || !p.name) continue;
        const slug = `${p.id}-${playerNameSlug(p.name)}`;
        const url = `${BASE}/player/${slug}`;
        if (seen.has(url)) continue;
        seen.add(url);
        entries.push({ url, lastModified: new Date(), changeFrequency: 'daily', priority: 0.8 });
      }
    }
  }

  return entries;
}

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: BASE, lastModified: new Date(), changeFrequency: 'hourly', priority: 1 },
    ...playerUrls(),
    ...tournamentUrls(),
    ...compareUrls(),
  ];
}
