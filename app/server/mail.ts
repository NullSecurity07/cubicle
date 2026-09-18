import nodemailer from 'nodemailer';

export type Letter = { roomId: string; name: string; from: 'me' | 'founder'; to: string[]; subject: string; body: string; replyTo?: string };
export type Received = { id: string; from: string; subject: string; preview: string; at: string };
export type Mail = ReturnType<typeof createMail>;
type Smtp = (letter: { from: string; to: string[]; subject: string; text: string }) => Promise<unknown>;

const API = 'https://api.agentmail.to/v0';
export const SETUP_HINT = 'Email is not set up. The founder adds AGENTMAIL_API_KEY (free at agentmail.to) to .env for a mailbox per person, '
  + 'or GMAIL_USER and GMAIL_APP_PASSWORD to send from their own address, then restarts the app.';

// Two ways out. AgentMail gives each person a real mailbox of their own that can also receive; Gmail sends as the founder.
export function createMail(env: NodeJS.ProcessEnv = process.env, http: typeof fetch = fetch, smtp?: Smtp) {
  const key = env.AGENTMAIL_API_KEY;
  const gmail = env.GMAIL_USER && env.GMAIL_APP_PASSWORD ? { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD } : null;
  const inboxes = new Map<string, { id: string; email: string }>();

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await http(`${API}${path}`, { ...init, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`AgentMail answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return response.json() as Promise<T>;
  }
  // `client_id` makes this safe to repeat: the same person always gets the same mailbox back.
  async function inbox(roomId: string, name: string) {
    const known = inboxes.get(roomId);
    if (known) return known;
    const made = await call<{ inbox_id: string; email?: string }>('/inboxes', { method: 'POST', body: JSON.stringify({ client_id: `cubicle-${roomId}`, display_name: name }) });
    const mine = { id: made.inbox_id, email: made.email ?? made.inbox_id };
    inboxes.set(roomId, mine);
    return mine;
  }
  const viaGmail: Smtp = smtp ?? ((letter) => nodemailer.createTransport({ service: 'gmail', auth: gmail! }).sendMail(letter));

  return {
    ways: () => ({ agentmail: !!key, gmail: !!gmail }),
    ready: () => !!key || !!gmail,
    async send(letter: Letter): Promise<string> {
      if (letter.from === 'founder' || !key) {
        if (!gmail) throw new Error(key ? 'Sending as the founder needs GMAIL_USER and GMAIL_APP_PASSWORD in .env.' : SETUP_HINT);
        await viaGmail({ from: gmail.user, to: letter.to, subject: letter.subject, text: letter.body });
        return `Sent from ${gmail.user}. Replies go to the founder's own inbox.`;
      }
      const mine = await inbox(letter.roomId, letter.name);
      const base = `/inboxes/${encodeURIComponent(mine.id)}/messages`;
      if (letter.replyTo) await call(`${base}/${encodeURIComponent(letter.replyTo)}/reply`, { method: 'POST', body: JSON.stringify({ text: letter.body }) });
      else await call(`${base}/send`, { method: 'POST', body: JSON.stringify({ to: letter.to, subject: letter.subject, text: letter.body }) });
      return `Sent from ${mine.email}.`;
    },
    async received(roomId: string, name: string): Promise<{ address: string; messages: Received[] }> {
      if (!key) throw new Error('Only an AgentMail mailbox can be read. The founder adds AGENTMAIL_API_KEY to .env.');
      const mine = await inbox(roomId, name);
      const list = await call<{ messages?: { message_id: string; from?: string; subject?: string; preview?: string; text?: string; timestamp?: string; created_at?: string }[] }>(`/inboxes/${encodeURIComponent(mine.id)}/messages?limit=10`);
      return { address: mine.email, messages: (list.messages ?? []).map((one) => ({ id: one.message_id, from: one.from ?? '', subject: one.subject ?? '', preview: (one.preview ?? one.text ?? '').slice(0, 300), at: one.timestamp ?? one.created_at ?? '' })) };
    },
  };
}

// For browser journeys: a mail service that accepts everything and sends nothing.
export const fakeMailHttp = (async (url: string | URL | Request) => {
  const path = String(url);
  const bodyFor = path.endsWith('/inboxes') ? { inbox_id: 'person@agentmail.test', email: 'person@agentmail.test' }
    : path.includes('/messages?') ? { messages: [{ message_id: 'msg-1', from: 'lead@example.com', subject: 'Pricing?', preview: 'What does it cost?', timestamp: '2026-09-19T10:00:00Z' }] }
    : { message_id: 'sent-1' };
  return new Response(JSON.stringify(bodyFor), { status: 200 });
}) as typeof fetch;
