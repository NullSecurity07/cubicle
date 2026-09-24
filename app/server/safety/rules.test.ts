import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Attention } from '../../shared/model.ts';
import { reachOf } from '../../shared/safety.ts';
import { createRules } from './rules.ts';
import { overdue, WAITED_TOO_LONG } from './waiting.ts';

const at = new Date('2026-09-20T09:00:00').getTime();
const where = async () => join(await mkdtemp(join(tmpdir(), 'safety-')), 'approvals.json');
const email = (to: string) => ({ to, subject: 'Hello', body: 'Hi' });

describe('always allow', () => {
  it('remembers one person, one tool and the one address it was given', async () => {
    const rules = createRules(await where(), () => at);
    const made = await rules.remember({ roomId: 'marketing', who: 'Maya', tool: 'send_email', args: email('alex@example.com') });
    expect(made).toMatchObject({ roomId: 'marketing', who: 'Maya', tool: 'send_email', reach: 'alex@example.com', label: 'emails to alex@example.com' });
    expect(await rules.allows('marketing', 'send_email', email('alex@example.com'))).toBe(true);
    // Another address, another person, another tool: each one is still the founder's to answer.
    expect(await rules.allows('marketing', 'send_email', email('sam@example.com'))).toBe(false);
    expect(await rules.allows('build', 'send_email', email('alex@example.com'))).toBe(false);
    expect(await rules.allows('marketing', 'browse', { action: 'click', ref: 'e12' })).toBe(false);
  });

  it('is a plain file the founder can read, and every rule can be taken back', async () => {
    const path = await where();
    const rules = createRules(path, () => at);
    const made = (await rules.remember({ roomId: 'marketing', who: 'Maya', tool: 'browse', args: { action: 'open', url: 'https://mail.example.com/inbox' } }))!;
    expect(made.label).toBe('steps on mail.example.com');
    await rules.settled();
    expect(JSON.parse(await readFile(path, 'utf8')).rules).toHaveLength(1);
    // Saying it twice is still one rule.
    await rules.remember({ roomId: 'marketing', who: 'Maya', tool: 'browse', args: { action: 'open', url: 'https://mail.example.com/drafts' } });
    expect(await rules.list()).toHaveLength(1);
    await rules.forget(made.id);
    expect(await rules.list()).toEqual([]);
    await expect(rules.forget(made.id)).rejects.toThrow('not there any more');
  });

  it('is never offered for the three that are always their own decision, or where nothing says how far the call goes', () => {
    for (const tool of ['run_code', 'code_task', 'code_reply', 'delegate_task']) expect(reachOf(tool, { code: 'print(1)' })).toBeNull();
    expect(reachOf('browse', { action: 'click', ref: 'e12' })).toBeNull();
    expect(reachOf('send_email', { subject: 'no address' })).toBeNull();
    expect(reachOf('send_email', { to: 'alex@example.com, sam@example.com' })).toMatchObject({ label: 'emails to those 2 addresses' });
  });
});

describe('a question nobody answers', () => {
  const waiting = (id: string, ago: number, kind: Attention['kind'] = 'run-approval'): Attention =>
    ({ id: `approval:${id}`, kind, title: 'Send this email?', at: at - ago, event: { id, name: 'send_email', args: {}, waiting: true } });

  it('is overdue after half a day, and only in a background run', () => {
    const list = [waiting('a', WAITED_TOO_LONG + 60_000), waiting('b', 3_600_000), waiting('c', WAITED_TOO_LONG + 60_000, 'approval'), { ...waiting('d', WAITED_TOO_LONG + 1), lapsed: true }];
    expect(overdue(list, at).map((one) => one.event!.id)).toEqual(['a']);
  });
});
