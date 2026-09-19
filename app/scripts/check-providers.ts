// Live check, needs real keys: every configured provider must accept the full tool list. Run with `pnpm check:providers` after adding or changing a tool.
import { resolve } from 'node:path';
try { process.loadEnvFile(resolve(import.meta.dirname, '../../.env')); } catch { /* no keys: nothing to check */ }
const { realClients } = await import('../server/providers.ts');
const { docTools } = await import('../server/tools/docs.ts');
const { fileTools } = await import('../server/tools/files.ts');
const { webTools } = await import('../server/tools/web.ts');
const { outwardTools } = await import('../server/tools/outward.ts');
const { projectTools } = await import('../server/tools/project.ts');
const { teamTools } = await import('../server/tools/team.ts');
const { taskTools } = await import('../server/tools/tasks.ts');
const tools = [...docTools, ...fileTools, ...webTools({} as any), ...outwardTools({ ready: () => true, ways: () => ({}) } as any, '/tmp'), ...projectTools((async () => ({})) as any, []), ...teamTools((async () => '') as any), ...taskTools({} as any)];
for (const client of realClients()) {
  try { const turn = await client.step([{ role: 'user', content: 'List the shared files with your tool.' }], { tools, onToken: () => {} }); console.log(client.name, 'OK with', tools.length, 'tools ->', turn.calls.map((c: any) => c.name).join(',') || 'text'); }
  catch (error: any) { console.log(client.name, 'ERROR', error.status, String(error.message).slice(0, 200)); }
}
