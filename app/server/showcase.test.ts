import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatMessage, Stage } from '../shared/model.ts';

// The showcase company in app/showcase is a workspace the app is started on (`pnpm showcase`). Every file in it has
// to parse, it must hold nothing it must never ship, and it must still show the week the owner shows people.
const root = resolve(import.meta.dirname, '..', 'showcase');
const read = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : [path];
});

describe('the showcase company', () => {
  const stage = read('stage.json') as Stage;
  const cards = stage.cards ?? [];

  it('parses: the stage and every book in it', () => {
    for (const path of files(root).filter((one) => one.endsWith('.json'))) expect(() => JSON.parse(readFileSync(path, 'utf8')), path).not.toThrow();
    for (const path of files(root).filter((one) => one.endsWith('.jsonl'))) {
      for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) expect(() => JSON.parse(line), path).not.toThrow();
    }
  });

  it('holds no secrets, browser sessions, usage book or file over 5 MB', () => {
    for (const path of files(root)) {
      const name = path.slice(root.length + 1);
      expect(name).not.toMatch(/(^|\/)(keys\.json|usage\.json|\.env|browsers?\/|chrome-profile|profiles?\/)/);
      expect(statSync(path).size, name).toBeLessThanOrEqual(5 * 1024 * 1024);
    }
  });

  it('has the partner, the eight people, and every thing on the stage wired and in its own place', () => {
    const names = stage.rooms.map((room) => room.name);
    expect(stage.rooms.find((room) => room.partner)?.name).toBe('Sam');
    for (const name of ['Maya', 'Dev', 'Rohan', 'Priya', 'Meera', 'Ananya', 'Vikram', 'Lena']) expect(names).toContain(name);
    const kinds = new Set(cards.map((card) => card.kind));
    for (const kind of ['board', 'metrics', 'runway', 'leads', 'competitor', 'survey', 'site', 'deck', 'note', 'link', 'image', 'imagegen', 'videogen']) expect(kinds).toContain(kind);
    const ids = new Set([...stage.rooms, ...stage.docs, ...cards].map((one) => one.id));
    for (const wire of stage.wires) { expect(ids.has(wire.from), wire.id).toBe(true); expect(ids.has(wire.to), wire.id).toBe(true); }
    const boxes = [...stage.rooms, ...stage.docs, ...cards];
    for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1)) {
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      expect(apart, `${a.id} overlaps ${b.id}`).toBe(true);
    }
  });

  it('holds the week: numbers, leads, decisions, bets, promises, a morning note, a board mid-flight', () => {
    const metrics = read('metrics/metrics.json');
    expect(Math.max(...metrics.metrics.map((one: { points: unknown[] }) => one.points.length))).toBe(12);
    expect(read('runway/runway.json').cash.amount).toBe(9800);
    expect(read('leads/leads.json')).toHaveLength(8);
    const decided = readdirSync(join(root, 'decisions')).filter((name) => name.endsWith('.md')).map((name) => readFileSync(join(root, 'decisions', name), 'utf8')).filter((text) => text.includes('status: decided'));
    expect(decided.length).toBeGreaterThanOrEqual(3);
    const partner = read('partner.json');
    const bets = partner.bets ?? read('bets.json').bets;
    expect(bets.filter((bet: { status: string }) => bet.status === 'open')).toHaveLength(2);
    const closed = bets.filter((bet: { status: string }) => bet.status === 'closed');
    expect(closed).toHaveLength(1);
    expect(closed[0].result.note.length).toBeGreaterThan(10);
    const promises = read('promises.json').promises as { status: string }[];
    expect(promises.filter((one) => one.status === 'open')).toHaveLength(1);
    expect(promises.filter((one) => one.status === 'done')).toHaveLength(1);
    expect(partner.morning?.things?.length).toBeGreaterThan(0);
    const boards = readdirSync(join(root, 'boards')).map((name) => read(`boards/${name}`));
    const tasks = boards.flatMap((board) => (Array.isArray(board) ? board : board.tasks ?? []) as { column: string }[]);
    expect(new Set(tasks.map((task) => task.column)).size).toBeGreaterThanOrEqual(2);
  });

  it('keeps real conversations with the model that said each reply', () => {
    const chats = readdirSync(join(root, 'rooms')).filter((name) => name.endsWith('.json')).map((name) => read(`rooms/${name}`) as ChatMessage[]);
    const replies = chats.flat().filter((message) => message.role === 'assistant');
    expect(replies.length).toBeGreaterThanOrEqual(10);
    for (const reply of replies) expect(reply.model, reply.text.slice(0, 60)).toBeTruthy();
  });

  it('has the picture it drew and the film or its poster', () => {
    const picture = read('media/image-studio.json');
    expect(existsSync(join(root, 'files', picture.results[0].path))).toBe(true);
    const film = read('media/film.json');
    const made = film.results[0];
    expect(existsSync(join(root, 'files', made.path)) || existsSync(join(root, 'files', made.poster))).toBe(true);
  });
});
