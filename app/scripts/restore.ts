// Put a backup back, into a new folder. The workspace you are using is never written to: what comes out of the
// archive lands somewhere fresh, you look at it, and you move it into place yourself.
// Usage: pnpm restore                       the newest backup, into a new folder beside the others
//        pnpm restore <archive> [<folder>]
import { resolve } from 'node:path';
import { backupDirOf, listBackups, restore } from '../server/openends/backup.ts';

const [asked, into] = process.argv.slice(2).filter((one) => !one.startsWith('-'));
// The same folder the app backs up to for this workspace.
const root = resolve(import.meta.dirname, '../..');
const dir = backupDirOf({ fake: process.env.STAGE_FAKE_MODEL === '1', workspace: process.env.STAGE_WORKSPACE ?? resolve(root, 'workspace'), root });
const held = await listBackups(dir);
const archive = asked ? resolve(asked) : held[0] ? resolve(dir, held[0].file) : '';
if (!archive) {
  console.log(`There is nothing to put back: no backup was found in ${dir}.`);
  process.exit(1);
}
const folder = resolve(into ?? `${archive.replace(/\.tar\.gz$/, '')}-restored`);
try {
  const done = await restore(archive, folder);
  console.log(`Put back ${done.files} ${done.files === 1 ? 'file' : 'files'} from ${archive}`);
  console.log(`into ${done.into}`);
  console.log('Nothing you are working on was touched. Look at it, and move it into place when you are happy.');
} catch (error) {
  console.log(`Nothing was put back: ${(error as Error).message}`);
  process.exit(1);
}
