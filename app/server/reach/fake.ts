import type { Buttons, Message, Update } from './telegram.ts';

export type Posted = { chatId: number; text: string; buttons?: Buttons; messageId: number };
export type FakeTelegram = ReturnType<typeof fakeTelegram>;

const REST = 50;

// Telegram, stood in for. Nothing leaves the machine: updates are handed in by the browser check through a route
// that only exists while the app is running its fake model, and what the bot "sends" is kept here to be read back.
export function fakeTelegram() {
  const waiting: Update[] = [];
  const posted: Posted[] = [];
  let updates = 0;
  let messages = 100;

  const http: typeof fetch = async (input, init) => {
    const method = new URL(String(input)).pathname.split('/').pop();
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>;
    const answer = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } });
    if (method === 'getUpdates') {
      const ready = waiting.filter((one) => one.update_id >= (body.offset ?? 0));
      // An empty poll rests for a moment instead of answering at once, the way a real long poll waits.
      if (!ready.length) await new Promise((done) => { setTimeout(done, REST); });
      return answer(ready);
    }
    if (method === 'sendMessage') {
      const sent: Posted = { chatId: Number(body.chat_id), text: String(body.text), messageId: (messages += 1), ...(body.reply_markup ? { buttons: (body.reply_markup.inline_keyboard as { text: string; callback_data: string }[][]).map((row) => row.map((one) => ({ text: one.text, data: one.callback_data }))) } : {}) };
      posted.push(sent);
      return answer({ message_id: sent.messageId, chat: { id: sent.chatId }, text: sent.text } satisfies Message);
    }
    if (method === 'editMessageText') {
      const held = posted.find((one) => one.messageId === Number(body.message_id));
      if (held) { held.text = String(body.text); held.buttons = undefined; }
      return answer(true);
    }
    return answer(true);
  };

  return {
    http,
    posted: () => posted,
    // A message from the founder's phone, and a press of one of the buttons on something the bot sent.
    says(chatId: number, text: string, extra: Partial<Message> = {}) { waiting.push({ update_id: (updates += 1), message: { message_id: updates, chat: { id: chatId, first_name: 'Founder' }, text, ...extra } }); },
    presses(chatId: number, data: string, messageId = posted.at(-1)?.messageId ?? 0) { waiting.push({ update_id: (updates += 1), callback_query: { id: `cb-${updates}`, data, message: { message_id: messageId, chat: { id: chatId } } } }); },
  };
}
