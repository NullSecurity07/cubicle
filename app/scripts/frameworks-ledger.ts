// Writes app/frameworks/shipped.json: the content hash of every version of every built-in team this repository has
// ever held, read from git history plus the working copy. Run it after changing a built-in team, so a workspace that
// copied the old version is known to be untouched and gets the new one on its next start.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { contentHash, LEDGER_FILE, type Ledger } from '../server/frameworks/shipped.ts';

const app = resolve(import.meta.dirname, '..');
const from = join(app, 'frameworks');
const git = (...args: string[]) => execFileSync('git', args, { cwd: app, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const was: Ledger = existsSync(join(from, LEDGER_FILE)) ? JSON.parse(readFileSync(join(from, LEDGER_FILE), 'utf8')) : {};
const ledger: Ledger = {};

for (const id of readdirSync(from, { withFileTypes: true }).filter((one) => one.isDirectory()).map((one) => one.name).sort()) {
  const file = `frameworks/${id}/framework.json`;
  if (!existsSync(join(app, file))) continue;
  const hashes = new Set<string>(was[id] ?? []);
  for (const commit of git('log', '--format=%H', '--', file).split('\n').filter(Boolean)) {
    try { hashes.add(contentHash(JSON.parse(git('show', `${commit}:app/${file}`)))); } catch { /* a version that was not JSON never shipped */ }
  }
  hashes.add(contentHash(JSON.parse(readFileSync(join(app, file), 'utf8'))));
  ledger[id] = [...hashes].sort();
}
writeFileSync(join(from, LEDGER_FILE), `${JSON.stringify(ledger, null, 2)}\n`);
console.log(`${LEDGER_FILE}: ${Object.values(ledger).reduce((sum, one) => sum + one.length, 0)} versions of ${Object.keys(ledger).length} teams`);
