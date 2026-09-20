import type { Buttons, Command, Message, Update } from './telegram.ts';

export type Posted = { chatId: number; text: string; buttons?: Buttons; messageId: number; threadId?: number; loud?: boolean; voice?: number; file?: { as: string; name: string; size: number } };
export type Topic = { threadId: number; name: string; closed?: boolean };
export type FakeTelegram = ReturnType<typeof fakeTelegram>;

const REST = 50;

// Telegram, stood in for. Nothing leaves the machine: updates are handed in by the browser check through a route
// that only exists while the app is running its fake model, and what the bot "sends" is kept here to be read back.
// It also keeps what a real Telegram would: the topics that were made, and the menu it was last given.
export function fakeTelegram(options: { canManageTopics?: boolean } = {}) {
  const waiting: Update[] = [];
  const posted: Posted[] = [];
  const topics: Topic[] = [];
  let commands: Command[] = [];
  let updates = 0;
  let messages = 100;
  let threads = 0;

  const http: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = url.pathname.split('/').pop();
    const answer = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } });
    const refuse = (why: string) => new Response(JSON.stringify({ ok: false, description: why }), { status: 400, headers: { 'content-type': 'application/json' } });
    // A voice note, a picture, a film or any other file goes up as a form rather than as json, the way bytes have to.
    // What is kept is what a check would want to read back: which of them it was, what it was called and how big it is.
    if (init?.body instanceof FormData) {
      const form = init.body;
      const field = ({ sendVoice: 'voice', sendPhoto: 'photo', sendVideo: 'video', sendAudio: 'audio', sendDocument: 'document' } as Record<string, string>)[method ?? ''] ?? 'document';
      const sound = form.get(field);
      const sent: Posted = {
        chatId: Number(form.get('chat_id')), text: String(form.get('caption') ?? ''), messageId: (messages += 1),
        ...(field === 'voice'
          ? { voice: sound instanceof Blob ? sound.size : 0 }
          : { file: { as: field, name: sound instanceof File ? sound.name : '', size: sound instanceof Blob ? sound.size : 0 } }),
        ...(form.get('message_thread_id') ? { threadId: Number(form.get('message_thread_id')) } : {}),
        ...(form.get('disable_notification') ? {} : { loud: true }),
      };
      posted.push(sent);
      return answer({ message_id: sent.messageId, chat: { id: sent.chatId } } satisfies Message);
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>;
    if (method === 'getUpdates') {
      const ready = waiting.filter((one) => one.update_id >= (body.offset ?? 0));
      // An empty poll rests for a moment instead of answering at once, the way a real long poll waits.
      if (!ready.length) await new Promise((done) => { setTimeout(done, REST); });
      return answer(ready);
    }
    if (method === 'sendMessage') {
      const sent: Posted = {
        chatId: Number(body.chat_id), text: String(body.text), messageId: (messages += 1),
        ...(body.message_thread_id ? { threadId: Number(body.message_thread_id) } : {}),
        ...(body.disable_notification ? {} : { loud: true }),
        ...(body.reply_markup ? { buttons: (body.reply_markup.inline_keyboard as { text: string; callback_data: string }[][]).map((row) => row.map((one) => ({ text: one.text, data: one.callback_data }))) } : {}),
      };
      posted.push(sent);
      return answer({ message_id: sent.messageId, chat: { id: sent.chatId }, text: sent.text } satisfies Message);
    }
    if (method === 'editMessageText') {
      const held = posted.find((one) => one.messageId === Number(body.message_id));
      if (held) { held.text = String(body.text); held.buttons = undefined; }
      return answer(true);
    }
    if (method === 'setMyCommands') { commands = body.commands as Command[]; return answer(true); }
    if (method === 'createForumTopic') {
      if (options.canManageTopics === false) return refuse('Bad Request: not enough rights to manage topics');
      const made: Topic = { threadId: (threads += 1), name: String(body.name) };
      topics.push(made);
      return answer({ message_thread_id: made.threadId });
    }
    if (method === 'editForumTopic') {
      const held = topics.find((one) => one.threadId === Number(body.message_thread_id));
      if (held) held.name = String(body.name);
      return answer(true);
    }
    if (method === 'closeForumTopic') {
      const held = topics.find((one) => one.threadId === Number(body.message_thread_id));
      if (held) held.closed = true;
      return answer(true);
    }
    if (method === 'getFile') return answer({ file_path: `voice/${String(body.file_id)}.oga`, file_size: 4096 });
    // The file itself is fetched from another address altogether, not as a method call.
    if (url.pathname.includes('/file/bot')) return new Response(new Uint8Array([79, 103, 103, 83]));
    return answer(true);
  };

  return {
    http,
    posted: () => posted,
    topics: () => topics,
    commands: () => commands,
    // A message from the founder's phone, and a press of one of the buttons on something the bot sent.
    says(chatId: number, text: string, extra: Partial<Message> = {}) { waiting.push({ update_id: (updates += 1), message: { message_id: updates, chat: { id: chatId, first_name: 'Founder' }, from: { id: chatId, first_name: 'Founder' }, text, ...extra } }); },
    presses(chatId: number, data: string, messageId = posted.at(-1)?.messageId ?? 0, from = chatId) { waiting.push({ update_id: (updates += 1), callback_query: { id: `cb-${updates}`, data, from: { id: from }, message: { message_id: messageId, chat: { id: chatId } } } }); },
    // The same, from inside a group with Topics on: who wrote it matters there in a way it never does in a private chat.
    inGroup(chatId: number, userId: number, text: string, extra: Partial<Message> = {}) {
      waiting.push({ update_id: (updates += 1), message: { message_id: updates, chat: { id: chatId, title: 'The company', type: 'supergroup', is_forum: true }, from: { id: userId, first_name: 'Someone' }, text, ...extra } });
    },
  };
}
