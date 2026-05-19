#!/usr/bin/env node
/**
 * Migration: converts player-matches-{id}.json files to
 * player-index-{id}.json (last 10 per surface) + player-history-{id}.json (older matches).
 * No API calls.
 */

const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', 'cache');
const COURT_ID_MAP = { 1: 'Hard', 2: 'Clay', 3: 'Hard', 5: 'Grass' };
const INDEX_LIMIT = 10;

function getSurface(m) {
  const fromId = COURT_ID_MAP[m.tournament?.courtId];
  if (fromId) return fromId;
  const name = (m.tournament?.court?.name || '').toLowerCase();
  if (name.includes('clay')) return 'Clay';
  if (name.includes('hard') || name.includes('indoor') || name.includes('carpet')) return 'Hard';
  if (name.includes('grass')) return 'Grass';
  return null;
}

const indexes = {};   // pid -> { playerName, Clay, Hard, Grass, updatedAt }
const histories = {}; // pid -> { Clay, Hard, Grass }

function getIndex(pid) {
  const key = String(pid);
  if (!indexes[key]) indexes[key] = { Clay: [], Hard: [], Grass: [], updatedAt: 0 };
  return indexes[key];
}

function getHistory(pid) {
  const key = String(pid);
  if (!histories[key]) histories[key] = { Clay: [], Hard: [], Grass: [] };
  return histories[key];
}

function addEntry(pid, surface, entry) {
  const idx = getIndex(pid);
  if (!idx[surface]) idx[surface] = [];
  if (idx[surface].some(e => e.id === entry.id)) return;

  idx[surface].push(entry);
  idx[surface].sort((a, b) => b.date.localeCompare(a.date));

  // Trim to INDEX_LIMIT — overflow goes to history
  if (idx[surface].length > INDEX_LIMIT) {
    const displaced = idx[surface].splice(INDEX_LIMIT);
    const hist = getHistory(pid);
    if (!hist[surface]) hist[surface] = [];
    const histIds = new Set(hist[surface].map(e => e.id));
    for (const e of displaced) {
      if (!histIds.has(e.id)) { hist[surface].push(e); histIds.add(e.id); }
    }
  }
}

const files = fs.readdirSync(CACHE_DIR).filter(f => /^player-matches-\d+\.json$/.test(f));
console.log(`Migrating ${files.length} player files...`);

let migratedPlayers = 0;

for (const file of files) {
  const pid = parseInt(file.replace('player-matches-', '').replace('.json', ''));
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf-8')); } catch { continue; }

  const matches = data.matches || [];
  const myIdx = getIndex(pid);
  myIdx.updatedAt = data.cachedAt || Date.now();

  for (const m of matches) {
    const surface = getSurface(m);
    if (!surface) continue;
    const isP1 = m.player1Id === pid;
    const myName = isP1 ? m.player1?.name : m.player2?.name;
    const opponentId = isP1 ? m.player2Id : m.player1Id;
    const opponentName = isP1 ? m.player2?.name : m.player1?.name;

    if (myName && !myIdx.playerName) myIdx.playerName = myName;

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
    addEntry(pid, surface, entry);

    if (opponentId) {
      const oppIdx = getIndex(opponentId);
      if (opponentName && !oppIdx.playerName) oppIdx.playerName = opponentName;
      const oppEntry = { ...entry, opponentId: pid, opponentName: myName, won: m.match_winner === opponentId };
      addEntry(opponentId, surface, oppEntry);
    }
  }
  migratedPlayers++;
  if (migratedPlayers % 50 === 0) console.log(`  ${migratedPlayers}/${files.length}...`);
}

// Write indexes and histories
let idxWritten = 0, histWritten = 0;
for (const [pid, index] of Object.entries(indexes)) {
  fs.writeFileSync(path.join(CACHE_DIR, `player-index-${pid}.json`), JSON.stringify(index, null, 2));
  idxWritten++;
}
for (const [pid, hist] of Object.entries(histories)) {
  // Sort each surface descending before saving
  for (const s of ['Clay', 'Hard', 'Grass']) {
    if (hist[s]) hist[s].sort((a, b) => b.date.localeCompare(a.date));
  }
  fs.writeFileSync(path.join(CACHE_DIR, `player-history-${pid}.json`), JSON.stringify(hist, null, 2));
  histWritten++;
}

console.log(`Done. Wrote ${idxWritten} index files, ${histWritten} history files.`);
console.log(`Sample (index capped at ${INDEX_LIMIT} per surface):`);
let sample = 0;
for (const [pid, index] of Object.entries(indexes)) {
  if (sample++ >= 5) break;
  const hist = histories[String(pid)];
  console.log(`  Player ${pid}: index Clay=${index.Clay?.length} Hard=${index.Hard?.length} Grass=${index.Grass?.length} | history Clay=${hist?.Clay?.length ?? 0} Hard=${hist?.Hard?.length ?? 0}`);
}
