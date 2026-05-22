#!/usr/bin/env node
/**
 * Daily update: refresh player indexes, prebuild match stats, commit and push.
 * Usage: node scripts/daily-update.js
 *        npm run update
 */

const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function run(cmd, label) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`▶ ${label}`);
  console.log(`${'─'.repeat(60)}`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
}

function runSafe(cmd, label) {
  try { run(cmd, label); } catch {}
}

const started = Date.now();

run('node scripts/prefetch-fixtures.js 3', 'Prefetching fixtures (today + 3 days)');
run('node scripts/prebuild-cache.js today', 'Refreshing player indexes (cache:today)');
run('node scripts/prebuild-match-stats.js upcoming --clay-only', 'Prebuilding match stats (stats:upcoming)');

// Stage updated cache files
runSafe('git add -u cache/', 'Staging updated cache files');

// Check if there's anything to commit
const status = execSync('git status --porcelain cache/', { cwd: ROOT }).toString().trim();
if (!status) {
  console.log('\n✓ Nothing new to commit — cache already up to date.');
} else {
  const today = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().split('T')[0];
  run(`git commit -m "Daily cache update ${today}"`, 'Committing cache files');
  run('git push', 'Pushing to Vercel');
  const elapsed = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`\n✓ Done in ${elapsed}s — Vercel deploy triggered.`);
}
