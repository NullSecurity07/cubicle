/**
 * Writes the office map and the desk table from scripts/world/campus.ts:
 *   config/world/office.json           — checked-in source of truth
 *   packages/viewer/public/office.json — the copy the viewer serves at /office.json
 *   config/world/desks.yaml            — the daemon's desk table (hire assigns desks from it)
 * They must not drift; packages/core/test/world-drift.test.ts rebuilds the campus and compares all three.
 * Usage: pnpm --filter @cubicle/viewer world:gen   (or: node --import tsx/esm scripts/gen-world.ts [--out <dir>])
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCampus, desksYaml, W, H } from './world/campus.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { map, desks } = buildCampus();
const json = JSON.stringify(map);
const yaml = desksYaml(desks);

const flag = process.argv.indexOf('--out');
const outRoot = flag > -1 && process.argv[flag + 1] ? path.resolve(process.argv[flag + 1]) : root;
const outputs: [string, string][] = [
  [path.join(outRoot, 'config/world/office.json'), json],
  [path.join(outRoot, 'packages/viewer/public/office.json'), json],
  [path.join(outRoot, 'config/world/desks.yaml'), yaml],
];
for (const [out, text] of outputs) { mkdirSync(path.dirname(out), { recursive: true }); writeFileSync(out, text); }
const objects = map.layers.filter((l) => l.type === 'objectgroup').reduce((n, l) => n + (l.objects?.length ?? 0), 0);
console.log(`wrote ${outputs.map(([p]) => path.relative(outRoot, p)).join(', ')}: ${W}×${H} cells, ${objects} objects, ${desks.length} desks`);
