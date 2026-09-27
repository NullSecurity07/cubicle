import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedStage } from '../shared/model.ts';
import { buildMessages } from './prompt.ts';
import { withImages, type ModelClient } from './providers.ts';
import { route } from './router.ts';
import { createStore } from './store.ts';
import { createUsage } from './usage.ts';

const say = (id: string, role: 'user' | 'assistant', text: string) => ({ id, role, text, at: 1 });

describe('chat edits', () => {
  it('takes out one message, or one and all after it, and keeps what was taken in trash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cut-'));
    const store = createStore(dir);
    for (const [id, role] of [['a', 'user'], ['b', 'assistant'], ['c', 'user'], ['d', 'assistant']] as const) await store.appendChat('build', say(id, role, id));
    expect((await store.cutChat('build', 'b', false)).map((one) => one.id)).toEqual(['a', 'c', 'd']);
    expect((await store.cutChat('build', 'c', true)).map((one) => one.id)).toEqual(['a']);
    await expect(store.cutChat('build', 'zzz', true)).rejects.toThrow(/unknown message/);
    const trash = (await readdir(join(dir, 'trash'))).filter((name) => name.includes('build-messages'));
    expect(trash).toHaveLength(2);
    expect(JSON.parse(await readFile(join(dir, 'trash', trash.sort()[1]), 'utf8')).map((one: { id: string }) => one.id)).toEqual(['c', 'd']);
  });

  it('stores an upload under a safe name that cannot leave the uploads folder', async () => {
    const store = createStore(await mkdtemp(join(tmpdir(), 'up-')));
    const path = await store.saveUpload('../../etc/pass wd?.CSV', Buffer.from('a,b\n1,2'));
    expect(path).toMatch(/^uploads\/[a-z0-9]+-etc-pass-wd-.CSV$/);
    expect((await store.readFileBytes(path))!.toString()).toBe('a,b\n1,2');
    expect(await store.readFileBytes('../stage.json').catch(() => 'refused')).toBe('refused');
  });
});

describe('attachments in the prompt', () => {
  const history = [{ ...say('u', 'user', 'What is in these?'), attachments: [{ path: 'uploads/1-data.csv', type: 'text/csv', size: 7 }, { path: 'uploads/2-logo.png', type: 'image/png', size: 9 }, { path: 'uploads/3-deck.pdf', type: 'application/pdf', size: 99 }] }];
  const attached = { texts: { 'uploads/1-data.csv': 'a,b\n1,2' }, images: { 'uploads/2-logo.png': 'data:image/png;base64,AAAA' } };

  it('inlines text files, carries pictures as pictures, and names what it cannot read', () => {
    const last = buildMessages(seedStage, 'build', {}, history, [], {}, undefined, attached).at(-1)!;
    expect(last.content).toContain('[Attached file uploads/1-data.csv]\na,b\n1,2');
    expect(last.content).toContain('uploads/3-deck.pdf (application/pdf, 99 bytes) is in the shared files folder');
    expect(last.role === 'user' && last.images).toEqual([{ name: 'uploads/2-logo.png', url: 'data:image/png;base64,AAAA' }]);
  });

  it('gives a seeing model the picture and tells a blind one that there was one', () => {
    const messages = buildMessages(seedStage, 'build', {}, history, [], {}, undefined, attached);
    const seen = withImages(messages, true).at(-1) as { content: { type: string }[] };
    expect(seen.content.map((part) => part.type)).toEqual(['text', 'image_url']);
    const blind = withImages(messages, false).at(-1) as { content: string; images?: unknown };
    expect(blind.content).toContain('cannot see images');
    expect(blind.images).toBeUndefined();
  });

  it('sends a turn with a picture to a model that can see', () => {
    const client = (name: string, vision = false): ModelClient => ({ name, model: name, maxPromptChars: 1e6, tools: true, vision, limits: {}, step: async () => ({ text: '', calls: [] }) });
    // Two models level in the shared order, so only the picture moves the one that can see ahead.
    const clients = [client('vercel'), client('cloudflare', true)];
    expect(route(clients, createUsage(null), { promptChars: 10, tools: true, vision: true }).order.map((one) => one.name)).toEqual(['cloudflare', 'vercel']);
    expect(route(clients, createUsage(null), { promptChars: 10, tools: true }).order[0].name).toBe('vercel');
    expect(route(clients, createUsage(null), { promptChars: 10, tools: true, vision: true }).notice).toBeUndefined();
  });
});
