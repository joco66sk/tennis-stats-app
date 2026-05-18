#!/usr/bin/env node
/**
 * One-time migration: converts player-matches-{id}.json files to
 * the new player-index-{id}.json format (matches stored inline per surface).
 * No API calls. Run once, then delete this script.
 */

const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', 'cache');
const COURT_ID_MAP = { 1: 'Hard', 2: 'Clay', 3: 'Hard', 5: 'Grass' };

function getSurface(m) {
  const fromId = COURT_ID_MAP[m.tournament?.courtId];
  if (fromId) return fromId;
  const name = (m.tournament?.court?.name || '').toLowerCase();
  if (name.includes('clay')) return 'Clay';
  if (name.includes('hard') || name.includes('indoor') || name.includes('carpet')) return 'Hard';
  if (name.includes('grass')) return 'Grass';
  return null;
}

function loadIndex(pid) {
  const fp = path.join(CACHE_DIR, `player-index-${pid}.json`);
  if (fs.existsSync(fp)) {
    try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch {}
  }
  return { Clay: [], Hard: [], Grass: [], updatedAt: 0 };
}

function saveIndex(pid, index) {
  fs.writeFileSync(path.join(CACHE_DIR, `player-index-${pid}.json`), JSON.stringify(index, null, 2));
}

function addEntry(index, surface, entry) {
  if (!index[surface]) index[surface] = [];
  if (index[surface].some(e => e.id === entry.id)) return;
  index[surface].push(entry);
  index[surface].sort((a, b) => b.date.localeCompare(a.date));
}

const files = fs.readdirSync(CACHE_DIR).filter(f => /^player-matches-\d+\.json$/.test(f));
console.log(`Migrating ${files.length} player files...`);

let migratedPlayers = 0;
const indexes = {};  // pid -> index (built in memory, written at end)

for (const file of files) {
  const pid = parseInt(file.replace('player-matches-', '').replace('.json', ''));
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf-8')); } catch { continue; }

  const matches = data.matches || [];
  if (!indexes[pid]) indexes[pid] = loadIndex(pid);
  const myIndex = indexes[pid];
  myIndex.updatedAt = data.cachedAt || Date.now();

  for (const m of matches) {
    const surface = getSurface(m);
    if (!surface) continue;
    const isP1 = m.player1Id === pid;
    const myName = isP1 ? m.player1?.name : m.player2?.name;
    const opponentId = isP1 ? m.player2Id : m.player1Id;
    const opponentName = isP1 ? m.player2?.name : m.player1?.name;

    if (myName && !myIndex.playerName) myIndex.playerName = myName;

    const entry = {
      id: String(m.id),
      date: (m.date || '').slice(0, 10),
      tournamentId: m.tournamentId,
      tournamentName: m.tournament?.name,
      opponentId,
      opponentName,
      won: m.match_winner === pid,
      result: m.result,
    };
    addEntry(myIndex, surface, entry);

    // Write mirror entry into opponent's index too
    if (opponentId) {
      if (!indexes[opponentId]) indexes[opponentId] = loadIndex(opponentId);
      const oppEntry = {
        ...entry,
        opponentId: pid,
        opponentName: myName,
        won: m.match_winner === opponentId,
      };
      if (opponentName && !indexes[opponentId].playerName) indexes[opponentId].playerName = opponentName;
      addEntry(indexes[opponentId], surface, oppEntry);
    }
  }
  migratedPlayers++;
  if (migratedPlayers % 50 === 0) console.log(`  ${migratedPlayers}/${files.length}...`);
}

// Write all indexes
let written = 0;
for (const [pid, index] of Object.entries(indexes)) {
  saveIndex(pid, index);
  written++;
}

console.log(`Done. Wrote ${written} player-index files.`);
console.log(`Clay matches per player (sample):`);
let sample = 0;
for (const [pid, index] of Object.entries(indexes)) {
  if (sample++ >= 5) break;
  console.log(`  Player ${pid}: Clay=${index.Clay?.length} Hard=${index.Hard?.length} Grass=${index.Grass?.length}`);
}
