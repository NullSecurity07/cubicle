import { copyFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { newMessageId, seedDocs, seedStage, type ChatMessage, type Stage } from '../shared/model.ts';

export type Store = ReturnType<typeof createStore>;

const safe = (id: string) => {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error(`bad id: ${id}`);
  return id;
};

export function createStore(dir: string) {
  const stagePath = join(dir, 'stage.json');
  const docPath = (id: string) => join(dir, 'docs', `${safe(id)}.md`);
  const chatPath = (id: string) => join(dir, 'rooms', `${safe(id)}.json`);
  const filesDir = resolve(dir, 'files');
  let queue: Promise<unknown> = Promise.resolve();
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

  // People name shared files themselves, so the path is checked hard: plain segments, no dot files, never outside the folder.
  const filePath = (name: string) => {
    const parts = name.split('/');
    if (!parts.length || parts.length > 6 || parts.some((part) => !/^[A-Za-z0-9_][A-Za-z0-9._ -]{0,79}$/.test(part))) throw new Error(`bad file path: ${name}`);
    const full = resolve(filesDir, ...parts);
    if (!full.startsWith(filesDir + sep)) throw new Error(`bad file path: ${name}`);
    return full;
  };

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
  // Before a person overwrites something, the old version goes to trash. Queued, so it copies what is really there.
  const keep = (path: string) => {
    const job = queue.then(async () => {
      await mkdir(join(dir, 'trash'), { recursive: true });
      await copyFile(path, join(dir, 'trash', `${stamp()}-${basename(path)}`)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
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
      for (const card of [...stage.rooms, ...stage.docs, ...(stage.cards ?? [])]) safe(card.id);
      const before = await loadStage();
      const gone = (was: { id: string }[], now: { id: string }[]) => was.filter((card) => !now.some((kept) => kept.id === card.id));
      const moves = [
        ...gone(before.rooms, stage.rooms).map((room) => chatPath(room.id)),
        ...gone(before.docs, stage.docs).map((doc) => docPath(doc.id)),
      ];
      await write(stagePath, JSON.stringify(stage, null, 2));
      await queue;
      await mkdir(join(dir, 'trash'), { recursive: true });
      for (const path of moves) {
        await rename(path, join(dir, 'trash', `${stamp()}-${basename(path)}`)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    },
    readDoc: async (id: string) => (await read(docPath(id))) ?? '',
    writeDoc: (id: string, text: string) => write(docPath(id), text),
    async replaceDoc(id: string, text: string) {
      await keep(docPath(id));
      await write(docPath(id), text);
    },
    // Conversations saved before messages had ids get them once, here.
    async readChat(id: string): Promise<ChatMessage[]> {
      const messages: ChatMessage[] = JSON.parse((await read(chatPath(id))) ?? '[]');
      if (messages.every((message) => message.id)) return messages;
      const named = messages.map((message) => (message.id ? message : { ...message, id: newMessageId() }));
      await write(chatPath(id), JSON.stringify(named, null, 2));
      return named;
    },
    async appendChat(id: string, message: ChatMessage) {
      const path = chatPath(id);
      const messages: ChatMessage[] = JSON.parse((await read(path)) ?? '[]');
      messages.push(message);
      await write(path, JSON.stringify(messages, null, 2));
    },
    async listFiles(): Promise<string[]> {
      await queue;
      const entries = await readdir(filesDir, { recursive: true, withFileTypes: true }).catch(() => []);
      return entries.filter((entry) => entry.isFile() && !entry.name.endsWith('.tmp'))
        .map((entry) => relative(filesDir, join(entry.parentPath, entry.name)).split(sep).join('/')).sort();
    },
    readFile: (name: string) => read(filePath(name)),
    async writeFile(name: string, text: string) {
      await keep(filePath(name));
      await write(filePath(name), text);
    },
  };
}
