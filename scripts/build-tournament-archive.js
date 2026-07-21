#!/usr/bin/env node
/**
 * Scans all fixture files and builds/updates cache/tournament-archive.json.
 * Run after prefetch-fixtures so the archive accumulates over time even
 * when old fixture files are removed from the repo.
 */

const fs   = require('fs');
const path = require('path');

const CACHE_DIR  = path.join(__dirname, '..', 'cache');
const ARCHIVE_FP = path.join(CACHE_DIR, 'tournament-archive.json');

function normalizeSurface(s) {
  if (!s) return 'Hard';
  if (s === 'I.hard' || s === 'Carpet') return 'Hard';
  return s;
}

function loadArchive() {
  if (!fs.existsSync(ARCHIVE_FP)) return {};
  try { return JSON.parse(fs.readFileSync(ARCHIVE_FP, 'utf-8')).tournaments || {}; }
  catch { return {}; }
}

function main() {
  const existing = loadArchive();
  const files = fs.readdirSync(CACHE_DIR)
    .filter(f => /^fixtures-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();

  let added = 0, updated = 0;

  for (const file of files) {
    const dateStr = file.replace('fixtures-', '').replace('.json', '');
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf-8')); }
    catch { continue; }

    for (const f of (data.fixtures || [])) {
      const t = f.tournament;
      if (!t?.id || !t.name) continue;
      const id = String(t.id);
      const surface = normalizeSurface(t.court?.name);
      const tier = t.rank?.id ?? 0;
      const matchDate = (f.date || dateStr).slice(0, 10);
      const year = matchDate.slice(0, 4);

      if (!existing[id]) {
        existing[id] = { id: t.id, name: t.name, surface, tier, year, startDate: matchDate, endDate: matchDate };
        added++;
      } else {
        const e = existing[id];
        if (matchDate < e.startDate) { e.startDate = matchDate; updated++; }
        if (matchDate > e.endDate)   { e.endDate   = matchDate; updated++; }
        // update name/surface if more specific data arrives
        if (!e.surface && surface) { e.surface = surface; updated++; }
      }
    }
  }

  fs.writeFileSync(ARCHIVE_FP, JSON.stringify({ updatedAt: Date.now(), tournaments: existing }, null, 2));
  console.log(`Tournament archive: ${Object.keys(existing).length} total | +${added} new | ${updated} updated`);
}

main();
