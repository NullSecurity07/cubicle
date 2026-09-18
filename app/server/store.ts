import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
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
    // Cards that left the stage keep their files, in trash: the founder's words are never deleted.
    async saveStage(stage: Stage) {
      for (const card of [...stage.rooms, ...stage.docs]) safe(card.id);
      const before = await loadStage();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const gone = (was: { id: string }[], now: { id: string }[]) => was.filter((card) => !now.some((kept) => kept.id === card.id));
      const moves = [
        ...gone(before.rooms, stage.rooms).map((room) => chatPath(room.id)),
        ...gone(before.docs, stage.docs).map((doc) => docPath(doc.id)),
      ];
      await write(stagePath, JSON.stringify(stage, null, 2));
      await queue;
      await mkdir(join(dir, 'trash'), { recursive: true });
      for (const path of moves) {
        await rename(path, join(dir, 'trash', `${stamp}-${basename(path)}`)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    },
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
