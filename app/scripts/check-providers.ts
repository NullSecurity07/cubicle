// Live check, needs real keys: every configured provider must accept the full tool list. Run with `pnpm check:providers` after adding or changing a tool.
// One line for every provider in models.json: OK, NO KEY with the name to set, or what the provider said.
import { resolve } from 'node:path';
try { process.loadEnvFile(resolve(import.meta.dirname, '../../.env')); } catch { /* no keys: nothing to check */ }
const { ENTRIES, providerOf, realClients, unset } = await import('../server/providers.ts');
const { docTools } = await import('../server/tools/docs.ts');
const { fileTools } = await import('../server/tools/files.ts');
const { webTools } = await import('../server/tools/web.ts');
const { outwardTools } = await import('../server/tools/outward.ts');
const { teamTools } = await import('../server/tools/team.ts');
const { taskTools } = await import('../server/tools/tasks.ts');
const { memoryTools } = await import('../server/tools/remember.ts');
const { decisionTools } = await import('../server/tools/decisions.ts');
const { recallTools } = await import('../server/tools/recall.ts');
const { mediaTools } = await import('../server/tools/media.ts');
const { skillTools } = await import('../server/tools/skills.ts');
const { founderTools } = await import('../server/tools/founder.ts');
// Whatever `server/slices` holds counts too: a dropped-in feature must not be the thing that makes a provider refuse
// the list. A slice only installs when it is handed the real things it listens to, so it gets them, small and empty, on
// a throwaway workspace; stubs that were too thin left four slices out, and the check passed without ever offering
// their tools. `fake` keeps every slice away from the outside world. One that still cannot install fails the check.
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { installSlices, loadSlices, lateRuns } = await import('../server/install.ts');
const scratch = mkdtempSync(resolve(tmpdir(), 'check-providers-'));
const { createStore } = await import('../server/store.ts');
const { createSeams } = await import('../server/seams.ts');
const { createAttention } = await import('../server/attention.ts');
const { createBoards } = await import('../server/boards.ts');
const { createSkills } = await import('../server/skills.ts');
const { createFounder } = await import('../server/founder.ts');
const { createApprovals } = await import('../server/approvals.ts');
const { createUsage } = await import('../server/usage.ts');
const { createDecisions } = await import('../server/decisions.ts');
const skipped: string[] = [];
const said = (name: string, error: Error) => { skipped.push(name); console.log('slice', name, 'COULD NOT INSTALL:', error.message); };
const extras = await installSlices(await loadSlices(resolve(import.meta.dirname, '../server/slices'), said), {
  workspace: scratch, root: resolve(import.meta.dirname, '../..'), fake: true, store: createStore(scratch), seams: createSeams(), clients: [], usage: createUsage(null),
  approvals: createApprovals(), attention: createAttention(scratch), boards: createBoards(scratch), skills: createSkills(scratch), founder: createFounder(scratch), decisions: createDecisions(scratch),
  busy: new Set(), notify: () => {}, promptFor: async () => [], json: () => {}, body: async () => ({}), own: { ports: [], token: '' }, runs: lateRuns().runs, toolsFor: () => [],
} as any, said);
const tools = [...docTools, ...fileTools, ...webTools({} as any), ...outwardTools({ ready: () => true, ways: () => ({}) } as any, '/tmp'), ...teamTools((async () => '') as any), ...taskTools({} as any), ...memoryTools({} as any), ...decisionTools({} as any), ...recallTools({} as any), ...mediaTools({ ready: () => null } as any), ...skillTools({} as any), ...founderTools({} as any), ...extras.tools];
const refused: string[] = [];
const clients = realClients();
for (const entry of ENTRIES) {
  // Its clients: one per key, and a spare key (`_2`) with no first one still counts.
  const mine = clients.filter((one) => providerOf(one.name) === entry.name);
  if (!mine.length) { console.log(entry.name, `NO KEY (set ${unset(entry, process.env).join(' and ')} in .env)`); continue; }
  // A client without tools (the small side model) is only ever asked without them, so it is checked the same way.
  for (const client of mine) {
    const offered = client.tools ? tools : [];
    // Asked about a tool it was not offered, a small model tries to call one anyway; it is asked for words instead.
    const content = client.tools ? 'List the shared files with your tool.' : 'Say in five words what a summary is for.';
    try { const turn = await client.step([{ role: 'user', content }], { tools: offered, onToken: () => {} }); console.log(client.name, 'OK', client.tools ? `with ${tools.length} tools ->` : 'without tools (side model) ->', turn.calls.map((c: any) => c.name).join(',') || 'text'); }
    catch (error: any) { refused.push(client.name); console.log(client.name, 'ERROR', error.status ?? '', String(error.message).slice(0, 200)); }
  }
}
// A check that cannot fail is not one: a slice left out or a keyed provider that refused the list ends this with a red
// exit. A provider with no key is only said, not failed: most founders will never set all of them.
await extras.close().catch(() => {});
process.exit(skipped.length || refused.length ? 1 : 0);
