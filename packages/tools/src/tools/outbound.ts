import { z } from 'zod';
import { existsSync } from 'node:fs';
import { defineTool } from '../registry.js';
import { createProposal, createJob, idFromKey, nowIso, stringifyNote, parseNote, repoRoot } from '@cubicle/core';
import { emailSender, suppressed, addSuppression, UNSUBSCRIBE_FOOTER } from '../adapters/email.js';
import { inboxReader, type InboundMail } from '../adapters/inbox.js';
import { deployer } from '../adapters/deploy.js';
import { paymentLinks } from '../adapters/stripe.js';
import { analytics, upsertDailyRow } from '../adapters/analytics.js';
import { slugify } from '../adapters/common.js';

function requireKey(ctx: { idempotencyKey?: string }): string | null {
  return ctx.idempotencyKey ?? null;
}

export const emailSend = defineTool({
  name: 'email.send',
  description: 'Send one email (Brevo). Adds the mandatory unsubscribe footer, refuses suppressed addresses, logs the touch on the Customers/ note. Owner approval by default.',
  schema: { to: z.string().email(), subject: z.string().min(1).max(200), body: z.string().min(1), to_name: z.string().optional(), html: z.string().optional() },
  async handler({ to, subject, body, to_name, html }, ctx) {
    const key = requireKey(ctx);
    if (!key) return { ok: false, text: 'email.send requires an idempotency key (harness bug)' };
    if (suppressed(ctx.vault, to)) { ctx.events.emit({ type: 'guardrail.blocked', agent: ctx.roleId, job: ctx.jobId, payload: { tool: 'email.send', reason: 'suppressed address', to } }); return { ok: false, text: `${to} is on the suppression list; never email them` }; }
    const brand = parseNote(ctx.vault.readTextOrNull('Brand/name.md') ?? '').data as { name?: string };
    const sender = emailSender(ctx.env);
    const text = body.trimEnd() + UNSUBSCRIBE_FOOTER(brand.name ? `— ${brand.name}` : '');
    const res = await sender.send(ctx.vault, { to, toName: to_name, subject, text, html: html ? html + `<p style="color:#888;font-size:12px">Reply "unsubscribe" and you will never hear from us again.</p>` : undefined, idempotencyKey: key });
    if (!res.ok) return { ok: false, text: `send failed: ${res.detail}` };
    const rel = `Customers/${slugify(to)}.md`;
    const existing = ctx.vault.readNoteOrNull(rel);
    const data = { ...(existing?.data ?? { email: to, name: to_name ?? '', status: 'contacted', created: nowIso() }), last_contact: nowIso(), touches: Number((existing?.data as { touches?: number })?.touches ?? 0) + 1 };
    const bodyMd = (existing?.body ?? `# ${to_name || to}\n\n## Timeline\n`) + `\n- ${nowIso()} email sent by ${ctx.roleId} (${sender.mode}): "${subject}" [[${ctx.jobId ?? 'job'}]]\n`;
    ctx.vault.writeText(rel, stringifyNote(data, bodyMd), ctx.roleId, { job: ctx.jobId });
    ctx.events.emit({ type: 'email.sent', agent: ctx.roleId, job: ctx.jobId, payload: { to, subject, key, mode: sender.mode, id: res.id } });
    return { ok: true, text: `${res.detail}; logged on ${rel}`, sideEffectKey: key, data: { customer: rel, mode: sender.mode } };
  },
});

export const emailInbox = defineTool({
  name: 'email.inbox',
  description: 'Poll the inbox (IMAP). New messages become/extend Customers/ notes; replies enqueue a reply job for Growth; "unsubscribe" adds the sender to the suppression list.',
  schema: { max: z.number().int().min(1).max(100).default(50) },
  async handler({ max }, ctx) {
    const reader = inboxReader(ctx.env);
    let mails: InboundMail[];
    try { mails = (await reader.fetchNew(ctx.vault)).slice(0, max); } catch (err) { return { ok: false, text: `inbox poll failed (${reader.mode}): ${(err as Error).message}` }; }
    const lines: string[] = [];
    for (const m of mails) {
      const rel = `Customers/${slugify(m.from)}.md`;
      const wantsOut = /unsubscribe|stop emailing|remove me/i.test(`${m.subject}\n${m.text}`);
      if (wantsOut) addSuppression(ctx.vault, m.from, ctx.roleId);
      const existing = ctx.vault.readNoteOrNull(rel);
      const data = { ...(existing?.data ?? { email: m.from, name: m.fromName ?? '', created: nowIso() }), status: wantsOut ? 'unsubscribed' : 'replied', last_reply: m.date, replies: Number((existing?.data as { replies?: number })?.replies ?? 0) + 1 };
      const bodyMd = (existing?.body ?? `# ${m.fromName || m.from}\n\n## Timeline\n`) + `\n- ${m.date} reply received: "${m.subject}"\n\n> ${m.text.replace(/\n/g, '\n> ').slice(0, 3000)}\n`;
      ctx.vault.writeText(rel, stringifyNote(data, bodyMd), ctx.roleId, { job: ctx.jobId });
      ctx.events.emit({ type: 'email.received', agent: ctx.roleId, job: ctx.jobId, payload: { from: m.from, subject: m.subject, id: m.id, unsubscribe: wantsOut, mode: reader.mode } });
      if (!wantsOut) {
        const jobId = createJob(ctx.vault, { id: idFromKey('job', `reply:${m.id}`), type: 'growth.outreach', title: `Reply to ${m.fromName || m.from}: ${m.subject.slice(0, 50)}`, assigned: 'growth', priority: 2, goal: `${m.fromName || m.from} <${m.from}> replied to us:\n\n"""\n${m.text.slice(0, 3000)}\n"""\n\nRead [[${rel.replace(/\.md$/, '')}]], draft a short, honest reply that moves things forward, and send it with email.send (the owner approves). If they asked a question you cannot answer, ask the owner via proposal.create kind=message.`, links: [`[[${rel.replace(/\.md$/, '')}]]`, ...(ctx.jobId ? [`[[${ctx.jobId}]]`] : [])] }, ctx.roleId);
        lines.push(`${m.from}: "${m.subject}" → ${rel}, reply job ${jobId}`);
      } else lines.push(`${m.from}: unsubscribe → suppressed`);
    }
    return { ok: true, text: mails.length ? `${mails.length} new message(s) (${reader.mode}):\n${lines.join('\n')}` : `no new mail (${reader.mode})`, data: { count: mails.length, mode: reader.mode } };
  },
});

export const deploySite = defineTool({
  name: 'deploy.site',
  description: 'Publish Site/dist to Cloudflare Pages (free). Build first (shell.run: npm run build). First deploy needs owner approval; later ones are automatic.',
  schema: { project: z.string().optional().describe('Pages project name; defaults to the brand name slug'), dir: z.string().default('Site/dist') },
  async handler({ project, dir }, ctx) {
    const key = requireKey(ctx);
    if (!key) return { ok: false, text: 'deploy.site requires an idempotency key (harness bug)' };
    const abs = ctx.vault.abs(dir);
    if (!existsSync(abs)) return { ok: false, text: `${dir} does not exist — build the site first (shell.run: npm run build)` };
    const brand = parseNote(ctx.vault.readTextOrNull('Brand/name.md') ?? '').data as { name?: string; url?: string };
    const name = project ?? slugify(brand.name || 'cubicle-site');
    const d = deployer(ctx.env, repoRoot());
    const res = await d.deploy(ctx.vault, { project: name, dir: abs, idempotencyKey: key });
    if (!res.ok) return { ok: false, text: `deploy failed: ${res.detail}` };
    ctx.events.emit({ type: 'deploy.done', agent: ctx.roleId, job: ctx.jobId, payload: { url: res.url, project: name, mode: d.mode, key } });
    if (res.url && brand.url !== res.url) {
      const cur = ctx.vault.readTextOrNull('Brand/name.md') ?? '';
      const note = parseNote(cur);
      const proposed = stringifyNote({ ...note.data, url: res.url }, note.body);
      createProposal(ctx.vault, { id: idFromKey('prop', `${key}:url`), kind: 'brand_change', from: ctx.roleId, target: 'Brand/name.md', title: `Record site URL ${res.url}`, body: `The site is live at ${res.url}. Approve to record it in Brand/name.md.\n\n## Proposed content\n\n\`\`\`\n${proposed}\`\`\``, call: { tool: 'vault.write', args: { path: 'Brand/name.md', content: proposed }, idempotency_key: `${key}:url`, job: ctx.jobId ?? undefined, role: ctx.roleId }, job: ctx.jobId ?? undefined }, ctx.roleId);
    }
    return { ok: true, text: `${res.detail} (${d.mode})`, sideEffectKey: key, data: { url: res.url, mode: d.mode } };
  },
});

export const stripePaymentLink = defineTool({
  name: 'stripe.payment_link',
  description: 'Create a Stripe Payment Link for a product (no card data ever touches us). Records it in Metrics/payment_links.md. Owner approval by default.',
  schema: { name: z.string().min(1), amount_cents: z.number().int().min(50), currency: z.string().length(3).default('usd'), description: z.string().optional() },
  async handler({ name, amount_cents, currency, description }, ctx) {
    const key = requireKey(ctx);
    if (!key) return { ok: false, text: 'stripe.payment_link requires an idempotency key (harness bug)' };
    const p = paymentLinks(ctx.env);
    const res = await p.create(ctx.vault, { name, amountCents: amount_cents, currency, description, idempotencyKey: key });
    if (!res.ok) return { ok: false, text: res.detail };
    const rel = 'Metrics/payment_links.md';
    const cur = ctx.vault.readTextOrNull(rel) ?? '# Payment links\n\n| created | product | price | url | mode |\n|---|---|---|---|---|\n';
    ctx.vault.writeText(rel, cur.replace(/\n*$/, '\n') + `| ${nowIso().slice(0, 10)} | ${name.replace(/\|/g, '/')} | ${(amount_cents / 100).toFixed(2)} ${currency.toUpperCase()} | ${res.url} | ${p.mode} |\n`, ctx.roleId, { job: ctx.jobId });
    return { ok: true, text: `${res.detail}; recorded in ${rel}`, sideEffectKey: key, data: { url: res.url, mode: p.mode } };
  },
});

export const analyticsPull = defineTool({
  name: 'analytics.pull',
  description: 'Pull today\'s visitors/pageviews from GoatCounter into Metrics/daily.md.',
  schema: {},
  async handler(_args, ctx) {
    const a = analytics(ctx.env);
    try {
      const s = await a.today(ctx.vault);
      const sentToday = ctx.events.count('email.sent', new Date(new Date().setUTCHours(0, 0, 0, 0)).toISOString());
      const repliesToday = ctx.events.count('email.received', new Date(new Date().setUTCHours(0, 0, 0, 0)).toISOString());
      upsertDailyRow(ctx.vault, ctx.roleId, s, { emails_sent: sentToday, replies: repliesToday });
      return { ok: true, text: `${s.date}: ${s.visitors} visitors, ${s.pageviews} pageviews (${s.source})${s.topPaths.length ? `; top: ${s.topPaths.slice(0, 5).map((t) => `${t.path} ${t.count}`).join(', ')}` : ''}`, data: s };
    } catch (err) { return { ok: false, text: `analytics pull failed (${a.mode}): ${(err as Error).message}` }; }
  },
});

export const socialPost = defineTool({
  name: 'social.post',
  description: 'Publish a post on an organic channel (Reddit, HN, forums…). Records the post under Experiments/posts/ and opens the channel in the browser; the final submit goes through browser.submit. Owner approval by default; banned channels are refused by the constitution.',
  schema: { channel: z.string().describe('e.g. reddit, hn, indiehackers'), url: z.string().url().describe('where to post (the submit page)'), title: z.string().max(300), body: z.string() },
  async handler({ channel, url, title, body }, ctx) {
    const key = requireKey(ctx);
    if (!key) return { ok: false, text: 'social.post requires an idempotency key (harness bug)' };
    const rel = `Experiments/posts/${nowIso().slice(0, 10)}-${slugify(channel)}-${slugify(title).slice(0, 40)}.md`;
    ctx.vault.writeText(rel, stringifyNote({ channel, url, title, posted: nowIso(), by: ctx.roleId, job: ctx.jobId ?? null, key }, `# ${title}\n\n${body}\n`), ctx.roleId, { job: ctx.jobId });
    ctx.events.emit({ type: 'agent.spoke', agent: ctx.roleId, job: ctx.jobId, payload: { to: channel, text: title, kind: 'post' } });
    return { ok: true, text: `post recorded at ${rel}. Next: browser.open ${url}, fill the form with browser.type, then browser.submit (needs approval).`, sideEffectKey: key, data: { path: rel } };
  },
});

export const phase6Tools = [emailSend, emailInbox, deploySite, stripePaymentLink, analyticsPull, socialPost];
