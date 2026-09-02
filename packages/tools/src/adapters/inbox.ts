import type { Vault } from '@cubicle/core';
import { hasEnv } from './common.js';
import { existsSync, readdirSync, readFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export interface InboundMail { id: string; from: string; fromName?: string; subject: string; text: string; date: string; inReplyTo?: string }
export interface InboxReader { mode: 'mock' | 'live'; fetchNew(vault: Vault): Promise<InboundMail[]>; /** Acknowledge a processed message (live: flag \\Seen) — called only after the vault note and job exist. */ ack?(id: string): Promise<void> }

/**
 * Inbound mail. Live: IMAP (Gmail app password) via imapflow, unseen messages are fetched and flagged \\Seen.
 * Mock: JSON files dropped into `.cubicle/mock/inbox/*.json` ({from, subject, text}) are consumed once.
 */
export function inboxReader(env: NodeJS.ProcessEnv): InboxReader {
  if (hasEnv(env, 'IMAP_HOST', 'IMAP_USER', 'IMAP_PASS')) {
    return {
      mode: 'live',
      async fetchNew() {
        const { ImapFlow } = await import('imapflow');
        const client = new ImapFlow({ host: env.IMAP_HOST!, port: Number(env.IMAP_PORT ?? 993), secure: true, auth: { user: env.IMAP_USER!, pass: env.IMAP_PASS! }, logger: false });
        const out: InboundMail[] = [];
        await client.connect();
        try {
          const lock = await client.getMailboxLock('INBOX');
          try {
            // No IMAP commands inside the fetch loop (imapflow deadlocks otherwise): collect first, flag later via ack().
            for await (const msg of client.fetch({ seen: false }, { envelope: true, source: true, uid: true }, { uid: true })) {
              const src = msg.source?.toString('utf8') ?? '';
              out.push({ id: `imap-${msg.uid}`, from: msg.envelope?.from?.[0]?.address ?? 'unknown', fromName: msg.envelope?.from?.[0]?.name ?? undefined, subject: msg.envelope?.subject ?? '(no subject)', text: extractPlainText(src), date: msg.envelope?.date?.toISOString?.() ?? new Date().toISOString(), inReplyTo: msg.envelope?.inReplyTo ?? undefined });
              if (out.length >= 100) break;
            }
          } finally { lock.release(); }
        } finally { await client.logout().catch(() => undefined); }
        return out;
      },
      async ack(id) {
        const uid = Number(id.replace(/^imap-/, ''));
        if (!Number.isFinite(uid)) return;
        const { ImapFlow } = await import('imapflow');
        const client = new ImapFlow({ host: env.IMAP_HOST!, port: Number(env.IMAP_PORT ?? 993), secure: true, auth: { user: env.IMAP_USER!, pass: env.IMAP_PASS! }, logger: false });
        await client.connect();
        try { const lock = await client.getMailboxLock('INBOX'); try { await client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true }); } finally { lock.release(); } }
        finally { await client.logout().catch(() => undefined); }
      },
    };
  }
  return {
    mode: 'mock',
    async fetchNew(vault) {
      const dir = vault.abs('.cubicle/mock/inbox');
      if (!existsSync(dir)) return [];
      const done = path.join(dir, 'consumed'); mkdirSync(done, { recursive: true });
      const out: InboundMail[] = [];
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
        try {
          const j = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as Partial<InboundMail>;
          out.push({ id: `mock-${f.replace(/\.json$/, '')}`, from: j.from ?? 'someone@example.com', fromName: j.fromName, subject: j.subject ?? '(no subject)', text: j.text ?? '', date: j.date ?? new Date().toISOString(), inReplyTo: j.inReplyTo });
        } catch { /* skip */ }
        renameSync(path.join(dir, f), path.join(done, f));
      }
      return out;
    },
  };
}

/** Very small MIME text extraction: prefer text/plain part, else strip tags from text/html, else the raw body. */
export function extractPlainText(source: string): string {
  const [headers, ...rest] = source.split(/\r?\n\r?\n/);
  const body = rest.join('\n\n');
  const boundary = headers.match(/boundary="?([^";\s]+)"?/i)?.[1];
  if (boundary) {
    const parts = body.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?`));
    const plain = parts.find((p) => /content-type:\s*text\/plain/i.test(p));
    const html = parts.find((p) => /content-type:\s*text\/html/i.test(p));
    const pick = plain ?? html ?? parts[1] ?? '';
    const pb = pick.split(/\r?\n\r?\n/).slice(1).join('\n\n');
    const decoded = /quoted-printable/i.test(pick) ? pb.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))) : /base64/i.test(pick) ? Buffer.from(pb.replace(/\s+/g, ''), 'base64').toString('utf8') : pb;
    return (plain ? decoded : decoded.replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').trim().slice(0, 20_000);
  }
  return body.trim().slice(0, 20_000);
}
