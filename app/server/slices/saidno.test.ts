import { mkdtemp } from 'node:fs/promises';
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
    for (const subject of ['discounts', 'count the trials as customers', 'promise a feature we have not shipped']) await saidNoFor(workspace).record({ tool: 'chat', subject, who: 'Sam' });
    const query = 'What have I said no to?';
    await deps.seams.run('turn:before', { roomId, source: 'chat', query, messages: [] });
    const reply = { text: 'You said no to discounts.', tools: [], provider: 'fake', model: 'fake', usage: { inputTokens: 0, outputTokens: 0 }, stopped: false } as never;
    const out = await deps.seams.run('turn:reply', { roomId, query, reply });
    expect(out.reply.text).toMatch(/^What you said no to in the last 30 days, by the record \(3\):/);
    for (const one of ['discounts', 'count the trials as customers', 'promise a feature we have not shipped']) expect(out.reply.text).toContain(one);
    await part.close?.();
  });
});
