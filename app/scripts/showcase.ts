// The showcase: Kindling, a made-up company a founder has run on this app for a week, opened in a fresh copy so it
// can be shown to people. The copy is made from app/showcase into a new folder under the system's temp folder (or
// the one named with --into), printed, and the app is started on it. The founder's own workspace, backups and running
// app are never touched: the copy has its own workspace, its own backup folder beside it (<copy>-backups) and its own ports.
//
//   pnpm showcase                    a fresh copy in the temp folder, and the app on http://localhost:7440
//   pnpm showcase --into <folder>    the copy goes there instead (the folder must be empty or not exist yet)
//   pnpm showcase --copy-only        make the copy and print where it is, without starting the app
//
// STAGE_PORT and STAGE_API_PORT move the ports (7440 and 7441 unless set), so it can run beside the founder's own.
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const SHOWCASE = resolve(import.meta.dirname, '..', 'showcase');

// A copy of the showcase workspace in `into`, or in a new folder under the temp folder. A folder with anything in
// it already is refused, so a mistyped --into can never mix Kindling into somebody's real work.
export async function copyShowcase(into?: string): Promise<string> {
  const folder = into ? resolve(into) : await mkdtemp(join(tmpdir(), 'kindling-showcase-'));
  await mkdir(folder, { recursive: true });
  if ((await readdir(folder)).length) throw new Error(`${folder} is not empty; name an empty or new folder`);
  await cp(SHOWCASE, folder, { recursive: true });
  return folder;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--into');
  const into = at >= 0 ? args[at + 1] : undefined;
  if (at >= 0 && !into) { console.error('Say which folder: pnpm showcase --into <folder>'); process.exit(1); }
  let folder: string;
  try { folder = await copyShowcase(into); } catch (error) { console.error(`The showcase was not copied: ${(error as Error).message}`); process.exit(1); }
  console.log(`Kindling's workspace is a fresh copy in ${folder}`);
  if (args.includes('--copy-only')) process.exit(0);
  const port = process.env.STAGE_PORT ?? '7440';
  const env = {
    ...process.env, STAGE_WORKSPACE: folder, STAGE_BACKUP_DIR: `${folder}-backups`,
    STAGE_PORT: port, STAGE_API_PORT: process.env.STAGE_API_PORT ?? String(Number(port) + 1),
  };
  console.log(`Showcase: http://localhost:${port}`);
  const app = spawn('node', ['scripts/dev.mjs'], { cwd: resolve(import.meta.dirname, '..'), stdio: 'inherit', env });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => app.kill(signal));
  app.on('exit', (status) => process.exit(status ?? 0));
}
