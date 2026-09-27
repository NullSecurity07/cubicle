import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolEvent } from '../shared/model.ts';
import type { Answer } from './approvals.ts';
import { createApprovals } from './approvals.ts';
import { runTurn } from './loop.ts';
import { SETUP_HINT, createMail } from './mail.ts';
import type { ModelClient } from './providers.ts';
import { createStore } from './store.ts';
import { outwardTools } from './tools/outward.ts';
import { createUsage } from './usage.ts';

const calls = (list: { name: string; args: unknown }[]): ModelClient => {
  let step = 0;
  return { name: 's', model: 's', maxPromptChars: Infinity, tools: true, limits: {}, async step(_m, { onToken }) {
    step += 1;
    if (step === 1) return { text: '', calls: list.map((call, index) => ({ id: `c${index}`, name: call.name, args: JSON.stringify(call.args) })) };
    onToken('ok'); return { text: '', calls: [] };
  } };
};

function mailbox(env: NodeJS.ProcessEnv) {
  const sent: { url: string; body: any }[] = []; const smtp: any[] = [];
  const http = (async (url: string, init?: RequestInit) => { sent.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null }); return new Response(JSON.stringify(String(url).endsWith('/inboxes') ? { inbox_id: 'maya@agentmail.to', email: 'maya@agentmail.to' } : { message_id: 'x' })); }) as typeof fetch;
  return { mail: createMail(env, http, async (letter) => { smtp.push(letter); }), sent, smtp };
}

async function turn(mail: ReturnType<typeof createMail>, list: { name: string; args: unknown }[], approve?: (event: ToolEvent) => Promise<Answer>) {
  const dir = await mkdtemp(join(tmpdir(), 'outward-'));
  const store = createStore(dir);
  const events: ToolEvent[] = [];
  const result = await runTurn({
    messages: [{ role: 'user', content: 'go' }], tools: outwardTools(mail, store.filesDir), clients: [calls(list)], usage: createUsage(null), approve,
    context: { stage: await store.loadStage(), roomId: 'marketing', store, granted: new Map() }, events: { token: () => {}, tool: (event) => events.push(event) },
  });
  return { result, events };
}
const letter = { name: 'send_email', args: { to: 'lead@example.com', subject: 'Hello', body: 'Hi there' } };

describe('outward tools', () => {
  it('waits for the founder, then sends from the person\'s own mailbox', async () => {
    const { mail, sent } = mailbox({ AGENTMAIL_API_KEY: 'k' });
    const { result, events } = await turn(mail, [letter], async () => ({ ok: true }));
    expect(events.map((event) => [event.waiting, event.ok])).toEqual([[true, undefined], [undefined, undefined], [undefined, true]]);
    expect(result.tools[0].result).toBe('Sent from maya@agentmail.to.');
    expect(sent.map((one) => one.url)).toEqual(['https://api.agentmail.to/v0/inboxes', 'https://api.agentmail.to/v0/inboxes/maya%40agentmail.to/messages/send']);
    expect(sent[0].body).toEqual({ client_id: 'cubicle-marketing', display_name: 'Maya' });
    expect(sent[1].body).toEqual({ to: ['lead@example.com'], subject: 'Hello', text: 'Hi there' });
  });

  it('sends what the founder edited, and never a field the person did not propose', async () => {
    const { mail, sent } = mailbox({ AGENTMAIL_API_KEY: 'k' });
    const { result } = await turn(mail, [letter], async () => ({ ok: true, args: { subject: 'Hello from Cubicle', from: 'founder', to: 42 } }));
    expect(sent[1].body.subject).toBe('Hello from Cubicle');
    expect(sent[1].body.to).toEqual(['lead@example.com']);
    expect(result.tools[0].args).toEqual({ to: 'lead@example.com', subject: 'Hello from Cubicle', body: 'Hi there' });
  });

  it('sends nothing when the founder says no, when nobody can be asked, or when the turn is stopped', async () => {
    const { mail, sent } = mailbox({ AGENTMAIL_API_KEY: 'k' });
    expect((await turn(mail, [letter], async () => ({ ok: false }))).result.tools[0].result).toMatch(/founder said no/);
    expect((await turn(mail, [letter])).result.tools[0].ok).toBe(false);
    const approvals = createApprovals(); const stop = new AbortController();
    const waiting = approvals.ask('c0', stop.signal); stop.abort();
    expect(await waiting).toEqual({ ok: false });
    expect(approvals.answer('c0', { ok: true })).toBe(false);
    expect(sent).toEqual([]);
  });

  it('explains the setup instead of asking the founder to approve something that cannot work', async () => {
    let asked = 0;
    const { result } = await turn(mailbox({}).mail, [letter], async () => { asked += 1; return { ok: true }; });
    expect(asked).toBe(0);
    expect(result.tools[0].result).toBe(SETUP_HINT);
  });

  it('sends as the founder through Gmail, replies in a thread, and refuses a bad address', async () => {
    const gmail = mailbox({ GMAIL_USER: 'me@gmail.com', GMAIL_APP_PASSWORD: 'p', AGENTMAIL_API_KEY: 'k' });
    const asFounder = await turn(gmail.mail, [{ name: 'send_email', args: { ...letter.args, from: 'founder' } }], async () => ({ ok: true }));
    expect(asFounder.result.tools[0].result).toMatch(/Sent from me@gmail.com/);
    expect(gmail.smtp).toEqual([{ from: 'me@gmail.com', to: ['lead@example.com'], subject: 'Hello', text: 'Hi there' }]);
    const reply = mailbox({ AGENTMAIL_API_KEY: 'k' });
    await turn(reply.mail, [{ name: 'send_email', args: { ...letter.args, reply_to: 'msg-1' } }], async () => ({ ok: true }));
    expect(reply.sent[1].url).toMatch(/messages\/msg-1\/reply$/);
    const bad = await turn(mailbox({ AGENTMAIL_API_KEY: 'k' }).mail, [{ name: 'send_email', args: { ...letter.args, to: 'not-an-address' } }], async () => ({ ok: true }));
    expect(bad.result.tools[0].result).toMatch(/not an email address/);
  });

  it('runs approved code in the sandbox', async () => {
    const { result } = await turn(mailbox({}).mail, [{ name: 'run_code', args: { language: 'javascript', code: '2 + 3' } }], async () => ({ ok: true }));
    expect(result.tools[0]).toMatchObject({ ok: true, result: '5' });
  }, 60_000);
});
