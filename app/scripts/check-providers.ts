// Live check, needs real keys: every configured provider must accept the full tool list. Run with `pnpm check:providers` after adding or changing a tool.
// One line for every provider in models.json: OK, NO KEY with the name to set, or what the provider said.
import { resolve } from 'node:path';
try { process.loadEnvFile(resolve(import.meta.dirname, '../../.env')); } catch { /* no keys: nothing to check */ }
const { ENTRIES, holdsTools, providerOf, realClients, toolSize, unset } = await import('../server/providers.ts');
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
const { sourceTools } = await import('../server/tools/sources.ts');
const { calcTools } = await import('../server/tools/calc.ts');
// Whatever `server/slices` holds counts too: a dropped-in feature must not be the thing that makes a provider refuse
// the list. A slice only installs when it is handed the real things it listens to, so it gets them, small and empty, on
// a throwaway workspace; stubs that were too thin left slices out, and the check passed without ever offering their
// tools. The stubs are the same ones the unit test that installs the whole folder uses (`server/slice-stubs.ts`), so
// the two cannot drift apart. `fake` keeps every slice away from the outside world. One that still cannot install
// fails the check.
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { installSlices, loadSlices } = await import('../server/install.ts');
const { stubDeps } = await import('../server/slice-stubs.ts');
const scratch = mkdtempSync(resolve(tmpdir(), 'check-providers-'));
const skipped: string[] = [];
const said = (name: string, error: Error) => { skipped.push(name); console.log('slice', name, 'COULD NOT INSTALL:', error.message); };
const extras = await installSlices(await loadSlices(resolve(import.meta.dirname, '../server/slices'), said), stubDeps(scratch, resolve(import.meta.dirname, '../..')), said);
const tools = [...docTools, ...fileTools, ...webTools({} as any), ...outwardTools({ ready: () => true, ways: () => ({}) } as any, '/tmp'), ...teamTools((async () => '') as any), ...taskTools({} as any), ...memoryTools({} as any), ...decisionTools({} as any), ...sourceTools({} as any, {} as any), ...recallTools({} as any), ...mediaTools({ ready: () => null } as any), ...skillTools({} as any), ...founderTools({} as any), ...calcTools(), ...extras.tools];
const refused: string[] = [];
const clients = realClients();
for (const entry of ENTRIES) {
  // Its clients: one per key, and a spare key (`_2`) with no first one still counts.
  const mine = clients.filter((one) => providerOf(one.name) === entry.name);
  if (!mine.length) { console.log(entry.name, `NO KEY (set ${unset(entry, process.env).join(' and ')} in .env)`); continue; }
  // A client without tools (the small side model) is only ever asked without them, so it is checked the same way.
  for (const client of mine) {
    // Judged the way the app uses it: a model whose room cannot hold the tool list (Groq's per-minute wall) is never
    // sent a tool turn there, so sending it one here only proves a 413. It is asked without tools, as the app asks it.
    const ask = [{ role: 'user' as const, content: 'List the shared files with your tool.' }];
    const withTools = client.tools && holdsTools(client, tools, ask);
    const offered = withTools ? tools : [];
    const passed = client.tools && !withTools ? `passed over on tool turns (room ${client.maxPromptChars} < ${toolSize(tools)}-character tool list), ` : '';
    // Asked about a tool it was not offered, a small model tries to call one anyway; it is asked for words instead.
    const content = withTools ? ask[0].content : 'Say in five words what a summary is for.';
    try { const turn = await client.step([{ role: 'user', content }], { tools: offered, onToken: () => {} }); console.log(client.name, 'OK', withTools ? `with ${tools.length} tools ->` : `${passed || 'side model, '}without tools ->`, turn.calls.map((c: any) => c.name).join(',') || 'text'); }
    catch (error: any) { refused.push(client.name); console.log(client.name, 'ERROR', error.status ?? '', String(error.message).slice(0, 200)); }
  }
}
// A check that cannot fail is not one: a slice left out or a keyed provider that refused the list ends this with a red
// exit. A provider with no key is only said, not failed: most founders will never set all of them.
await extras.close().catch(() => {});
process.exit(skipped.length || refused.length ? 1 : 0);
