import { MetadataRoute } from 'next';
import fs from 'fs';
import path from 'path';

const BASE = 'https://tennisdeepstats.com';
const CACHE_DIR = path.join(process.cwd(), 'cache');
function normalizeSurface(s?: string): string {
  if (!s) return 'Hard';
  if (s === 'I.hard' || s === 'Carpet') return 'Hard';
  return s;
}

function toSlug(s: string) {
  return s.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function dateRange(daysBack: number, daysAhead: number): string[] {
  return Array.from({ length: daysBack + daysAhead + 1 }, (_, i) => {
    const d = new Date(Date.now() + 2 * 60 * 60 * 1000 + (i - daysBack) * 86400000);
    return d.toISOString().split('T')[0];
  });
}

function fixtureUrls(): MetadataRoute.Sitemap {
  const dates = dateRange(30, 14);
  const seen = new Set<string>();
  const entries: MetadataRoute.Sitemap = [];

  for (const date of dates) {
    const fp = path.join(CACHE_DIR, `fixtures-${date}.json`);
    if (!fs.existsSync(fp)) continue;

    let fixtures: any[];
    try { fixtures = JSON.parse(fs.readFileSync(fp, 'utf-8')).fixtures ?? []; }
    catch { continue; }

    const isPast = date < new Date().toISOString().split('T')[0];
    const dd = date.slice(8, 10);
    const mm = date.slice(5, 7);
    const yy = date.slice(2, 4);

    for (const f of fixtures) {
      const rankId = f.tournament?.rank?.id ?? 0;
      if (rankId < 2) continue;
      if (f.player1?.name?.includes('/') || f.player2?.name?.includes('/')) continue;
      if (!f.player1?.id || !f.player2?.id) continue;

      const surface = normalizeSurface(f.tournament?.court?.name) || 'Hard';
      const p1Slug = toSlug(f.player1.name);
      const p2Slug = toSlug(f.player2.name);
      const slug = `${p1Slug}-${p2Slug}-${dd}${mm}${yy}-${surface}-${f.player1.id}-${f.player2.id}`;
      const url = `${BASE}/compare/${slug}`;

      if (seen.has(url)) continue;
      seen.add(url);

      entries.push({
        url,
        lastModified: new Date(date),
        changeFrequency: isPast ? 'monthly' : 'daily',
        priority: isPast ? 0.6 : 0.9,
      });
    }
  }

  return entries;
}

function playerUrls(): MetadataRoute.Sitemap {
  const dates = dateRange(0, 14);
  const seen = new Set<string>();
  const entries: MetadataRoute.Sitemap = [];

  for (const date of dates) {
    const fp = path.join(CACHE_DIR, `fixtures-${date}.json`);
    if (!fs.existsSync(fp)) continue;
    let fixtures: any[];
    try { fixtures = JSON.parse(fs.readFileSync(fp, 'utf-8')).fixtures ?? []; }
    catch { continue; }

    for (const f of fixtures) {
      for (const p of [f.player1, f.player2]) {
        if (!p?.id) continue;
        const url = `${BASE}/player/${p.id}`;
        if (seen.has(url)) continue;
        seen.add(url);
        entries.push({ url, lastModified: new Date(), changeFrequency: 'weekly', priority: 0.7 });
      }
    }
  }

  return entries;
}

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: BASE,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 1,
    },
    ...fixtureUrls(),
    ...playerUrls(),
  ];
}
