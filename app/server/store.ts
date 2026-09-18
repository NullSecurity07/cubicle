import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { seedDocs, seedStage, type ChatMessage, type Stage } from '../shared/model.ts';

export type Store = ReturnType<typeof createStore>;

const safe = (id: string) => {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error(`bad id: ${id}`);
  return id;
};

export function createStore(dir: string) {
  const stagePath = join(dir, 'stage.json');
  const docPath = (id: string) => join(dir, 'docs', `${safe(id)}.md`);
  const chatPath = (id: string) => join(dir, 'rooms', `${safe(id)}.json`);
  let queue: Promise<unknown> = Promise.resolve();

  // Writes go through one queue and land by rename, so a crash never leaves half a file.
  const write = (path: string, text: string) => {
    const job = queue.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(`${path}.tmp`, text);
      await rename(`${path}.tmp`, path);
    });
    queue = job.catch(() => {});
    return job;
  };
  const read = async (path: string) => {
    await queue;
    try { return await readFile(path, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };

  async function loadStage(): Promise<Stage> {
    const text = await read(stagePath);
    if (text !== null) return JSON.parse(text) as Stage;
    await write(stagePath, JSON.stringify(seedStage, null, 2));
    for (const [id, body] of Object.entries(seedDocs)) await write(docPath(id), body);
    return structuredClone(seedStage);
  }

  return {
    loadStage,
    saveStage: (stage: Stage) => write(stagePath, JSON.stringify(stage, null, 2)),
    readDoc: async (id: string) => (await read(docPath(id))) ?? '',
    writeDoc: (id: string, text: string) => write(docPath(id), text),
    readChat: async (id: string): Promise<ChatMessage[]> => JSON.parse((await read(chatPath(id))) ?? '[]'),
    async appendChat(id: string, message: ChatMessage) {
      const path = chatPath(id);
      const messages: ChatMessage[] = JSON.parse((await read(path)) ?? '[]');
      messages.push(message);
      await write(path, JSON.stringify(messages, null, 2));
    },
  };
}
