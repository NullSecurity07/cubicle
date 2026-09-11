import { z } from 'zod';
import { existsSync, mkdirSync, cpSync } from 'node:fs';
import { defineTool } from '../registry.js';
import { createProposal, createJob, idFromKey, nowIso, stringifyNote, parseNote, readJob, repoRoot, loadOrg, resolveRole } from '@cubicle/core';
import { emailSender, suppressed, addSuppression, UNSUBSCRIBE_FOOTER } from '../adapters/email.js';
import { inboxReader, type InboundMail } from '../adapters/inbox.js';
import { deployer, DEPLOY_STAGES } from '../adapters/deploy.js';
import { paymentLinks } from '../adapters/stripe.js';
import { analytics, upsertDailyRow } from '../adapters/analytics.js';
import { slugify } from '../adapters/common.js';
import { createHash } from 'node:crypto';

/** Customer note path: slug + short hash so a.b@x and a-b@x never merge. */
export function customerPath(email: string): string {
  const e = email.trim().toLowerCase();
  return `Customers/${slugify(e)}-${createHash('sha1').update(e).digest('hex').slice(0, 6)}.md`;
}

/** Emails sent today (UTC): from the event log, or from Customers/ timelines when the cache was wiped. */
export function emailsSentToday(vault: import('@cubicle/core').Vault, now = new Date()): number {
  const day = now.toISOString().slice(0, 10);
  const fromEvents = vault.events.count('email.sent', `${day}T00:00:00.000Z`);
  let fromNotes = 0;
  for (const rel of vault.list('Customers', { ext: '.md' })) { const t = vault.readTextOrNull(rel) ?? ''; fromNotes += (t.match(new RegExp(`^- ${day}T[^\\n]* email sent by`, 'gm')) ?? []).length; }
  return Math.max(fromEvents, fromNotes);
}

/** True when the mail's own words (not quoted text, not our footer) ask to stop. */
export function isUnsubscribeRequest(subject: string, text: string): boolean {
  if (/^\s*(re:\s*)?unsubscribe\b/i.test(subject)) return true;
  const own = text.split('\n').filter((l) => !/^\s*>/.test(l));
  const cut = own.findIndex((l) => /^On .+ wrote:\s*$/.test(l) || /^-{2,}\s*Original Message/i.test(l) || /^--\s*$/.test(l) || /Reply "unsubscribe" and you will never hear from us again/i.test(l));
  const body = (cut >= 0 ? own.slice(0, cut) : own).map((l) => l.trim()).filter(Boolean).slice(0, 5).join('\n');
  return /^(please\s+)?(unsubscribe|stop emailing( me)?|remove me|take me off)\b/im.test(body);
}

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
    // Constitution hard cap, enforced here (tool layer) — not only in the harness pre-check, so approved or dispatched calls obey it too.
    const cap = ctx.vault.constitution().max_emails_per_day;
    const sent = emailsSentToday(ctx.vault, ctx.now());
    if (sent >= cap) { ctx.events.emit({ type: 'guardrail.blocked', agent: ctx.roleId, job: ctx.jobId, payload: { tool: 'email.send', reason: `max_emails_per_day (${cap}) reached (${sent} sent today)`, to } }); return { ok: false, text: `blocked: constitution max_emails_per_day (${cap}) reached — ${sent} sent today` }; }
    const brand = parseNote(ctx.vault.readTextOrNull('Brand/name.md') ?? '').data as { name?: string };
    const sender = emailSender(ctx.env);
    const text = body.trimEnd() + UNSUBSCRIBE_FOOTER(brand.name ? `— ${brand.name}` : '');
    const res = await sender.send(ctx.vault, { to, toName: to_name, subject, text, html: html ? html + `<p style="color:#888;font-size:12px">Reply "unsubscribe" and you will never hear from us again.</p>` : undefined, idempotencyKey: key });
    if (!res.ok) return { ok: false, text: `send failed: ${res.detail}` };
    const rel = customerPath(to);
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
      const rel = customerPath(m.from);
      const wantsOut = isUnsubscribeRequest(m.subject, m.text);
      if (wantsOut) addSuppression(ctx.vault, m.from, ctx.roleId);
      const existing = ctx.vault.readNoteOrNull(rel);
      const data = { ...(existing?.data ?? { email: m.from, name: m.fromName ?? '', created: nowIso() }), status: wantsOut ? 'unsubscribed' : 'replied', last_reply: m.date, replies: Number((existing?.data as { replies?: number })?.replies ?? 0) + 1 };
      const bodyMd = (existing?.body ?? `# ${m.fromName || m.from}\n\n## Timeline\n`) + `\n- ${m.date} reply received: "${m.subject}"${wantsOut ? ' → unsubscribe detected, added to suppression (remove the line in Customers/_suppression.md to reverse)' : ''}\n\n> ${m.text.replace(/\n/g, '\n> ').slice(0, 3000)}\n`;
      ctx.vault.writeText(rel, stringifyNote(data, bodyMd), ctx.roleId, { job: ctx.jobId });
      ctx.events.emit({ type: 'email.received', agent: ctx.roleId, job: ctx.jobId, payload: { from: m.from, subject: m.subject, id: m.id, unsubscribe: wantsOut, mode: reader.mode } });
      if (!wantsOut) {
        const jobId = createJob(ctx.vault, { id: idFromKey('job', `reply:${m.id}`), type: 'growth.outreach', title: `Reply to ${m.fromName || m.from}: ${m.subject.slice(0, 50)}`, assigned: resolveRole(loadOrg(ctx.vault), 'head_of_growth'), priority: 2, goal: `${m.fromName || m.from} <${m.from}> replied to us:\n\n"""\n${m.text.slice(0, 3000)}\n"""\n\nRead [[${rel.replace(/\.md$/, '')}]], draft a short, honest reply that moves things forward, and send it with email.send (the owner approves). If they asked a question you cannot answer, ask the owner via proposal.create kind=message.`, links: [`[[${rel.replace(/\.md$/, '')}]]`, ...(ctx.jobId ? [`[[${ctx.jobId}]]`] : [])] }, ctx.roleId);
        lines.push(`${m.from}: "${m.subject}" → ${rel}, reply job ${jobId}`);
      } else lines.push(`${m.from}: unsubscribe → suppressed`);
      await reader.ack?.(m.id).catch((err: Error) => ctx.events.emit({ type: 'daemon.warning', agent: ctx.roleId, job: ctx.jobId, payload: { where: 'email.inbox', message: `ack failed for ${m.id}: ${err.message.slice(0, 100)}` } }));
    }
    return { ok: true, text: mails.length ? `${mails.length} new message(s) (${reader.mode}):\n${lines.join('\n')}` : `no new mail (${reader.mode})`, data: { count: mails.length, mode: reader.mode } };
  },
});

/** Where each deploy's published bytes are kept so a rollback has something real to republish. */
export function deploySnapshotDir(vault: import('@cubicle/core').Vault, project: string, stamp: string): string {
  return vault.abs(`.cubicle/deploys/${slugify(project)}/${stamp}`);
}

/**
 * The snapshot of the live deploy *before* the current one — what `rollback: true` republishes. Returns null
 * when fewer than two live deploys have happened, because "roll back" then has no honest meaning.
 */
export function previousLiveSnapshot(vault: import('@cubicle/core').Vault, project: string): string | null {
  const lives = vault.events.query({ types: ['deploy.done'], limit: 500 })
    .filter((e) => e.payload.project === slugify(project) && e.payload.stage === 'live' && e.payload.rolled_back !== true && typeof e.payload.snapshot === 'string');
  if (lives.length < 2) return null;
  const abs = vault.abs(String(lives[lives.length - 2].payload.snapshot));
  return existsSync(abs) ? abs : null;
}

/** The stages of this project already reached, from the event log. */
function stagesDone(vault: import('@cubicle/core').Vault, project: string): Set<string> {
  return new Set(vault.events.query({ types: ['deploy.done'], limit: 500 }).filter((e) => e.payload.project === project).map((e) => String(e.payload.stage ?? 'live')));
}

/** A snapshot directory that does not already exist: two deploys inside the same millisecond must not share bytes. */
function uniqueStamp(vault: import('@cubicle/core').Vault, project: string): string {
  const base = nowIso().replace(/[:.]/g, '-');
  if (!existsSync(deploySnapshotDir(vault, project, base))) return base;
  let n = 2;
  while (existsSync(deploySnapshotDir(vault, project, `${base}-${n}`))) n++;
  return `${base}-${n}`;
}

export const deploySite = defineTool({
  name: 'deploy.site',
  description: 'Publish Site/dist to Cloudflare Pages (free), one stage at a time: preview → canary → live (owner\'s operating model §20). Build first (shell.run: npm run build). canary needs a preview first, live needs a canary; live must name the metrics it will watch. The canary percentage is a mock until real traffic-splitting infrastructure exists — it is recorded, not enforced. `rollback: true` republishes the previous live deploy. First deploy needs owner approval; later ones are automatic.',
  schema: {
    project: z.string().optional().describe('Pages project name; defaults to the brand name slug'),
    dir: z.string().default('Site/dist'),
    stage: z.enum(DEPLOY_STAGES).default('preview'),
    canary_percent: z.number().int().min(1).max(100).default(5).describe('recorded with the canary stage; a mock until real traffic splitting exists'),
    metrics: z.array(z.string()).default([]).describe('what you will watch after this deploy — error rate, latency, the stream\'s outcome metric. Required for canary and live.'),
    rollback: z.boolean().default(false).describe('republish the previous live deploy instead of Site/dist'),
  },
  async handler({ project, dir, stage, canary_percent, metrics, rollback }, ctx) {
    const key = requireKey(ctx);
    if (!key) return { ok: false, text: 'deploy.site requires an idempotency key (harness bug)' };
    const brand = parseNote(ctx.vault.readTextOrNull('Brand/name.md') ?? '').data as { name?: string; url?: string };
    const name = (project ?? slugify(brand.name || 'cubicle-site')).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,57}$/.test(name)) return { ok: false, text: `invalid project name "${name}" (lowercase letters, digits, dashes)` };

    let abs: string;
    let rel = 'Site/dist';
    if (rollback) {
      const prev = previousLiveSnapshot(ctx.vault, name);
      if (!prev) return { ok: false, text: `no previous live deploy of "${name}" to roll back to. Fix forward: build, deploy a preview, then a canary, then live.` };
      abs = prev;
      stage = 'live';
    } else {
      try { rel = (await import('@cubicle/core')).normalizeRel(dir); } catch (err) { return { ok: false, text: (err as Error).message }; }
      if (!/^Site\/[^/]+(\/.*)?$/.test(rel) || rel.startsWith('Site/node_modules')) return { ok: false, text: `deploy.site only publishes a build directory under Site/ (e.g. Site/dist), not "${dir}"` };
      abs = ctx.vault.abs(rel);
      if (!existsSync(abs)) return { ok: false, text: `${rel} does not exist — build the site first (shell.run: npm run build)` };
      const { lstatSync } = await import('node:fs');
      if (lstatSync(abs).isSymbolicLink()) return { ok: false, text: `${rel} is a symlink; refusing` };

      const done = stagesDone(ctx.vault, name);
      if (stage === 'canary' && !done.has('preview')) return { ok: false, text: `deploy a preview of "${name}" first (stage: "preview"), look at it, then canary. §20: reduce the blast radius by exposing the change gradually.` };
      if (stage === 'live' && !done.has('canary')) return { ok: false, text: `deploy a canary of "${name}" first (stage: "canary", with the metrics you will watch), then live.` };
      if (stage !== 'preview' && metrics.length === 0) return { ok: false, text: `a ${stage} deploy must name the metrics it will watch (§20: error rates, latency, business metrics, resource use). Pass metrics: ["error rate", "<the stream's outcome metric>"].` };
    }

    const d = deployer(ctx.env, repoRoot());
    const res = await d.deploy(ctx.vault, { project: name, dir: abs, idempotencyKey: key, stage });
    if (!res.ok) return { ok: false, text: `deploy failed: ${res.detail}` };

    // Keep the exact bytes that went out, so a rollback republishes a real artefact rather than a rebuild.
    const snapDir = deploySnapshotDir(ctx.vault, name, uniqueStamp(ctx.vault, name));
    let snapshot: string | null = null;
    try { mkdirSync(snapDir, { recursive: true }); cpSync(abs, snapDir, { recursive: true }); snapshot = ctx.vault.rel(snapDir); } catch { snapshot = null; }
    if (rollback) { try { cpSync(abs, ctx.vault.abs('Site/dist'), { recursive: true }); ctx.vault.rescan('Site', `${ctx.roleId}/deploy`, { job: ctx.jobId }); } catch { /* the deploy itself still went out */ } }

    ctx.events.emit({ type: 'deploy.done', agent: ctx.roleId, job: ctx.jobId, payload: { url: res.url, project: name, mode: d.mode, key, stage, canary_percent: stage === 'canary' ? canary_percent : null, metrics, rolled_back: rollback, snapshot, stream: readJob(ctx.vault, ctx.jobId ?? '')?.data.stream ?? null } });

    if (stage === 'live' && res.url && brand.url !== res.url) {
      const cur = ctx.vault.readTextOrNull('Brand/name.md') ?? '';
      const note = parseNote(cur);
      const proposed = stringifyNote({ ...note.data, url: res.url }, note.body);
      createProposal(ctx.vault, { id: idFromKey('prop', `${key}:url`), kind: 'brand_change', from: ctx.roleId, target: 'Brand/name.md', title: `Record site URL ${res.url}`, body: `The site is live at ${res.url}. Approve to record it in Brand/name.md.\n\n## Proposed content\n\n\`\`\`\n${proposed}\`\`\``, call: { tool: 'vault.write', args: { path: 'Brand/name.md', content: proposed }, idempotency_key: `${key}:url`, job: ctx.jobId ?? undefined, role: ctx.roleId }, job: ctx.jobId ?? undefined }, ctx.roleId);
    }
    const watching = metrics.length ? ` Watching: ${metrics.join(', ')}.` : '';
    return { ok: true, text: `${rollback ? 'rolled back — ' : ''}${res.detail} (${d.mode}, stage ${stage}${stage === 'canary' ? `, ${canary_percent} % mock canary` : ''}).${watching}`, sideEffectKey: key, data: { url: res.url, mode: d.mode, stage, rolled_back: rollback, snapshot } };
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
