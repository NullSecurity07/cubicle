import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

// A project is a real folder the founder named: absolute, existing, and never the home folder, the root or this app's data.
export function projectDir(path: string, forbidden: string[] = []): string {
  const raw = path.trim().replace(/^~(?=\/|$)/, homedir());
  if (!raw || !isAbsolute(raw)) throw new Error('the project card needs a full folder path, for example /home/you/code/my-app');
  const dir = resolve(raw);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`there is no folder at ${dir}`);
  if (dir === '/' || dir === resolve(homedir()) || forbidden.some((one) => dir === resolve(one) || resolve(one).startsWith(`${dir}/`))) throw new Error(`${dir} is too broad to hand to a coding agent; pick the project's own folder`);
  return dir;
}
