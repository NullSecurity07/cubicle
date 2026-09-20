export type Chat = { id: number; first_name?: string; username?: string; title?: string };
export type Message = {
  message_id: number; chat: Chat; text?: string; caption?: string;
  // Anything Telegram marks as coming from somewhere else. Those words are not the founder speaking.
  forward_origin?: unknown; forward_date?: number; forward_from?: unknown; forward_sender_name?: string;
  reply_to_message?: { message_id: number; text?: string; caption?: string };
};
export type Callback = { id: string; data?: string; message?: { message_id: number; chat: Chat } };
export type Update = { update_id: number; message?: Message; edited_message?: Message; callback_query?: Callback };
export type Buttons = { text: string; data: string }[][];
export type Api = ReturnType<typeof createApi>;

// Telegram's own limit on one message, and how long a poll waits for something to happen before answering empty.
export const LIMIT = 4096;
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
  return {
    call,
    updates: (offset: number, signal?: AbortSignal) => call<Update[]>('getUpdates', { offset, timeout: WAIT, allowed_updates: ['message', 'callback_query'] }, signal),
    send: (chatId: number, text: string, buttons?: Buttons) => call<Message>('sendMessage', { chat_id: chatId, text, ...(buttons ? { reply_markup: { inline_keyboard: buttons.map((row) => row.map((one) => ({ text: one.text, callback_data: one.data }))) } } : {}) }),
    // What the founder already answered elsewhere should not sit on their phone with live buttons under it.
    edit: (chatId: number, messageId: number, text: string) => call('editMessageText', { chat_id: chatId, message_id: messageId, text }),
    answered: (id: string, text?: string) => call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }),
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
