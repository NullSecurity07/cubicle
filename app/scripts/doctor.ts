// Is everything this app leans on really here? The same checks the Health screen shows, on the console.
// `pnpm health` answers without spending anything; `pnpm health --live` also says one word to each provider, which
// costs a token each and is the only way to find out that a key still works, and asks Reddit and one feed once each.
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
try { process.loadEnvFile(resolve(root, '.env')); } catch { /* no .env: the keys check will say so */ }

const { checkAll, liveChecks, liveReaders } = await import('../server/openends/health.ts');
const { backupDir, listBackups } = await import('../server/openends/backup.ts');
const { connectAll, loadEntries } = await import('../server/openends/mcp.ts');

const workspace = process.env.STAGE_WORKSPACE ?? resolve(root, 'workspace');
const dir = backupDir(process.env);
const { entries, problem } = await loadEntries(workspace);
const connections = entries.length ? await connectAll(entries) : [];
const outside = [
  ...(problem ? [{ name: 'mcp.json', ok: false, detail: problem }] : []),
  ...connections.map((one) => ({ name: one.entry.name, ok: one.ok, detail: one.detail })),
];

const checks = await checkAll({ workspace, root, backupDir: dir, backups: () => listBackups(dir), outside: () => outside });
if (process.argv.includes('--live')) {
  const { realClients } = await import('../server/providers.ts');
  checks.push(...await liveChecks(realClients()));
  checks.push(...await liveReaders());
}
for (const one of connections) await one.rpc?.close().catch(() => {});

// Twenty is the founder's own, and optional: not configured is fine, configured and silent is not.
const twentyUrl = process.env.TWENTY_URL?.trim().replace(/\/+$/, '');
if (!twentyUrl || !process.env.TWENTY_API_KEY?.trim()) checks.push({ name: 'Twenty', ok: true, detail: 'not configured (optional: TWENTY_URL and TWENTY_API_KEY connect your own Twenty)' });
else {
  const answer = await fetch(`${twentyUrl}/healthz`, { signal: AbortSignal.timeout(5000) }).then((one) => one.ok, () => false);
  checks.push({ name: 'Twenty', ok: answer, detail: answer ? `reachable at ${twentyUrl}; leads are mirrored there` : `not reachable at ${twentyUrl}`, fix: 'Start it with docker compose up -d in its folder. The Leads card works without it.' });
}

const width = Math.max(...checks.map((one) => one.name.length));
for (const check of checks) {
  console.log(`${check.ok ? '✓' : '✗'} ${check.name.padEnd(width)}  ${check.detail}`);
  if (!check.ok && check.fix) console.log(`${' '.repeat(width + 4)}${check.fix}`);
}
const bad = checks.filter((one) => !one.ok).length;
console.log(bad ? `\n${bad} of ${checks.length} need something from you.` : `\nAll ${checks.length} are fine.`);
process.exit(bad ? 1 : 0);
