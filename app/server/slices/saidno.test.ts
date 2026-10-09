import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Installed } from '../install.ts';
import { saidNoFor } from '../partner/saidno.ts';
import { stubDeps } from '../slice-stubs.ts';
import saidno, { HELD_BYPASS, holdBypassClaims, holdRuleClaims, NOT_KEPT } from './saidno.ts';

const ROOT = resolve(import.meta.dirname, '../../..');

// Journey 15: the founder's "Don't propose cold outreach to more makers this week" kept no entry and no reason.
describe('a no said in chat', () => {
  it('keeps a standing no with its reason, even when nothing was proposed just before it', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'saidno-slice-'));
    const deps = stubDeps(workspace, ROOT);
    const part = (await saidno.install(deps)) as Installed;
    const stage = await deps.store.loadStage();
    const roomId = stage.rooms[0].id;
    await deps.seams.run('turn:before', { roomId, source: 'chat', query: 'No to the task of contacting 10 more makers, because we are at 9 jobs. Don\'t propose cold outreach to more makers this week.', messages: [] });
    const kept = await saidNoFor(workspace).list();
    expect(kept.map((one) => [one.tool, one.subject, one.reason])).toEqual(expect.arrayContaining([
      ['chat', 'contacting 10 more makers', 'we are at 9 jobs'],
      ['chat', 'cold outreach to more makers', 'we are at 9 jobs'],
    ]));
    expect(await saidNoFor(workspace).ruledOut('Contact 40 more local makers to secure the remaining 6 print jobs.')).toMatchObject({ subject: expect.stringMatching(/makers/) });
    await part.close?.();
  });
});

// Journey 20: "No paid ads, because …" also kept a no on the open "Referral discount" decision proposed just before,
// and "No to that reply for Ines, because …" a no on the morning note's question.
describe('a no that names its own subject', () => {
  it('keeps only that standing no, never a no on what was proposed just before it', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'saidno-slice-'));
    const deps = stubDeps(workspace, ROOT);
    const part = (await saidno.install(deps)) as Installed;
    const roomId = (await deps.store.loadStage()).rooms[0].id;
    await deps.store.appendChat(roomId, { id: 'q', role: 'user', text: 'a café gets two months at no charge if it brings in another café', at: 1 } as never);
    await deps.store.appendChat(roomId, { id: 'a', role: 'assistant', text: 'Should we update the Company Numbers to include booking and subscription revenue?', at: 2,
      tools: [{ id: 't', name: 'propose_decision', args: { title: 'Referral discount for new cafés', options: ['yes', 'no'] }, ok: true, result: 'proposed' }] } as never);
    await deps.seams.run('turn:before', { roomId, source: 'chat', query: 'No paid ads, because repair cafés find tools through other cafés, not through ads.', messages: [] });
    expect((await saidNoFor(workspace).list()).map((one) => [one.tool, one.subject, one.reason])).toEqual([['chat', 'paid ads', 'repair cafés find tools through other cafés, not through ads']]);
    // A plain "No, too early" right after a proposal is still a no to it.
    await deps.seams.run('turn:before', { roomId, source: 'chat', query: 'No, too early.', messages: [] });
    expect((await saidNoFor(workspace).list()).map((one) => one.subject)).toEqual(expect.arrayContaining(['paid ads', 'Referral discount for new cafés']));
    await part.close?.();
  });
});

// Journey 17: "No cold outreach to nurses we have not met, because nurses hate it." Sam: "I have recorded that rule",
// and nothing was kept.
describe('a reply that says a no was recorded', () => {
  const reply = (text: string) => ({ text, tools: [], provider: 'fake', model: 'fake', usage: { inputTokens: 0, outputTokens: 0 }, stopped: false }) as never;

  it('keeps "No X, because Y" as a standing no and lets the reply say so', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'saidno-slice-'));
    const deps = stubDeps(workspace, ROOT);
    const part = (await saidno.install(deps)) as Installed;
    const roomId = (await deps.store.loadStage()).rooms[0].id;
    const query = 'No cold outreach to nurses we have not met, because nurses hate it.';
    await deps.seams.run('turn:before', { roomId, source: 'chat', query, messages: [] });
    expect((await saidNoFor(workspace).list()).map((one) => [one.subject, one.reason])).toEqual([['cold outreach to nurses we have not met', 'nurses hate it']]);
    const out = await deps.seams.run('turn:reply', { roomId, query, reply: reply('I have recorded that rule. I will not propose it.') });
    expect(out.reply.text).toBe('I have recorded that rule. I will not propose it.');
    await part.close?.();
  });

  it('says it was not kept when nothing was written', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'saidno-slice-'));
    const deps = stubDeps(workspace, ROOT);
    const part = (await saidno.install(deps)) as Installed;
    const roomId = (await deps.store.loadStage()).rooms[0].id;
    const query = 'No idea why, but never mind.';
    await deps.seams.run('turn:before', { roomId, source: 'chat', query, messages: [] });
    expect(await saidNoFor(workspace).list()).toEqual([]);
    const out = await deps.seams.run('turn:reply', { roomId, query, reply: reply('Understood. I have recorded that rule. Anything else?') });
    expect(out.reply.text).toBe(`Understood. ${NOT_KEPT} Anything else?`);
    await part.close?.();
  });

  it('leaves a reply alone when the founder said no rule, or the claim is denied', () => {
    expect(holdRuleClaims('I have recorded the meeting.', 'Log the meeting with Anna.', 0)).toBe('I have recorded the meeting.');
    expect(holdRuleClaims('That was not recorded as a rule.', 'Never mind.', 0)).toBe('That was not recorded as a rule.');
    expect(holdRuleClaims('Noted. I have recorded that rule.', 'Never mind.', 0)).toBe(NOT_KEPT);
  });
});

// Journey 18: "I have proposed the decision under a new title so it successfully bypasses the duplicate block."
describe('a reply that says it went round a no', () => {
  it('drops the claim and takes the retitled decision back off the list', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'saidno-bypass-'));
    const deps = stubDeps(workspace, ROOT);
    const part = (await saidno.install(deps)) as Installed;
    const roomId = (await deps.store.loadStage()).rooms[0].id;
    const args = { title: 'Referral program with a free month for two referrals', context: 'x', options: ['Launch it', 'Wait'] };
    await deps.decisions.propose({ ...args, proposedBy: 'Sam' });
    const text = 'I have proposed the decision under a new title ("Referral program with a free month for two referrals") so it successfully bypasses the duplicate block, and it now waits in your list. My call: keep going.';
    const reply = { text, tools: [{ id: 't', name: 'propose_decision', args, ok: true, result: 'Proposed' }], provider: 'fake', model: 'fake', usage: { inputTokens: 0, outputTokens: 0 }, stopped: false } as never;
    const out = await deps.seams.run('turn:reply', { roomId, query: 'Sam, put the referral month to me again.', reply });
    expect(out.reply.text).toBe(`${HELD_BYPASS} My call: keep going.`);
    expect((await deps.decisions.list()).filter((one) => one.status === 'proposed')).toEqual([]);
    expect((await saidNoFor(workspace).list()).map((one) => one.subject)).toEqual(['Referral program with a free month for two referrals']);
    await part.close?.();
  });

  it('leaves a reply that only talks about blocks alone', () => {
    expect(holdBypassClaims('The leak blocks the kitchen drain.').claimed).toBe(false);
    expect(holdBypassClaims('We get past 12 paying plumbers by Friday.').claimed).toBe(false);
    expect(holdBypassClaims('A new title gets it past your no.').claimed).toBe(true);
  });
});

// Journey 19: "what have I said no to" recalled two of five from memory.
describe('the founder asks what they said no to', () => {
  it('is answered from the record, every no of the last thirty days', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'saidno-slice-'));
    const deps = stubDeps(workspace, ROOT);
    const part = (await saidno.install(deps)) as Installed;
    const roomId = (await deps.store.loadStage()).rooms[0].id;
    for (const query of ['Never promise a feature we have not shipped.', "Don't count the trials as customers.", 'No discounts, because it trains customers to wait.']) await deps.seams.run('turn:before', { roomId, source: 'chat', query, messages: [] });
    // Each no keeps its own reason or none: a standing no is never the reason of the one before it.
    expect((await saidNoFor(workspace).list()).map((one) => [one.subject, one.reason])).toEqual([
      ['discounts', 'it trains customers to wait'], ['count the trials as customers', undefined], ['promise a feature we have not shipped', undefined]]);
    const query = 'What have I said no to?';
    await deps.seams.run('turn:before', { roomId, source: 'chat', query, messages: [] });
    const reply = { text: 'You said no to discounts.', tools: [], provider: 'fake', model: 'fake', usage: { inputTokens: 0, outputTokens: 0 }, stopped: false } as never;
    const out = await deps.seams.run('turn:reply', { roomId, query, reply });
    expect(out.reply.text).toMatch(/^What you said no to in the last 30 days, by the record \(3\):/);
    for (const one of ['discounts', 'count the trials as customers', 'promise a feature we have not shipped']) expect(out.reply.text).toContain(one);
    await part.close?.();
  });
});

// Journey 21: "Everything you said no to, with your reasons: None on record" with five nos in said-no.json.
describe('a recall that asks for the nos among other things', () => {
  it('reads said-no.json and answers with every no, and the reply\'s "None on record" goes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'saidno-slice-'));
    const at = Date.now() - 3 * 86_400_000;
    const entries = [
      { id: 'n1', tool: 'chat', subject: 'that reply for Ines', reason: 'it promises a refund policy', at, asked: 0 },
      { id: 'n2', tool: 'chat', subject: 'state a policy we have not decided', reason: 'we have none yet', at: at + 1, asked: 0 },
      { id: 'n3', tool: 'draft_email', subject: 'Re: FixSlot for Repair Café Kreuzberg', at: at + 2, asked: 0 },
      { id: 'n4', tool: 'propose_decision', subject: 'Free months for new cafés', options: ['3 months free', 'no'], reason: 'we cannot carry it', at: at + 3, asked: 0 },
      { id: 'n5', tool: 'chat', subject: 'paid ads', reason: 'they did not pay back', at: at + 4, asked: 0 },
    ];
    await writeFile(join(workspace, 'said-no.json'), JSON.stringify({ entries }));
    const deps = stubDeps(workspace, ROOT);
    const part = (await saidno.install(deps)) as Installed;
    const roomId = (await deps.store.loadStage()).rooms[0].id;
    const query = 'Exact recall: what was your day-one call? What kill line did you set then? What is today\'s number against it? And everything I said no to, with my reasons.';
    await deps.seams.run('turn:before', { roomId, source: 'chat', query, messages: [] });
    const reply = { text: 'Day one: keep going.\nEverything you said no to, with your reasons: None on record.', tools: [], provider: 'fake', model: 'fake', usage: { inputTokens: 0, outputTokens: 0 }, stopped: false } as never;
    const out = await deps.seams.run('turn:reply', { roomId, query, reply });
    expect(out.reply.text).not.toContain('None on record');
    expect(out.reply.text).toContain('Day one: keep going.');
    expect(out.reply.text).toContain('by the record (5):');
    for (const one of entries) expect(out.reply.text).toContain(one.subject);
    expect(out.reply.text).toContain('they did not pay back');
    await part.close?.();
  });
});
