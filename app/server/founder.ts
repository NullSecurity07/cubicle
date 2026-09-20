import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type Founder = ReturnType<typeof createFounder>;
export const PROFILE_CHARS = 1200;
export const FULL = 'The founder profile is full. Replace a line instead of adding one.';

// What everybody knows about the person they work for: how they like to be answered, what they care about, what they
// have said twice. It is small on purpose — a page nobody reads is not a profile — and the founder owns every line.
export function createFounder(dir: string) {
  const path = join(dir, 'founder.json');
  let queue: Promise<unknown> = Promise.resolve();

  async function read(): Promise<string> {
    await queue;
    try { return String(JSON.parse(await readFile(path, 'utf8')).text ?? ''); } catch { return ''; }
  }
  function save(text: string) {
    const job = queue.then(async () => {
      await mkdir(dir, { recursive: true });
      await writeFile(`${path}.tmp`, JSON.stringify({ text }, null, 2));
      await rename(`${path}.tmp`, path);
    });
    queue = job.catch(() => {});
    return job;
  }

  return {
    read,
    write: (text: string) => save(String(text ?? '').slice(0, PROFILE_CHARS).trimEnd()),
    // One line at a time, from whoever noticed. Past the cap it says so rather than pushing an older line out:
    // which line stops being true is not a machine's call.
    async note(fact: string, replace = ''): Promise<string> {
      const line = `- ${fact.replace(/\s+/g, ' ').trim()}`;
      const kept = (await read()).split('\n').filter((one) => one.trim());
      if (kept.includes(line)) return 'Already noted.';
      const at = replace.trim() ? kept.findIndex((one) => one.toLowerCase().includes(replace.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60))) : -1;
      if (replace.trim() && at < 0) throw new Error(`there is no line about "${replace.slice(0, 60)}" in the founder profile`);
      const next = at < 0 ? [...kept, line] : kept.map((one, index) => (index === at ? line : one));
      const text = next.join('\n');
      if (text.length > PROFILE_CHARS) throw new Error(FULL);
      await save(text);
      return at < 0 ? 'Noted about the founder.' : 'That line about the founder now says the new thing.';
    },
  };
}
