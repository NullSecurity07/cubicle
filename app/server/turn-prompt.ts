import { studioBehind, type ChatMessage, type Stage } from '../shared/model.ts';
import type { Browser } from './browser.ts';
import { readFailed } from './cache.ts';
import { decidedLines, type createDecisions } from './decisions.ts';
import { TEXT_FILE } from './gather.ts';
import { typeOf } from './http.ts';
import { recent, type createMemory } from './memory.ts';
import { buildMessages, colleagueIds, readableDocIds, wiredCards, type Attached } from './prompt.ts';
import type { Store } from './store.ts';
import { rulesOf } from './tools/docs.ts';
import { standingVerdict } from './tools/verdict.ts';
import { now as clockNow } from './clock.ts';

const IMAGE_FILE = /\.(png|jpe?g|webp|gif)$/i;
// A picture rides along with the question only while it is small enough for a model to be sent it.
const PICTURE_BYTES = 4_000_000;

type Deps = {
  store: Store;
  browser: Pick<Browser, 'page'>;
  media: { read(cardId: string): Promise<{ results: { path: string }[] }> };
  decisions: Pick<ReturnType<typeof createDecisions>, 'list'>;
  memory: Pick<ReturnType<typeof createMemory>, 'read'>;
  founder: { read(): Promise<string> };
};

// What the founder attached to the messages still in the window: text files as text, pictures as pictures.
export async function attachedTo(store: Pick<Store, 'readFileBytes'>, talk: ChatMessage[]): Promise<Attached> {
  const attached: Attached = { texts: {}, images: {} };
  for (const message of recent(talk)) {
    for (const file of message.attachments ?? []) {
      const bytes = await store.readFileBytes(file.path);
      if (!bytes) continue;
      if (IMAGE_FILE.test(file.path) && bytes.length <= PICTURE_BYTES) attached.images[file.path] = `data:${typeOf(file.path)};base64,${bytes.toString('base64')}`;
      else if (TEXT_FILE.test(file.path) && bytes.length <= 400_000) attached.texts[file.path] = bytes.toString('utf8');
    }
  }
  return attached;
}

export type PromptFor = ReturnType<typeof createPromptFor>;

// What one person's turn is built from: their readable docs, their own history, and the recent talk of wired colleagues.
export function createPromptFor(deps: Deps) {
  const { store, browser, media, decisions, memory, founder } = deps;
  // `slim`: the short prompt, for when the one model able to answer cannot hold the whole one (see slim.ts).
  return async function promptFor(stage: Stage, roomId: string, toolNames: string[], fresh = false, slim = false) {
    const docs: Record<string, string> = {};
    for (const id of readableDocIds(stage, roomId)) docs[id] = await store.readDoc(id);
    const colleagues: Record<string, ChatMessage[]> = {};
    for (const id of colleagueIds(stage, roomId)) colleagues[id] = await store.readChat(id);
    // A board task starts from a clean slate: the person, their documents and colleagues, not their chat.
    // Their own talk is read once, for the prompt and for what was attached to it.
    const talk = fresh ? [] : await store.readChat(roomId);
    // Link cards wired to this person: the page text, read once and kept until the address changes.
    const pages: Record<string, { title: string; text: string }> = {};
    const mine = new Set(wiredCards(stage, roomId).map((card) => card.id));
    for (const card of stage.cards ?? []) {
      if (card.kind !== 'link' || !card.url || !mine.has(card.id)) continue;
      let page = await store.readPage(card.id);
      if (!page || page.url !== card.url) {
        const url = card.url;
        page = { url, ...(await browser.page(url).catch((error: Error) => ({ title: url, text: `(could not be read: ${error.message})` }))) };
        // A page that could not be read is tried again next turn, not kept as if that were what it says.
        if (!readFailed(page.text)) await store.writePage(card.id, page);
      }
      pages[card.id] = page;
    }
    // What the founder has decided lately, each line with the day it was decided: everyone works from it, wired or not.
    const decided = decidedLines(await decisions.list());
    const messages = buildMessages(stage, roomId, docs, talk, toolNames, colleagues, await memory.read(roomId), fresh ? undefined : await attachedTo(store, talk), pages, decided, await founder.read(), clockNow(), slim);
    // A judge whose team doc says "Not assessed" is told so on every turn, at the end where it lands hardest.
    const standing: string[] = [];
    for (const id of readableDocIds(stage, roomId)) {
      const rules = await rulesOf(stage, id);
      const line = rules && standingVerdict(stage, roomId, id, rules, docs[id] ?? '');
      if (line) standing.push(line);
    }
    if (standing.length && messages[0]?.role === 'system') messages[0] = { ...messages[0], content: `${messages[0].content}\n\n${standing.join('\n')}` };
    // Image cards wired to this person ride along with the latest question, for a model that can see. An image studio
    // sends the last picture it made the same way, so a person can look at their own work.
    const pictures: { name: string; url: string }[] = [];
    for (const card of stage.cards ?? []) {
      if (!mine.has(card.id)) continue;
      // An empty picture card wired to a studio shows that studio's newest picture, so what a person sees is what
      // the founder sees on the stage. Without this the founder built exactly that and both of them got an empty box.
      const behind = card.kind === 'image' && !card.path ? studioBehind(stage, card.id) : null;
      const from = card.kind === 'imagegen' ? card.id : behind;
      const file = card.kind === 'image' && card.path ? card.path : from ? (await media.read(from)).results[0]?.path : null;
      if (!file) continue;
      const bytes = await store.readFileBytes(file).catch(() => null);
      if (bytes && bytes.length <= PICTURE_BYTES) pictures.push({ name: file, url: `data:${typeOf(file)};base64,${bytes.toString('base64')}` });
    }
    const last = messages.at(-1);
    if (pictures.length && last?.role === 'user') last.images = [...(last.images ?? []), ...pictures.slice(0, 4)];
    return messages;
  };
}
