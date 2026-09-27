import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Stage } from '../shared/model.ts';

// The server alone, the way the service runs it: no window, no page, no live feed, nobody asking it anything. What
// the founder counts on happening while they are away has to happen off the half-minute tick by itself.

const TOKEN = 'headless-token';
const free = () => new Promise<number>((done) => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); });
});
// A zone where it is the middle of the day now, so the morning note is due whatever the hour this check runs at.
// Etc/GMT-3 is three hours ahead of UTC: the sign is the other way round from what it looks like.
const midday = () => {
  const ahead = 13 - new Date().getUTCHours();
  return ahead === 0 ? 'UTC' : `Etc/GMT${ahead > 0 ? '-' : '+'}${Math.abs(ahead)}`;
};
async function until<T>(get: () => T | Promise<T>, right: (value: T) => boolean, what: string, wait = 60_000): Promise<T> {
  const end = Date.now() + wait;
  for (;;) {
    const value = await get();
    if (right(value)) return value;
    if (Date.now() > end) throw new Error(`${what} never happened`);
    await new Promise((done) => { setTimeout(done, 200); });
  }
}
const read = <T>(path: string, fallback: T): T => { try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return fallback; } };

const room = (id: string, name: string, extra: object = {}) => ({ id, name, role: 'Partner', accent: '#fff', brief: '', x: 0, y: 0, w: 320, h: 240, ...extra });

let server: ChildProcess;
let port = 0;
let dir = '';
let said = '';
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'headless-'));
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const stage: Stage = { rooms: [room('pat', 'Pat', { partner: true })], docs: [], wires: [], cards: [] };
  writeFileSync(join(workspace, 'stage.json'), JSON.stringify(stage));
  // The partner has been here since long ago, so today's note is due; one bet's check day has long come.
  writeFileSync(join(workspace, 'partner.json'), JSON.stringify({ decided: [], plans: [], partnerSince: '2000-01-01' }));
  writeFileSync(join(workspace, 'bets.json'), JSON.stringify({ bets: [{ id: 'b1', made: '2000-01-01', what: 'Cold emails to 50 dentists', hypothesis: 'they book demos', metric: 'demos', target: 5, checkDate: '2000-01-08', status: 'open', at: 1 }] }));
  // A phone paired and switched on (Telegram is the fake one, under the fake model), its daily note due since midnight.
  writeFileSync(join(workspace, 'reach.json'), JSON.stringify({ on: true, token: 'fake-token', paired: [{ chatId: 1, name: 'Founder', at: 1 }], updates: { on: true, finished: true, stuck: true, digest: true, at: '00:00' } }));
  port = await free();
  server = spawn(process.execPath, ['server/index.ts'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: {
      PATH: process.env.PATH, HOME: dir, TZ: midday(),
      STAGE_FAKE_MODEL: '1', STAGE_API_PORT: String(port), STAGE_PORT: String(await free()), STAGE_API_TOKEN: TOKEN,
      STAGE_WORKSPACE: workspace, STAGE_BACKUP_DIR: join(dir, 'backups'), STAGE_AUTO_BACKUP: '1', STAGE_PARTNER_MORNING: '1',
      STAGE_TICK_MS: '300', STAGE_NO_LOCAL: '1', STAGE_NO_READER: '1', TELEGRAM_BOT_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout!.on('data', (chunk) => { said += chunk; });
  server.stderr!.on('data', (chunk) => { said += chunk; });
  await until(() => said, (text) => text.includes('stage api on'), 'the server starting');
}, 70_000);
// The server is gone before its folder is, backup and all: nothing is left behind in the temp folder.
afterAll(async () => {
  if (server && server.exitCode === null) {
    const gone = new Promise((done) => { server.once('exit', done); });
    server.kill('SIGTERM');
    await gone;
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
}, 20_000);

const ask = async (path: string, body?: unknown) => (await fetch(`http://127.0.0.1:${port}${path}`, {
  method: body ? 'POST' : 'GET', headers: { 'x-stage-token': TOKEN, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
})).json();
type Posted = { chatId: number; text: string; messageId: number };

describe('the server with no window open', () => {
  it('writes the partner\'s morning note by itself', async () => {
    const state = await until(() => read<{ morning?: { things: string[]; roomId: string } }>(join(dir, 'workspace', 'partner.json'), {}), (one) => !!one.morning, `the morning note (${said.slice(-400)})`);
    expect(state.morning!.roomId).toBe('pat');
    expect(state.morning!.things.length).toBeGreaterThan(0);
  }, 70_000);

  it('makes the daily backup by itself', async () => {
    await until(() => { try { return readdirSync(join(dir, 'backups')); } catch { return []; } }, (files) => files.some((one) => /^cubicle-.*\.tar\.gz$/.test(one)), 'the backup');
  }, 70_000);

  it('has the bet that is due waiting in Needs you, and the morning note beside it', async () => {
    const list = await until(async () => await ask('/api/attention') as { kind: string }[], (items) => items.some((one) => one.kind === 'morning-note'), 'the morning note in Needs you');
    expect(list.map((one) => one.kind)).toContain('bet-check');
  }, 70_000);

  it('sends the morning note to the phone as one message, and a reply to it reaches the partner', async () => {
    const posted = await until(async () => (await ask('/api/reach/telegram') as { posted: Posted[] }).posted, (list) => list.some((one) => one.text.includes('Morning')), 'the morning note on the phone');
    const notes = posted.filter((one) => one.text.includes('Morning'));
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toContain('Pat');
    await ask('/api/reach/telegram', { chatId: 1, text: 'Which move first?', extra: { reply_to_message: { message_id: notes[0].messageId, chat: { id: 1 }, text: 'x' } } });
    const chat = await until(() => read<{ role: string; text: string }[] | { messages?: { role: string; text: string }[] }>(join(dir, 'workspace', 'rooms', 'pat.json'), []), (held) => JSON.stringify(held).includes('Which move first?'), 'the reply in the partner\'s room');
    expect(JSON.stringify(chat)).toContain('Which move first?');
  }, 70_000);
});
