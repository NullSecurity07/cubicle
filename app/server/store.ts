import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { newMessageId, seedDocs, seedStage, type ChatMessage, type Stage } from '../shared/model.ts';
import { stableJson } from '../shared/stable.ts';
import { trashStamp } from './clock.ts';
import { safeId, writeAtomic } from './fsx.ts';
import type { Memory } from './memory.ts';
import { listBackups } from './openends/backup.ts';
import { tarEntries } from './openends/tar.ts';

export type Store = ReturnType<typeof createStore>;
// A file the app could not read (a crash left half of it, or a hand edit broke it): where it was, where the damaged
// copy was moved to, and the backup it was put back from, or null when none held it and it started again.
export type Damage = { file: string; aside: string; from: { file: string; at: number } | null };
export type Rescue = { backups?: () => string; onDamaged?: (damage: Damage) => void };

// Where an upload goes: under files/uploads, with a name that cannot clash or escape.
// Every id on a stage: its people, its docs, its cards and its wires.
const idsOf = (stage: Stage) => [...stage.rooms, ...stage.docs, ...(stage.cards ?? []), ...stage.wires].map((one) => one.id);

const uploadPath = (name: string) => `uploads/${Date.now().toString(36)}-${name.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(-60) || 'file'}`;

const safe = (id: string) => safeId(id, 64);

// `onChat` is told whenever a conversation changed, whoever changed it. It lives here rather than at each of the
// half-dozen callers so that a writer added later cannot forget it: there is nowhere else a message can be written.
// `onStage` is told the stage as saved, revision and all, after every save, for the same reason.
// `rescue` says where the backups are and whom to tell when a file could not be read; see `recover` below.
// Every tool call in a conversation under an id of its own: a repeat becomes "id-1", "id-2", in the order said. A local
// model once saved six calls as "call_propose__0"; a provider then refuses the whole history on every later turn, and
// the window draws two receipts under one key. Changes the list in place and hands it back.
export function uniqueToolIds(messages: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>();
  for (const [at, message] of messages.entries()) {
    if (!message.tools?.length) continue;
    let touched = false;
    const tools = message.tools.map((tool) => {
      let name = tool.id || 'call';
      for (let n = 1; seen.has(name); n += 1) name = `${tool.id || 'call'}-${n}`;
      seen.add(name);
      if (name === tool.id) return tool;
      touched = true;
      return { ...tool, id: name };
    });
    if (touched) messages[at] = { ...message, tools };
  }
  return messages;
}

export function createStore(dir: string, onChat: (roomId: string) => void = () => {}, onStage: (stage: Stage) => void = () => {}, rescue: Rescue = {}) {
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
  // A read, a change and a write that must happen as one: two people's messages landing in one conversation at the
  // same moment would otherwise both read the old list, and the second write would lose the first message. Inside the
  // job, files are read and written directly (`readHere`, `writeAtomic`), since the queue is already this job's.
  const exclusive = <T>(job: () => Promise<T>): Promise<T> => {
    const run = queue.then(job);
    queue = run.catch(() => {});
    return run;
  };
  const readHere = async (path: string) => {
    try { return await readFile(path, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  // A file that does not parse bricked every request that read it: the whole canvas for stage.json, one person for
  // their conversation. Now it is moved aside, beside where it was, as <name>.corrupt-<time>.json, and the file is put
  // back from the newest backup that holds a copy that parses, or started again (`empty`) when none does; whoever
  // listens is told, so the founder hears what happened and where the damaged copy is. Files are moved and written
  // The path is never left empty: the copy to put back is found first, the damaged file is copied aside, and the good
  // copy is renamed over it, so a reader at the same moment never finds no file and takes it for a first run (which
  // would seed the stage and write the seed's docs over the founder's). The look-again, copy and replace hold the
  // queue, so no write lands between them: a caller already inside a queued job (`holding`) does them there and then,
  // anyone else queues them. Rescues from outside the queue share one job a file.
  const rescuing = new Map<string, Promise<string>>();
  const fromBackup = async (name: string) => {
    const where = rescue.backups?.();
    if (!where) return null;
    for (const one of await listBackups(where)) {
      try {
        const entry = tarEntries(gunzipSync(await readFile(join(where, one.file)))).find((held) => held.name === name && held.kind === '0');
        if (!entry) continue;
        const text = entry.body.toString('utf8');
        JSON.parse(text);
        return { text, file: one.file, at: one.at };
      } catch { /* an unreadable archive, or a damaged copy in it: try the one before */ }
    }
    return null;
  };
  type Mend = { empty: string; holding: boolean; fresh?: () => Promise<void>; stamp?: (text: string) => string };
  const recover = (path: string, mend: Mend): Promise<string> => {
    const file = relative(dir, path).split(sep).join('/');
    const run = async () => {
      const found = await fromBackup(file);
      const replace = async () => {
        const now = await readHere(path);
        if (now === null) return mend.empty;
        try { JSON.parse(now); return now; } catch { /* still damaged: this rescue is the one to put it back */ }
        const aside = join(dirname(path), `${basename(path, '.json')}.corrupt-${trashStamp()}.json`);
        await copyFile(path, aside);
        const text = (mend.stamp ?? ((same: string) => same))(found?.text ?? mend.empty);
        await writeAtomic(path, text, { mkdir: true });
        if (!found) await mend.fresh?.();
        rescue.onDamaged?.({ file, aside, from: found ? { file: found.file, at: found.at } : null });
        return text;
      };
      return mend.holding ? replace() : exclusive(replace);
    };
    if (mend.holding) return run();
    const held = rescuing.get(path);
    if (held) return held;
    const job = run().finally(() => rescuing.delete(path));
    rescuing.set(path, job);
    return job;
  };
  // What a file holds, read as JSON, or as `empty` when there is no such file; a damaged one is rescued first.
  const parse = async <T>(path: string, text: string | null, mend: Mend): Promise<T> => {
    if (text === null) return JSON.parse(mend.empty) as T;
    try { return JSON.parse(text) as T; } catch { return JSON.parse(await recover(path, mend)) as T; }
  };
  const LIST = { empty: '[]', holding: false };
  const NOTES = { empty: '{}', holding: false };

  const editChat = <T>(id: string, edit: (messages: ChatMessage[]) => T) => exclusive(async () => {
    const path = chatPath(id);
    const messages = await parse<ChatMessage[]>(path, await readHere(path), { ...LIST, holding: true });
    const out = edit(messages);
    uniqueToolIds(messages);
    await writeAtomic(path, JSON.stringify(messages, null, 2), { mkdir: true });
    return out;
  });

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

  // A stage started again after damage gets the seed docs it names, but only those that are not there: the founder's
  // own brand doc is never written over by the seed's.
  const seedMissing = async () => {
    for (const [id, body] of Object.entries(seedDocs)) if ((await readHere(docPath(id))) === null) await writeAtomic(docPath(id), body, { mkdir: true });
  };
  async function loadStage(): Promise<Stage> {
    const text = await read(stagePath);
    if (text !== null) {
      try { return JSON.parse(text) as Stage; } catch { /* rescued below */ }
      // Put back on a revision above any an open window could hold (a revision is a count of saves; this is the
      // time), so every window takes the restored stage in instead of ignoring it as older than its own.
      const stamp = (held: string) => JSON.stringify({ ...(JSON.parse(held) as Stage), rev: Math.max((JSON.parse(held) as Stage).rev ?? 0, Date.now()) }, null, 2);
      const stage = await parse<Stage>(stagePath, text, { empty: JSON.stringify(seedStage, null, 2), holding: false, fresh: seedMissing, stamp });
      onStage(stage);
      return stage;
    }
    await write(stagePath, JSON.stringify(seedStage, null, 2));
    for (const [id, body] of Object.entries(seedDocs)) await write(docPath(id), body);
    return structuredClone(seedStage);
  }

  // Every save is one revision on from the stage it replaces; see `putStage`.
  async function saveNow(sent: Stage): Promise<Stage> {
    for (const card of [...sent.rooms, ...sent.docs, ...(sent.cards ?? [])]) safe(card.id);
    const before = await loadStage();
    const stage: Stage = { ...sent, rev: (before.rev ?? 0) + 1 };
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
    onStage(stage);
    return stage;
  }

  return {
    filesDir,
    // Each browser card keeps its own Chrome profile here, so accounts made for a person's use stay signed in.
    browserProfile: (id: string) => join(dir, 'browsers', safe(id)),
    loadStage,
    // Cards that left the stage keep their files, in trash: the founder's words are never deleted.
    // Every change to the stage waits its turn behind the others, so two changes never read the same stage and the
    // second never writes over the first. Do not call these from inside a `patchStage` edit: it would wait for itself.
    saveStage: (stage: Stage) => staged(async () => { await saveNow(stage); }),
    // A change made here rather than in a window: read the stage, change it, save it, in turn. What it puts on the
    // stage is kept there until a window sends it back, because a window saves its whole stage as it last saw it,
    // and one that has not heard of the change yet would otherwise take it away again (and a doc with it, to trash).
    patchStage: (edit: (stage: Stage) => Stage | void | Promise<Stage | void>) => staged(async () => {
      const before = await loadStage();
      const draft = structuredClone(before);
      const after = (await edit(draft)) ?? draft;
      // Nothing changed is nothing written, whatever order an edit set the fields in.
      if (stableJson(after) === stableJson(before)) return after;
      const had = new Set(idsOf(before));
      for (const id of idsOf(after)) if (!had.has(id)) unseen.add(id);
      return saveNow(after);
    }),
    // The stage as a window last saw it, saved whole: what it left out on purpose goes, but whatever a change made
    // here put on the stage and the window has not sent back yet stays. Hands back the stage before and as saved.
    // A window says which revision it last saw (`rev`, from the request's If-Match header, never from the body); if
    // the stage has moved on since (another window saved, or a change made here did), nothing is written and the
    // answer is `stale`, so that window can take in the newer stage and save again, rather than put back the stage as
    // it was and take the other change away. A window on the latest revision has heard of everything a change made
    // here put down, so what it sends is saved as it is: a card it took away goes, to trash. A save that names no
    // revision (a script, a test putting a stage back) is taken as it always was.
    putStage: (sent: Stage, rev?: number) => staged(async (): Promise<{ before: Stage; next: Stage; stale: boolean }> => {
      const before = await loadStage();
      const { rev: _ignored, ...plain } = sent;
      if (typeof rev !== 'number' || !Number.isFinite(rev)) return { before, next: await saveNow(keepUnseen(before, plain)), stale: false };
      if (rev !== (before.rev ?? 0)) return { before, next: before, stale: true };
      unseen.clear();
      return { before, next: await saveNow(plain), stale: false };
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
      // Repaired as it is read too: a conversation saved before ids were kept apart recovers on its next turn.
      const messages = uniqueToolIds(await parse<ChatMessage[]>(chatPath(id), await read(chatPath(id)), LIST));
      if (messages.every((message) => message.id)) return messages;
      return editChat(id, (held) => {
        for (const [at, message] of held.entries()) if (!message.id) held[at] = { ...message, id: newMessageId() };
        return held;
      });
    },
    async appendChat(id: string, message: ChatMessage) {
      await editChat(id, (messages) => messages.push(message));
      onChat(id);
    },
    // A message written where it already is, by its id, or at the end if it is new. A reply is written early like
    // this, as it stands, and again when it is finished, so a restart in the middle of a turn keeps what was done.
    async putMessage(id: string, message: ChatMessage) {
      await editChat(id, (messages) => {
        const at = messages.findIndex((one) => one.id === message.id);
        if (at < 0) messages.push(message); else messages[at] = message;
      });
      onChat(id);
    },
    readPage: async (id: string): Promise<{ url: string; title: string; text: string } | null> => JSON.parse((await read(pagePath(id))) ?? 'null'),
    writePage: (id: string, page: { url: string; title: string; text: string }) => write(pagePath(id), JSON.stringify(page, null, 2)),
    async readMemory(id: string): Promise<Memory> {
      const saved = await parse<Partial<Memory>>(memoryPath(id), await read(memoryPath(id)), NOTES);
      return { notes: saved.notes ?? '', summary: saved.summary ?? '', upTo: saved.upTo };
    },
    writeMemory: (id: string, memory: Memory) => write(memoryPath(id), JSON.stringify(memory, null, 2)),
    // A person's memory read, changed and written as one, so two notes kept at the same moment are both kept. `edit`
    // may throw, and then nothing is written.
    editMemory: <T>(id: string, edit: (memory: Memory) => { memory: Memory; out: T }) => exclusive(async () => {
      const saved = await parse<Partial<Memory>>(memoryPath(id), await readHere(memoryPath(id)), { ...NOTES, holding: true });
      const { memory, out } = edit({ notes: saved.notes ?? '', summary: saved.summary ?? '', upTo: saved.upTo });
      await writeAtomic(memoryPath(id), JSON.stringify(memory, null, 2), { mkdir: true });
      return out;
    }),
    // Takes messages out of a conversation (one, or one and everything after it). What is taken out goes to trash.
    async cutChat(id: string, messageId: string, andAfter: boolean): Promise<ChatMessage[]> {
      const messages = await exclusive(async () => {
        const held = await parse<ChatMessage[]>(chatPath(id), await readHere(chatPath(id)), { ...LIST, holding: true });
        const at = held.findIndex((message) => message.id === messageId);
        if (at < 0) throw new Error('unknown message');
        const gone = andAfter ? held.splice(at) : held.splice(at, 1);
        await writeAtomic(join(dir, 'trash', `${trashStamp()}-${safe(id)}-messages.json`), JSON.stringify(gone, null, 2), { mkdir: true });
        await writeAtomic(chatPath(id), JSON.stringify(held, null, 2), { mkdir: true });
        return held;
      });
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
