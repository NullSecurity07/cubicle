import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { newMessageId, seedDocs, seedStage, type ChatMessage, type Stage } from '../shared/model.ts';
import { trashStamp } from './clock.ts';
import { safeId, writeAtomic } from './fsx.ts';
import type { Memory } from './memory.ts';

export type Store = ReturnType<typeof createStore>;

// Where an upload goes: under files/uploads, with a name that cannot clash or escape.
// Every id on a stage: its people, its docs, its cards and its wires.
const idsOf = (stage: Stage) => [...stage.rooms, ...stage.docs, ...(stage.cards ?? []), ...stage.wires].map((one) => one.id);

const uploadPath = (name: string) => `uploads/${Date.now().toString(36)}-${name.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(-60) || 'file'}`;

const safe = (id: string) => safeId(id, 64);

// `onChat` is told whenever a conversation changed, whoever changed it. It lives here rather than at each of the
// half-dozen callers so that a writer added later cannot forget it: there is nowhere else a message can be written.
export function createStore(dir: string, onChat: (roomId: string) => void = () => {}) {
  const stagePath = join(dir, 'stage.json');
  const docPath = (id: string) => join(dir, 'docs', `${safe(id)}.md`);
  const chatPath = (id: string) => join(dir, 'rooms', `${safe(id)}.json`);
  const memoryPath = (id: string) => join(dir, 'rooms', `${safe(id)}.memory.json`);
  const pagePath = (id: string) => join(dir, 'links', `${safe(id)}.json`);
  const filesDir = resolve(dir, 'files');
  let queue: Promise<unknown> = Promise.resolve();

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
      await writeAtomic(path, text, { mkdir: true });
    });
    queue = job.catch(() => {});
    return job;
  };
  // Before a person overwrites something, the old version goes to trash. Queued, so it copies what is really there.
  const keep = (path: string) => {
    const job = queue.then(async () => {
      await mkdir(join(dir, 'trash'), { recursive: true });
      await copyFile(path, join(dir, 'trash', `${trashStamp()}-${basename(path)}`)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    });
    queue = job.catch(() => {});
    return job;
  };
  // When a file was last written. Nothing here keeps a date of its own, so for a doc, a shared file or a fetched page
  // this is the only honest answer to "how old is this?", which is what recall has to say about what it finds.
  const timeOf = (path: string) => stat(path).then((info) => info.mtimeMs, () => undefined);
  const read = async (path: string) => {
    await queue;
    try { return await readFile(path, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };

  // One line for every change to the stage; see `saveStage` below.
  let stageLine: Promise<unknown> = Promise.resolve();
  const staged = <T>(job: () => Promise<T>): Promise<T> => {
    const run = stageLine.then(job);
    stageLine = run.catch(() => {});
    return run;
  };
  // What a change made here put on the stage that no window has sent back yet, by id.
  const unseen = new Set<string>();
  const keepUnseen = (current: Stage, sent: Stage): Stage => {
    const sentIds = new Set(idsOf(sent));
    const next: Stage = { ...sent, rooms: [...sent.rooms], docs: [...sent.docs], wires: [...sent.wires], ...(sent.cards || current.cards?.length ? { cards: [...(sent.cards ?? [])] } : {}) };
    for (const id of [...unseen]) {
      // The window has it now: from here on it is the window's to keep or take away.
      if (sentIds.has(id)) { unseen.delete(id); continue; }
      const room = current.rooms.find((one) => one.id === id);
      const doc = current.docs.find((one) => one.id === id);
      const card = current.cards?.find((one) => one.id === id);
      if (room) next.rooms.push(room); else if (doc) next.docs.push(doc); else if (card) next.cards!.push(card);
      else if (!current.wires.some((one) => one.id === id)) unseen.delete(id);
    }
    // A wire is kept only while both of its ends are.
    const ends = new Set(idsOf({ ...next, wires: [] }));
    for (const wire of current.wires) {
      if (unseen.has(wire.id) && !sentIds.has(wire.id) && ends.has(wire.from) && ends.has(wire.to)) next.wires.push(wire);
    }
    return next;
  };

  async function loadStage(): Promise<Stage> {
    const text = await read(stagePath);
    if (text !== null) return JSON.parse(text) as Stage;
    await write(stagePath, JSON.stringify(seedStage, null, 2));
    for (const [id, body] of Object.entries(seedDocs)) await write(docPath(id), body);
    return structuredClone(seedStage);
  }

  async function saveNow(stage: Stage) {
    for (const card of [...stage.rooms, ...stage.docs, ...(stage.cards ?? [])]) safe(card.id);
    const before = await loadStage();
    const gone = (was: { id: string }[], now: { id: string }[]) => was.filter((card) => !now.some((kept) => kept.id === card.id));
    const moves = [
      ...gone(before.rooms, stage.rooms).flatMap((room) => [chatPath(room.id), memoryPath(room.id)]),
      ...gone(before.docs, stage.docs).map((doc) => docPath(doc.id)),
      ...gone(before.cards ?? [], stage.cards ?? []).flatMap((card) => [join(dir, 'browsers', card.id), join(dir, 'media', `${card.id}.json`)]),
    ];
    await write(stagePath, JSON.stringify(stage, null, 2));
    await queue;
    await mkdir(join(dir, 'trash'), { recursive: true });
    for (const path of moves) {
      await rename(path, join(dir, 'trash', `${trashStamp()}-${basename(path)}`)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  return {
    filesDir,
    // Each browser card keeps its own Chrome profile here, so accounts made for a person's use stay signed in.
    browserProfile: (id: string) => join(dir, 'browsers', safe(id)),
    loadStage,
    // Cards that left the stage keep their files, in trash: the founder's words are never deleted.
    // Every change to the stage waits its turn behind the others, so two changes never read the same stage and the
    // second never writes over the first. Do not call these from inside a `patchStage` edit: it would wait for itself.
    saveStage: (stage: Stage) => staged(() => saveNow(stage)),
    // A change made here rather than in a window: read the stage, change it, save it, in turn. What it puts on the
    // stage is kept there until a window sends it back, because a window saves its whole stage as it last saw it,
    // and one that has not heard of the change yet would otherwise take it away again (and a doc with it, to trash).
    patchStage: (edit: (stage: Stage) => Stage | void | Promise<Stage | void>) => staged(async () => {
      const before = await loadStage();
      const draft = structuredClone(before);
      const after = (await edit(draft)) ?? draft;
      // Nothing changed is nothing written.
      if (JSON.stringify(after) === JSON.stringify(before)) return after;
      const had = new Set(idsOf(before));
      for (const id of idsOf(after)) if (!had.has(id)) unseen.add(id);
      await saveNow(after);
      return after;
    }),
    // The stage as a window last saw it, saved whole: what it left out on purpose goes, but whatever a change made
    // here put on the stage and the window has not sent back yet stays. Hands back the stage before and as saved.
    putStage: (sent: Stage) => staged(async () => {
      const before = await loadStage();
      const next = keepUnseen(before, sent);
      await saveNow(next);
      return { before, next };
    }),
    readDoc: async (id: string) => (await read(docPath(id))) ?? '',
    docTime: async (id: string) => timeOf(docPath(id)),
    fileTime: async (name: string) => timeOf(filePath(name)),
    pageTime: async (id: string) => timeOf(pagePath(id)),
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
      onChat(id);
    },
    readPage: async (id: string): Promise<{ url: string; title: string; text: string } | null> => JSON.parse((await read(pagePath(id))) ?? 'null'),
    writePage: (id: string, page: { url: string; title: string; text: string }) => write(pagePath(id), JSON.stringify(page, null, 2)),
    async readMemory(id: string): Promise<Memory> {
      const saved = JSON.parse((await read(memoryPath(id))) ?? '{}') as Partial<Memory>;
      return { notes: saved.notes ?? '', summary: saved.summary ?? '', upTo: saved.upTo };
    },
    writeMemory: (id: string, memory: Memory) => write(memoryPath(id), JSON.stringify(memory, null, 2)),
    // Takes messages out of a conversation (one, or one and everything after it). What is taken out goes to trash.
    async cutChat(id: string, messageId: string, andAfter: boolean): Promise<ChatMessage[]> {
      const messages: ChatMessage[] = JSON.parse((await read(chatPath(id))) ?? '[]');
      const at = messages.findIndex((message) => message.id === messageId);
      if (at < 0) throw new Error('unknown message');
      const gone = andAfter ? messages.splice(at) : messages.splice(at, 1);
      await write(join(dir, 'trash', `${trashStamp()}-${safe(id)}-messages.json`), JSON.stringify(gone, null, 2));
      await write(chatPath(id), JSON.stringify(messages, null, 2));
      onChat(id);
      return messages;
    },
    // A file the founder dropped into a chat. Kept under files/uploads with a name that cannot clash or escape.
    async saveUpload(name: string, data: Buffer): Promise<string> {
      const path = uploadPath(name);
      const full = filePath(path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, data);
      return path;
    },
    // A file too big to hold in memory — a piece of the founder's own footage — written straight to disk as it
    // arrives. Nothing is buffered, and a file that runs past the limit is stopped and thrown away half-written.
    async streamUpload(name: string, body: Readable, limit: number): Promise<{ path: string; bytes: number }> {
      const path = uploadPath(name);
      const full = filePath(path);
      await mkdir(dirname(full), { recursive: true });
      let bytes = 0;
      try {
        await pipeline(async function* () {
          for await (const chunk of body) {
            bytes += (chunk as Buffer).length;
            if (bytes > limit) throw new Error(`that file is too large (the limit is ${Math.round(limit / 1_000_000)} MB)`);
            yield chunk as Buffer;
          }
        }, createWriteStream(full));
      } catch (error) {
        await rm(full, { force: true }).catch(() => {});
        throw error;
      }
      return { path, bytes };
    },
    // Where a shared file really is on disk, for the one thing that cannot take bytes: handing a path to ffmpeg.
    pathOf: (name: string) => filePath(name),
    // What a studio made. Bytes, under a folder of the shared files, so the same route serves it to the founder and to a chat.
    async saveFileBytes(name: string, data: Buffer): Promise<string> {
      const full = filePath(name);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, data);
      return name;
    },
    readFileBytes: async (name: string) => { await queue; return readFile(filePath(name)).catch(() => null); },
    // How big a shared file is, or null when there is no such file (or no such name could be one). With `fileStream`
    // this is how a film is served a piece at a time, without the whole of it read into memory for every seek.
    fileSize: async (name: string): Promise<number | null> => {
      await queue;
      try { const info = await stat(filePath(name)); return info.isFile() ? info.size : null; } catch { return null; }
    },
    fileStream: (name: string, piece?: { from: number; to: number }) => createReadStream(filePath(name), piece ? { start: piece.from, end: piece.to } : {}),
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

// Every person's conversation on this stage, by room id.
export async function allChats(store: Pick<Store, 'readChat'>, stage: Stage): Promise<Record<string, ChatMessage[]>> {
  const chats: Record<string, ChatMessage[]> = {};
  for (const one of stage.rooms) chats[one.id] = await store.readChat(one.id);
  return chats;
}
