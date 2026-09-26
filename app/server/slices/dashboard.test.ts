import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backupLate, type Dashboard } from '../../shared/dashboard.ts';
import { seedStage, type Attention, type Stage, type Task } from '../../shared/model.ts';
import { createBoards } from '../boards.ts';
import { createDecisions } from '../decisions.ts';
import { hub } from '../events.ts';
import { copyBuiltIns, createFrameworks } from '../frameworks/store.ts';
import { createLibrary } from '../library/notes.ts';
import type { Deps } from '../install.ts';
import { fakeClient, type ModelClient } from '../providers.ts';
import { createSkills } from '../skills.ts';
import { createStore } from '../store.ts';
import { createUsage } from '../usage.ts';
import slice, { fileCache, localDay, readTeams } from './dashboard.ts';

const root = resolve(import.meta.dirname, '../../..');
const NOW = Date.now();
const HOUR = 3_600_000;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); hub.say = () => {}; vi.unstubAllEnvs(); });

// A workspace with a little of everything the dashboard reads: a board with one task running and one due, a leads
// card, a watched page that changed, a proposed decision, a reply waiting, a fortnight of turns, a picture and a film.
async function setup() {
  const workspace = await mkdtemp(join(tmpdir(), 'dashboard-slice-'));
  const store = createStore(workspace);
  const stage: Stage = {
    ...structuredClone(seedStage),
    rooms: [...seedStage.rooms.map((room) => ({ ...room })), { id: 'judge', name: 'Bruno', role: 'Verdict judge', accent: '#e6a93c', brief: '', x: 0, y: 0, w: 380, h: 440, framework: { id: 'startup-evaluation', key: 'judge' } }],
    cards: [
      { kind: 'board', id: 'board-1', x: 0, y: 0, w: 600, h: 400 },
      { kind: 'leads', id: 'leads-1', x: 0, y: 0, w: 600, h: 400 },
      { kind: 'imagegen', id: 'pics', x: 0, y: 0, w: 300, h: 300 },
      { kind: 'videogen', id: 'films', x: 0, y: 0, w: 300, h: 300 },
    ],
  };
  await store.saveStage(stage);
  const boards = createBoards(workspace, () => NOW);
  const running = await boards.add('board-1', { title: 'Scan the forums' });
  await boards.update('board-1', running.id, (task: Task) => { task.assignee = 'marketing'; task.run = { state: 'running', startedAt: NOW - HOUR, log: [] }; });
  const due = await boards.add('board-1', { title: 'Morning digest' });
  await boards.update('board-1', due.id, (task: Task) => { task.repeat = { every: 'day', time: '23:58' }; task.nextRun = NOW + 60_000; });
  await boards.settled();

  await mkdir(join(workspace, 'leads'), { recursive: true });
  await writeFile(join(workspace, 'leads', 'leads-1.json'), JSON.stringify([
    { id: 'lead-a', person: { name: 'Ada' }, company: { name: 'Engines' }, stage: 'new', notes: [], source: 'founder', addedAt: NOW - 3 * 86_400_000, updatedAt: NOW - 3 * 86_400_000 },
    { id: 'lead-b', person: { name: 'Grace' }, company: { name: 'Cobol' }, stage: 'meeting', notes: [], source: 'founder', addedAt: NOW - HOUR, updatedAt: NOW - HOUR },
  ]));
  await mkdir(join(workspace, 'watch'), { recursive: true });
  await writeFile(join(workspace, 'watch', 'marketing.json'), JSON.stringify([
    { id: 'w-1', url: 'https://rival.example/pricing', what: 'prices', roomId: 'marketing', title: 'Rival pricing', hash: 'x', text: '', addedAt: NOW - 9 * 86_400_000, checkedAt: NOW, changedAt: NOW - 2 * HOUR, diff: '+ Pro is now $29\n− Pro was $19' },
  ]));
  await mkdir(join(workspace, 'rooms'), { recursive: true });
  await writeFile(join(workspace, 'rooms', 'build.json'), JSON.stringify([
    { id: 'm1', role: 'user', text: 'How long will it take?', at: NOW - 2 * HOUR },
    { id: 'm2', role: 'assistant', text: 'About two weeks.', at: NOW - HOUR },
  ]));
  await writeFile(join(workspace, 'rooms', 'marketing.memory.json'), JSON.stringify({ notes: `- 20 Sep · The launch is in October ${'(kept on its own)'}\n- 21 Sep · Price is 19\n- 22 Sep · Wants short copy (kept on its own)`, summary: '' }));

  const trace = join(workspace, '.index', 'trace');
  await mkdir(trace, { recursive: true });
  const line = (at: number, roomId: string, tokens: number, tools: string[]) => JSON.stringify({ at, roomId, source: 'chat', provider: 'fake', model: 'fake-1', usage: { input: tokens / 2, output: tokens / 2 }, tools: tools.map((name) => ({ name, ok: true })), stopped: false });
  await writeFile(join(trace, `${localDay(NOW)}.jsonl`), `${line(NOW, 'marketing', 1000, ['web_search', 'remember'])}\n${line(NOW, 'build', 400, [])}\n`);
  await writeFile(join(trace, `${localDay(NOW - 3 * 86_400_000)}.jsonl`), `${line(NOW, 'marketing', 600, ['web_search'])}\nnot json\n`);
  await writeFile(join(trace, `${localDay(NOW - 10 * 86_400_000)}.jsonl`), `${line(NOW, 'build', 5000, ['run_code'])}\n`);

  await mkdir(join(workspace, 'media'), { recursive: true });
  await writeFile(join(workspace, 'media', 'pics.json'), JSON.stringify({ state: 'idle', log: [], results: [
    { path: 'media/poster.png', prompt: 'A calm poster of a lighthouse', at: NOW - HOUR },
    { path: 'media/old.png', prompt: 'Last month', at: NOW - 30 * 86_400_000 },
  ] }));
  await writeFile(join(workspace, 'media', 'films.json'), JSON.stringify({ state: 'idle', log: [], results: [
    { path: 'media/launch.mp4', prompt: 'A launch film', at: NOW - 2 * HOUR, poster: 'media/launch.jpg', noncommercial: true, credits: 'media/launch.credits.txt', music: { title: 'Morning', by: 'Kevin', licence: 'CC0', source: 'x' } },
  ] }));

  // The teams that come with the app, as the frameworks slice copies them in on a first start.
  await copyBuiltIns(resolve(root, 'app/frameworks'), createFrameworks(workspace), createLibrary(workspace));

  const decisions = createDecisions(workspace);
  await decisions.propose({ title: 'Which price?', options: ['19', '29'], proposedBy: 'Maya' });
  const needs: Attention[] = [{ id: 'page-changed:w-1', kind: 'page-changed', title: 'The page Rival pricing changed', at: NOW - 2 * HOUR, roomId: 'marketing', who: 'Maya' }];
  const attention = { list: async () => needs, watch: () => () => {} };
  const usage = createUsage(null);
  usage.record('fake', { input: 300, output: 200 });
  const limited: ModelClient = { ...fakeClient, name: 'groq', model: 'gpt-oss', limits: { rpd: 1000, tpd: 200_000 } };
  const local: ModelClient = { ...fakeClient, name: 'ollama', model: 'qwen2.5:7b', limits: {} };
  const answered: { status: number; body: unknown }[] = [];
  const deps = {
    workspace, root, fake: true, store, boards, decisions, attention, usage, clients: [fakeClient, limited, local], skills: createSkills(workspace),
    json: (_res: ServerResponse, status: number, body: unknown) => { answered.push({ status, body }); },
  } as unknown as Deps;
  const part = await slice.install(deps);
  closers.push(() => part.close!());
  const get = async (path = '/api/dashboard') => {
    const handled = await part.route!({ method: 'GET' } as IncomingMessage, {} as ServerResponse, path);
    return { handled, body: answered.at(-1)?.body as Dashboard };
  };
  return { workspace, get, running, due };
}

describe('the dashboard', () => {
  it('says when the newest backup was made, from the folder backups go to now', async () => {
    expect((await (await setup()).get()).body.backup).toEqual({ at: null, dir: expect.stringMatching(/backups$/), writable: true });
    const { get, workspace } = await setup();
    await mkdir(join(workspace, 'backups'), { recursive: true });
    await writeFile(join(workspace, 'backups', 'cubicle-2026-09-24-0900.tar.gz'), 'x');
    await utimes(join(workspace, 'backups', 'cubicle-2026-09-24-0900.tar.gz'), NOW / 1000, NOW / 1000);
    expect((await get()).body.backup).toEqual({ at: NOW, dir: join(workspace, 'backups'), writable: true });
  });

  it('says so when the backup folder cannot be written to', async () => {
    const away = await mkdtemp(join(tmpdir(), 'dashboard-away-'));
    await writeFile(join(away, 'file'), 'x');
    vi.stubEnv('STAGE_BACKUP_DIR', join(away, 'file', 'backups'));
    const { get } = await setup();
    expect((await get()).body.backup).toMatchObject({ writable: false });
  });

  it('counts a backup late after a day, when there is none, or when its folder cannot be written to', () => {
    expect(backupLate({ at: NOW - HOUR, dir: '/b', writable: true }, NOW)).toBe(false);
    expect(backupLate({ at: NOW - 25 * HOUR, dir: '/b', writable: true }, NOW)).toBe(true);
    expect(backupLate({ at: null, dir: '/b', writable: true }, NOW)).toBe(true);
    expect(backupLate({ at: NOW - HOUR, dir: '/b', writable: false }, NOW)).toBe(true);
  });

  it('asks its Backup health row again once a backup lands, whatever the health it already held', { timeout: 60_000 }, async () => {
    const { get, workspace } = await setup();
    const row = async () => (await get()).body.health.find((one) => one.name === 'Backup');
    await expect.poll(row, { timeout: 30_000 }).toMatchObject({ ok: false });
    await mkdir(join(workspace, 'backups'), { recursive: true });
    await writeFile(join(workspace, 'backups', 'cubicle-2026-09-25-0900.tar.gz'), 'x');
    await expect.poll(async () => (await row())?.detail, { timeout: 30_000, interval: 200 }).toMatch(/1 kept in .*the newest made/);
  });

  it('reads the founder\'s day, each row carrying where it lives', async () => {
    const { get, running, due } = await setup();
    const { handled, body } = await get();
    expect(handled).toBe(true);
    expect(body.day.needsYou).toEqual([expect.objectContaining({ id: 'page-changed:w-1', roomId: 'marketing', who: 'Maya' })]);
    expect(body.day.tasksRunning).toEqual([expect.objectContaining({ id: running.id, cardId: 'board-1', who: 'Maya', roomId: 'marketing', state: 'running' })]);
    expect(body.day.tasksDue).toEqual([expect.objectContaining({ id: due.id, cardId: 'board-1' })]);
    expect(body.day.watchesChanged).toEqual([expect.objectContaining({ id: 'w-1', roomId: 'marketing', who: 'Maya', diff: '+ Pro is now $29' })]);
    expect(body.day.leadsByStage).toEqual({ new: 1, fit: 0, contacted: 0, replied: 0, meeting: 1, customer: 0, passed: 0 });
    expect(body.day.leadsChangedToday).toBe(1);
    expect(body.day.leadsCardId).toBe('leads-1');
    expect(body.day.decisionsPending).toEqual([expect.objectContaining({ title: 'Which price?', who: 'Maya' })]);
    expect(body.day.replies).toEqual([expect.objectContaining({ roomId: 'build', name: 'Dev' })]);
    expect(body.day.unreadMessages).toBe(1);
  });

  it('adds up a fortnight of turns by day, a week by person and by tool, and today by provider', async () => {
    const { body } = (await (await setup()).get());
    expect(body.tokens.byDay).toHaveLength(14);
    expect(body.tokens.byDay.at(-1)).toEqual({ day: localDay(NOW), tokens: 1400 });
    expect(body.tokens.byDay.reduce((sum, one) => sum + one.tokens, 0)).toBe(7000);
    // The run_code turn was ten days ago: in the chart, not in the week.
    expect(body.tokens.byPerson).toEqual([{ name: 'Maya', roomId: 'marketing', tokens7d: 1600, turns7d: 2 }, { name: 'Dev', roomId: 'build', tokens7d: 400, turns7d: 1 }]);
    expect(body.tokens.byTool).toEqual([{ name: 'web_search', calls7d: 2, tokens7d: 1100 }, { name: 'remember', calls7d: 1, tokens7d: 500 }]);
    const fake = body.tokens.byProvider.find((one) => one.name === 'fake')!;
    expect(fake.usedToday).toEqual({ requests: 1, tokens: 500 });
    expect(fake.window).toBe('resets at midnight UTC');
    expect(body.tokens.byProvider.find((one) => one.name === 'ollama')!.window).toBe('no daily limit');
    const groq = body.tokens.byProvider.find((one) => one.name === 'groq')!;
    expect(groq).toMatchObject({ limits: { rpd: 1000, tpd: 200_000 }, leftPct: 100, window: 'resets at midnight UTC' });
  });

  it('lists the teams, placed or not, the skills, what was kept unasked, and this week\'s media', async () => {
    const { body } = (await (await setup()).get());
    const evaluation = body.teams.find((one) => one.id === 'startup-evaluation')!;
    expect(evaluation).toMatchObject({ builtIn: true, placed: true, placedRoomId: 'judge' });
    expect(body.teams[0].id).toBe('startup-evaluation');
    expect(body.teams.filter((one) => !one.placed).length).toBeGreaterThan(0);
    expect(body.skills.keptOnItsOwn).toBe(2);
    expect(body.skills.keptBy).toEqual([{ roomId: 'marketing', name: 'Maya', count: 2 }]);
    expect(body.media.map((one) => one.kind)).toEqual(['picture', 'film']);
    expect(body.media[1]).toMatchObject({ file: 'media/launch.mp4', poster: 'media/launch.jpg', cardId: 'films', nonCommercial: true, creditsFile: 'media/launch.credits.txt', credits: 'Music: Morning by Kevin (CC0)' });
  });

  it('answers from its copy, and tells the window when something under it moves', async () => {
    const said: unknown[] = [];
    hub.say = (channel, data) => said.push({ channel, data });
    const { get, workspace } = await setup();
    await get();
    const started = performance.now();
    await get();
    expect(performance.now() - started).toBeLessThan(150);
    await writeFile(join(workspace, 'leads', 'leads-1.json'), '[]');
    const told = () => said.filter((one) => (one as { channel: string }).channel === 'dashboard');
    // Two seconds after things settle; the health check finishing in the background may push that back a little.
    for (let waited = 0; !told().length && waited < 8_000; waited += 200) await new Promise((done) => { setTimeout(done, 200); });
    expect(told().length).toBeGreaterThan(0);
    expect(told()[0]).toEqual({ channel: 'dashboard', data: { dashboard: true } });
    expect((await get()).body.day.leadsByStage.new).toBe(0);
  }, 15_000);

  it('leaves every other path alone', async () => {
    expect((await (await setup()).get('/api/dashboards')).handled).toBe(false);
  });
});

describe('the file cache', () => {
  it('reads a file again only once it has been written again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dashboard-cache-'));
    const read = fileCache();
    let parsed = 0;
    const parse = (text: string) => { parsed += 1; return JSON.parse(text) as number[]; };
    await writeFile(join(dir, 'a.json'), '[1]');
    expect(await read(join(dir, 'a.json'), [], parse)).toEqual([1]);
    expect(await read(join(dir, 'a.json'), [], parse)).toEqual([1]);
    expect(parsed).toBe(1);
    await writeFile(join(dir, 'a.json'), '[1,2]');
    expect(await read(join(dir, 'a.json'), [], parse)).toEqual([1, 2]);
    expect(await read(join(dir, 'missing.json'), ['none'])).toEqual(['none']);
    await writeFile(join(dir, 'bad.json'), '{');
    expect(await read(join(dir, 'bad.json'), 'fallback')).toBe('fallback');
  });
});

describe('readTeams', () => {
  it('reads each framework and only its newest run, through the file cache', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'teams-'));
    const at = join(workspace, 'frameworks', 'pitch-team');
    await mkdir(join(at, 'runs'), { recursive: true });
    await writeFile(join(at, 'framework.json'), JSON.stringify({ name: 'Pitch team', scorecard: { mean: 0.5, at: 1, cases: 2 } }));
    const run = (when: number, mean: number) => ({ at: when, mean, cases: [{ id: 'a', scores: { x: mean } }] });
    await writeFile(join(at, 'runs', '2026-09-01T10-00-00-000Z.json'), JSON.stringify(run(1, 0.4)));
    await writeFile(join(at, 'runs', '2026-09-20T10-00-00-000Z.json'), JSON.stringify(run(2, 0.8)));
    const stage = { rooms: [{ id: 'r1', name: 'Ana', framework: { id: 'pitch-team' } }] } as unknown as Stage;
    const read = fileCache();
    const [team] = await readTeams(workspace, root, stage, read);
    expect(team).toMatchObject({ id: 'pitch-team', name: 'Pitch team', builtIn: false, placed: true, placedRoomId: 'r1', lastEval: { mean: 0.8, at: 2, of: 1 } });
  });
});
