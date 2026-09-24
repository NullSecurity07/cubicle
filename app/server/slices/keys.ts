import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkOverrides, type Checked } from '../../src/keys.ts';
import type { Slice } from '../install.ts';

// The founder's own keys: `<workspace>/keys.json`, like { "command-bar": ["Mod+K"] }. Read at start and again each
// time the page asks, so a change shows on the next reload. A key that is not a key, or one another shortcut already
// uses, keeps its default and is named on the console in one sentence. No file is no change.

export async function readKeys(file: string): Promise<Checked> {
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch { return { keys: {}, problems: [] }; }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { keys: {}, problems: [`keys.json is not valid JSON, so every key keeps its default.`] }; }
  return checkOverrides(raw);
}

export default {
  name: 'keys',
  async install(deps) {
    const file = join(deps.workspace, 'keys.json');
    let said = '';
    const read = async () => {
      const checked = await readKeys(file);
      // Said once per change, not on every reload of the page.
      const now = checked.problems.join('\n');
      if (now && now !== said) for (const problem of checked.problems) console.log(`Keys: ${problem}`);
      said = now;
      return checked;
    };
    await read();
    return {
      async route(req, res, path) {
        if (path !== '/api/keys' || (req.method ?? 'GET') !== 'GET') return false;
        deps.json(res, 200, { ...(await read()), file });
        return true;
      },
    };
  },
} satisfies Slice;
