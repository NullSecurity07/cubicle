import { toTelegram } from './format.ts';

export type Chat = { id: number; first_name?: string; username?: string; title?: string; type?: string; is_forum?: boolean };
export type User = { id: number; first_name?: string; username?: string };
// A voice note or a piece of music, as Telegram hands it over: an id to fetch it by, and how big it is.
export type Sound = { file_id: string; file_size?: number; duration?: number; mime_type?: string };
export type Message = {
  message_id: number; chat: Chat; text?: string; caption?: string; from?: User; message_thread_id?: number;
  voice?: Sound; audio?: Sound;
  // Anything Telegram marks as coming from somewhere else. Those words are not the founder speaking.
  forward_origin?: unknown; forward_date?: number; forward_from?: unknown; forward_sender_name?: string;
  reply_to_message?: { message_id: number; text?: string; caption?: string };
};
export type Callback = { id: string; data?: string; from?: User; message?: { message_id: number; chat: Chat; message_thread_id?: number } };
// What the bot was just made, and by whom: how it learns it has been put in a group at all.
export type Membership = { chat: Chat; from?: User; new_chat_member?: { status?: string; can_manage_topics?: boolean } };
export type Update = { update_id: number; message?: Message; edited_message?: Message; callback_query?: Callback; my_chat_member?: Membership };
export type Buttons = { text: string; data: string }[][];
// Where a message goes and how loudly it lands. `threadId` is a topic in a group; everything routine is silent.
export type Sent = { buttons?: Buttons; threadId?: number; loud?: boolean };
export type Command = { command: string; description: string };
export type Api = ReturnType<typeof createApi>;

// Telegram's own limit on one message, and how long a poll waits for something to happen before answering empty.
export const LIMIT = 4096;
// What Telegram will take with a file: a caption of a thousand characters, ten megabytes for something it draws as a
// picture, and fifty for anything at all. A picture over the first limit still goes — as a file, which is a tap away.
export const CAPTION = 1024;
export const PHOTO_MOST = 10 * 1024 * 1024;
export const FILE_MOST = 50 * 1024 * 1024;
export const TOO_BIG_TO_SEND = 'is bigger than Telegram will carry';
const WAIT = 25;
const BASE = 1000;
const LONGEST = 60_000;
// After this many failures in a row the bot stops trying for a while, and the screen says so.
export const BREAK_AFTER = 5;
export const BREAK_FOR = 300_000;

// One message split so that no piece is over the limit: paragraphs first, then lines, then, for a wall of text with
// nothing to break on, in the middle of the words.
export function pieces(text: string, limit = LIMIT): string[] {
  const out: string[] = [];
  let held = '';
  const flush = () => { if (held.trim()) out.push(held.trim()); held = ''; };
  for (const paragraph of text.split(/\n{2,}/)) {
    const part = paragraph.trim();
    if (!part) continue;
    if (held && held.length + part.length + 2 > limit) flush();
    if (part.length <= limit) { held = held ? `${held}\n\n${part}` : part; continue; }
    flush();
    // Too long a paragraph on its own: down to lines, and then to a hard cut.
    let rest = part;
    while (rest.length > limit) {
      const cut = rest.lastIndexOf('\n', limit) > limit * 0.5 ? rest.lastIndexOf('\n', limit) : rest.lastIndexOf(' ', limit) > limit * 0.5 ? rest.lastIndexOf(' ', limit) : limit;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    held = rest;
  }
  flush();
  return out.length ? out : [text.slice(0, limit)];
}

// What Telegram should make of a file, read off the name it was saved under. Anything it has no name for is a file,
// which is never wrong — only plainer than a picture drawn where it stands.
export function kindOf(name: string): 'photo' | 'video' | 'audio' | 'document' {
  const end = /\.([a-z0-9]+)\s*$/i.exec(name)?.[1].toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'webp'].includes(end)) return 'photo';
  if (['mp4', 'webm', 'mov'].includes(end)) return 'video';
  if (['mp3', 'm4a', 'wav', 'ogg'].includes(end)) return 'audio';
  return 'document';
}
// Which call each kind is, and what the file is called inside the form.
const AS = { photo: ['sendPhoto', 'photo'], video: ['sendVideo', 'video'], audio: ['sendAudio', 'audio'], document: ['sendDocument', 'document'] } as const;

// The few calls this app makes to Telegram, by hand over `fetch`: no dependency, no public address, nothing but
// this machine asking for what is waiting.
export function createApi(token: () => Promise<string | null>, http: typeof fetch = fetch) {
  async function call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const key = await token();
    if (!key) throw new Error('no bot token is set');
    const response = await http(`https://api.telegram.org/bot${key}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
    });
    const answer = await response.json().catch(() => null) as { ok?: boolean; result?: T; description?: string } | null;
    if (!response.ok || !answer?.ok) throw new Error(`Telegram answered ${response.status}${answer?.description ? `: ${answer.description}` : ''}`);
    return answer.result as T;
  }
  // A reply is markdown; the phone should show bold as bold. If Telegram will not take the drawing of it (a stray
  // bracket it reads as a tag gone wrong), the same words go as plain text: how it looks never costs the founder a reply.
  const drawn = <T>(method: string, body: Record<string, unknown> & { text: string }) => call<T>(method, { ...body, text: toTelegram(body.text), parse_mode: 'HTML' })
    .catch((error: Error) => (/Telegram answered 400/.test(error.message) ? call<T>(method, body) : Promise.reject(error)));
  // A voice note is bytes, not json, so it goes as a form. Node builds the parts itself — the same way the founder's
  // own recording already goes to Groq — so there is still nothing here but `fetch`.
  async function upload<T>(method: string, chatId: number, field: string, file: Blob, name: string, extra: Record<string, string | number | boolean> = {}): Promise<T> {
    const key = await token();
    if (!key) throw new Error('no bot token is set');
    const form = new FormData();
    form.append('chat_id', String(chatId));
    for (const [at, value] of Object.entries(extra)) form.append(at, String(value));
    form.append(field, file, name);
    const response = await http(`https://api.telegram.org/bot${key}/${method}`, { method: 'POST', body: form });
    const answer = await response.json().catch(() => null) as { ok?: boolean; result?: T; description?: string } | null;
    if (!response.ok || !answer?.ok) throw new Error(`Telegram answered ${response.status}${answer?.description ? `: ${answer.description}` : ''}`);
    return answer.result as T;
  }
  const to = (chatId: number, where: Sent = {}) => ({
    chat_id: chatId,
    ...(where.threadId ? { message_thread_id: where.threadId } : {}),
    // Silence is the normal way for something to arrive: only what the founder has to act on is allowed to buzz.
    ...(where.loud ? {} : { disable_notification: true }),
    ...(where.buttons ? { reply_markup: { inline_keyboard: where.buttons.map((row) => row.map((one) => ({ text: one.text, callback_data: one.data }))) } } : {}),
  });
  return {
    call,
    updates: (offset: number, signal?: AbortSignal) => call<Update[]>('getUpdates', { offset, timeout: WAIT, allowed_updates: ['message', 'callback_query', 'my_chat_member'] }, signal),
    send: (chatId: number, text: string, where: Sent = {}) => drawn<Message>('sendMessage', { ...to(chatId, where), text }),
    // What the founder already answered elsewhere should not sit on their phone with live buttons under it.
    edit: (chatId: number, messageId: number, text: string) => drawn('editMessageText', { chat_id: chatId, message_id: messageId, text }),
    answered: (id: string, text?: string) => call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }),
    // The `/` menu, filled from the stage. Telegram keeps whatever was set last, so this is only called when it changed.
    setCommands: (commands: Command[]) => call('setMyCommands', { commands }),
    topic: (chatId: number, name: string) => call<{ message_thread_id: number }>('createForumTopic', { chat_id: chatId, name }),
    renameTopic: (chatId: number, threadId: number, name: string) => call('editForumTopic', { chat_id: chatId, message_thread_id: threadId, name }),
    closeTopic: (chatId: number, threadId: number) => call('closeForumTopic', { chat_id: chatId, message_thread_id: threadId }),
    // Getting a voice note off Telegram is two steps: where the file is, and then the file.
    fileOf: (fileId: string) => call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId }),
    async grab(filePath: string): Promise<Buffer> {
      const key = await token();
      if (!key) throw new Error('no bot token is set');
      const response = await http(`https://api.telegram.org/file/bot${key}/${filePath}`);
      if (!response.ok) throw new Error(`Telegram answered ${response.status} for that recording`);
      return Buffer.from(await response.arrayBuffer());
    },
    sendVoice: (chatId: number, ogg: Buffer, where: Sent = {}) => upload<Message>('sendVoice', chatId, 'voice', new Blob([new Uint8Array(ogg)], { type: 'audio/ogg' }), 'reply.ogg', {
      ...(where.threadId ? { message_thread_id: where.threadId } : {}), ...(where.loud ? {} : { disable_notification: true }),
    }),
    // A picture, a film or a recording somebody made, sent as the thing itself. Written in a reply it is a line of
    // markdown pointing at an address that exists on this machine and nowhere else, which is no use at all on a phone.
    // Whatever Telegram will not draw as a picture still goes, as a file: the founder is holding it either way.
    async sendFile(chatId: number, file: { bytes: Buffer; name: string }, where: Sent & { caption?: string } = {}): Promise<Message> {
      if (file.bytes.length > FILE_MOST) throw new Error(`${file.name} ${TOO_BIG_TO_SEND}: it is ${Math.round(file.bytes.length / 1_000_000)} MB, and the most a bot may send is 50 MB.`);
      const kind = kindOf(file.name) === 'photo' && file.bytes.length > PHOTO_MOST ? 'document' : kindOf(file.name);
      const blob = new Blob([new Uint8Array(file.bytes)]);
      const held = {
        ...(where.threadId ? { message_thread_id: where.threadId } : {}),
        ...(where.loud ? {} : { disable_notification: true }),
        ...(kind === 'video' ? { supports_streaming: true } : {}),
      };
      // The caption is the words that went with it, drawn the way a message is — and cut, because Telegram takes a
      // quarter of a message under a picture. Plainly if it will not take the drawing, exactly as a message is.
      const caption = (where.caption ?? '').trim().slice(0, CAPTION);
      const shown = caption ? toTelegram(caption) : '';
      const plain: Record<string, string> = caption ? { caption } : {};
      const drawn: Record<string, string> = shown && shown.length <= CAPTION ? { caption: shown, parse_mode: 'HTML' } : plain;
      const put = async (method: string, field: string): Promise<Message> => {
        try { return await upload<Message>(method, chatId, field, blob, file.name, { ...held, ...drawn }); }
        catch (error) {
          if (!caption || !/Telegram answered 400/.test((error as Error).message)) throw error;
          return upload<Message>(method, chatId, field, blob, file.name, { ...held, ...plain });
        }
      };
      const [method, field] = AS[kind];
      try { return await put(method, field); }
      catch (error) {
        // Telegram refuses some pictures outright — too long, too wide, made in a way it will not draw. As a file it
        // takes every one of them, so that is the one thing worth trying again.
        if (kind !== 'photo' || !/Telegram answered 400/.test((error as Error).message)) throw error;
        return put('sendDocument', 'document');
      }
    },
  };
}

// Long polling, and what to do when it will not answer: wait twice as long each time up to a minute, and after five
// failures in a row rest for five minutes rather than hammer a service that is plainly not there.
export function createPoller(deps: {
  updates: (offset: number, signal?: AbortSignal) => Promise<Update[]>;
  onUpdate: (update: Update) => Promise<void>;
  onTrouble: (why: string | null) => void;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}) {
  const wait = deps.wait ?? ((ms: number, signal?: AbortSignal) => new Promise<void>((done) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true });
  }));
  let stop: AbortController | null = null;
  let running: Promise<void> | null = null;
  let offset = 0;
  let failures = 0;

  async function loop(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        const updates = await deps.updates(offset, signal);
        if (signal.aborted) return;
        failures = 0;
        deps.onTrouble(null);
        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1);
          await deps.onUpdate(update).catch(() => {});
        }
      } catch (error) {
        if (signal.aborted) return;
        failures += 1;
        const resting = failures >= BREAK_AFTER;
        deps.onTrouble(resting
          ? `Telegram has not answered ${failures} times in a row, so this is resting for five minutes. Last problem: ${(error as Error).message.slice(0, 160)}`
          : `Telegram did not answer: ${(error as Error).message.slice(0, 160)}. Trying again.`);
        await wait(resting ? BREAK_FOR : Math.min(BASE * 2 ** (failures - 1), LONGEST), signal);
      }
    }
  }

  return {
    start() {
      if (running) return running;
      stop = new AbortController();
      failures = 0;
      running = loop(stop.signal).finally(() => { running = null; });
      return running;
    },
    async close() {
      stop?.abort();
      await running?.catch(() => {});
      deps.onTrouble(null);
    },
    on: () => !!running,
  };
}
