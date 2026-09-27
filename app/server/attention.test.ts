import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Lapsed } from '../shared/lapsed.ts';
import type { Attention } from '../shared/model.ts';
import { backupAttention, boardAttention, createAttention, damageAttention, doneAttention, keyAttention } from './attention.ts';
import { createDecisions, decisionAttention } from './decisions.ts';
import { betsBook } from './partner/bets.ts';
import { createUsage } from './usage.ts';
import { createBoards } from './boards.ts';
import { createStore } from './store.ts';

// Sunday 20 September 2026, noon where the machine is. Nothing here reads the real clock.
const NOON = new Date(2026, 8, 20, 12).getTime();
const waiting = (id: string): Attention => ({ id: `approval:${id}`, kind: 'approval', title: 'Send this email?', at: 1, roomId: 'marketing', who: 'Maya', event: { id, name: 'send_email', args: { to: 'a@b.co' }, waiting: true } });

describe('attention', () => {
  it('keeps everything raised in the first moment, when several ask before the file has been read', async () => {
    const attention = createAttention(await mkdtemp(join(tmpdir(), 'attention-')));
    await Promise.all([attention.raise(waiting('c1')), attention.list(), attention.raise(waiting('c2')), attention.list()]);
    expect((await attention.list()).map((one) => one.id).sort()).toEqual(['approval:c1', 'approval:c2']);
  });

  it('holds an approval while it waits and lets it go when the founder answers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'attention-'));
    const attention = createAttention(dir);
    const seen: number[] = [];
    attention.watch((list) => seen.push(list.length));
    await attention.raise(waiting('c1'));
    expect((await attention.list()).map((one) => one.id)).toEqual(['approval:c1']);
    await attention.clear('approval:c1');
    expect(await attention.list()).toEqual([]);
    expect(seen).toEqual([1, 0]);
  });

  it('an approval whose turn ended with the app comes back as lapsed, until the founder lets it go', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'attention-'));
    const before = createAttention(dir);
    await before.raise(waiting('c2'));
    await before.settled();
    expect(JSON.parse(await readFile(join(dir, 'attention.json'), 'utf8')).open).toHaveLength(1);

    // A pinned clock, because a lapsed approval is let go once it is a day old and this one says it was raised at 1.
    const after = createAttention(dir, () => 2);
    const [entry] = (await after.list()) as Lapsed[];
    expect(entry).toMatchObject({ id: 'approval:c2', lapsed: true, who: 'Maya' });
    expect(entry.event).toBeUndefined();
    // What it was for outlives the turn, in a few words: the tool by name, and the call without its body.
    expect(entry.tool).toBe('send_email');
    expect(entry.about).toBe('send email, to a@b.co');
    await after.dismiss('approval:c2');
    await after.settled();
    expect(await createAttention(dir, () => 2).list()).toEqual([]);
  });

  it('keeps what a lapsed approval was for through a second closing, and never keeps a secret', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'attention-'));
    const before = createAttention(dir);
    await before.raise({ ...waiting('c6'), event: { id: 'c6', name: 'send_email', args: { to: 'a@b.co', api_key: 'sk-live-1', body: 'Hello there' }, waiting: true } });
    await before.settled();

    const once = createAttention(dir, () => 2);
    // The first couple of arguments and no more, each cut short; the key was never one of them.
    expect(((await once.list()) as Lapsed[])[0].about).toBe('send email, to a@b.co, body Hello there');
    await once.raise({ ...waiting('c7'), at: 2 });
    await once.settled();
    // Closed again: the words kept the first time are still there, and no key ever was.
    const twice = (await createAttention(dir, () => 3).list()) as Lapsed[];
    expect(twice.map((one) => one.tool)).toEqual(['send_email', 'send_email']);
    expect(JSON.stringify(twice)).not.toContain('sk-live-1');
  });

  it('lets a lapsed approval go on its own after a day, and writes the file again without it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'attention-'));
    const before = createAttention(dir, () => NOON);
    await before.raise({ ...waiting('c8'), at: NOON });
    await before.settled();

    const nearly = createAttention(dir, () => NOON + 86_399_000);
    expect(await nearly.list()).toHaveLength(1);
    const later = createAttention(dir, () => NOON + 86_400_001);
    const told: number[] = [];
    later.watch((list) => told.push(list.length));
    expect(await later.list()).toEqual([]);
    await later.settled();
    expect(JSON.parse(await readFile(join(dir, 'attention.json'), 'utf8')).open).toEqual([]);
    // The bell hears it go at once, rather than at the next thing that happens to change.
    expect(told).toEqual([0]);
  });

  it('adds what other parts of the app report, newest first, and hides what the founder dismissed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'attention-'));
    const attention = createAttention(dir);
    let failedAt = 5;
    attention.source(async () => [
      { id: 'proposed:b1:t1', kind: 'proposed-task', title: 'Draft the launch post', at: 3, cardId: 'b1', taskId: 't1', who: 'Maya' },
      { id: `run-failed:t2:${failedAt}`, kind: 'run-failed', title: 'Weekly numbers', at: failedAt, cardId: 'b1', taskId: 't2' },
    ]);
    await attention.raise(waiting('c3'));
    expect((await attention.list()).map((one) => one.id)).toEqual(['run-failed:t2:5', 'proposed:b1:t1', 'approval:c3']);

    await attention.dismiss('run-failed:t2:5');
    expect((await attention.list()).map((one) => one.kind)).toEqual(['proposed-task', 'approval']);
    // The same task failing again is a new thing to look at.
    failedAt = 9;
    expect((await attention.list())[0].id).toBe('run-failed:t2:9');
    // A proposal cannot be waved away; it goes when the founder accepts or declines it on the board.
    await expect(attention.dismiss('proposed:b1:t1')).rejects.toThrow();
  });

  it('a source that breaks does not take the list down with it', async () => {
    const attention = createAttention(await mkdtemp(join(tmpdir(), 'attention-')));
    attention.source(async () => { throw new Error('board file is broken'); });
    await attention.raise(waiting('c4'));
    expect(await attention.list()).toHaveLength(1);
  });

  it('reads proposals, failed runs and missed repeats straight from the boards', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'attention-'));
    const store = createStore(dir); const boards = createBoards(dir);
    const stage = await store.loadStage();
    await store.saveStage({ ...stage, cards: [{ id: 'b1', kind: 'board', x: 0, y: 0, w: 900, h: 400 }] });
    const attention = createAttention(dir);
    attention.source(boardAttention(store, boards));
    const told: number[] = [];
    attention.watch((list) => told.push(list.length));
    boards.onChange(() => { void attention.refresh(); });

    const proposed = await boards.add('b1', { title: 'Draft the launch post', column: 'proposed', proposedBy: 'Maya' });
    const failing = await boards.add('b1', { title: 'Weekly numbers' });
    await boards.update('b1', failing.id, (task) => { task.assignee = 'build'; task.run = { state: 'failed', startedAt: 7, finishedAt: 8, log: ['Dev started', 'failed: no provider answered'] }; });
    const late = await boards.add('b1', { title: 'Morning digest' });
    await boards.update('b1', late.id, (task) => { task.missed = true; task.nextRun = 99; });

    // A task that could not even start waits for the founder too, with the reason it gave.
    const stuck = await boards.add('b1', { title: 'Nightly tidy-up' });
    await boards.update('b1', stuck.id, (task) => { task.run = { state: 'blocked', startedAt: 11, finishedAt: 11, log: ['did not start: the skill it names is switched off'], result: 'the skill it names is switched off' }; });

    const list = await attention.list();
    expect(list.map((one) => one.kind).sort()).toEqual(['missed', 'proposed-task', 'run-failed', 'run-failed']);
    expect(list.find((one) => one.taskId === stuck.id)).toMatchObject({ kind: 'run-failed', title: 'Nightly tidy-up', detail: 'the skill it names is switched off' });
    expect(list.find((one) => one.kind === 'proposed-task')).toMatchObject({ who: 'Maya', cardId: 'b1', taskId: proposed.id, title: 'Draft the launch post' });
    expect(list.find((one) => one.taskId === failing.id)).toMatchObject({ who: 'Dev', detail: 'no provider answered' });

    // The founder accepts the proposal on the board: it leaves the list by itself.
    await boards.change('b1', proposed.id, { column: 'todo' });
    expect((await attention.list()).map((one) => one.kind).sort()).toEqual(['missed', 'run-failed', 'run-failed']);
    await new Promise((done) => setTimeout(done, 20));
    expect(told.at(-1)).toBe(3);
    // A board that left the stage takes its entries with it.
    await store.saveStage({ ...(await store.loadStage()), cards: [] });
    expect(await attention.list()).toEqual([]);
  });

  it('does not show a cut-off task run twice: the board already reports it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'attention-'));
    const before = createAttention(dir);
    await before.raise({ ...waiting('c5'), kind: 'run-approval', cardId: 'b1', taskId: 't1' });
    await before.settled();
    expect(await createAttention(dir).list()).toEqual([]);
  });
});

describe('a key the provider refuses', () => {
  it('raises one item for one key however many models share it, and any of them answering clears it', async () => {
    const attention = createAttention(await mkdtemp(join(tmpdir(), 'attention-')));
    const usage = createUsage(null, () => NOON);
    keyAttention(usage, attention, () => NOON);
    const refused = Object.assign(new Error('Invalid API Key'), { status: 401 });
    for (const name of ['groq#2', 'groq-small#2', 'groq-qwen#2']) usage.failed(name, refused);
    usage.failed('groq', refused);
    await new Promise((settle) => setTimeout(settle, 20));
    expect((await attention.list()).map((one) => one.id).sort()).toEqual(['key-rejected:GROQ_API_KEY:1', 'key-rejected:GROQ_API_KEY:2']);
    usage.record('groq-small#2');
    await new Promise((settle) => setTimeout(settle, 20));
    expect((await attention.list()).map((one) => one.id)).toEqual(['key-rejected:GROQ_API_KEY:1']);
    // Refused again later: raised again.
    usage.failed('groq-qwen#2', refused);
    await new Promise((settle) => setTimeout(settle, 20));
    expect(await attention.list()).toHaveLength(2);
  });

  it('lets the founder dismiss a refused-key item', async () => {
    const attention = createAttention(await mkdtemp(join(tmpdir(), 'attention-')));
    await attention.raise({ id: 'key-rejected:GROQ_API_KEY:1', kind: 'key-rejected', title: 'Groq key rejected; fix it in Keys', at: Date.now() });
    await attention.dismiss('key-rejected:GROQ_API_KEY:1');
    expect(await attention.list()).toHaveLength(0);
  });

  it('does not bring a refused key back from the last run: a new key only takes effect on a start', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'attention-'));
    const first = createAttention(dir);
    await first.raise({ id: 'key-rejected:GROQ_API_KEY:1', kind: 'key-rejected', title: 'Groq key rejected; fix it in Keys', at: Date.now() });
    await first.raise({ id: 'unanswered:x', kind: 'run-failed', title: 'Stopped', at: Date.now() });
    await first.settled();
    expect((await createAttention(dir).list()).map((one) => one.id)).toEqual(['unanswered:x']);
  });

  it('raises one item naming the provider and Keys, and clears it when the key answers again', async () => {
    const attention = createAttention(await mkdtemp(join(tmpdir(), 'attention-')));
    const usage = createUsage(null, () => NOON);
    keyAttention(usage, attention, () => NOON);
    const refused = Object.assign(new Error('Invalid API Key'), { status: 401 });
    usage.failed('groq#2', refused);
    usage.failed('groq#2', refused);
    await new Promise((settle) => setTimeout(settle, 20));
    const raised = await attention.list();
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ kind: 'key-rejected', title: 'Groq key rejected; fix it in Keys' });
    usage.record('groq#2');
    await new Promise((settle) => setTimeout(settle, 20));
    expect(await attention.list()).toHaveLength(0);
  });
});

describe('a file the app could not read', () => {
  it('says what happened, what it was put back from and where the damaged copy is', () => {
    const back = damageAttention({ file: 'stage.json', aside: '/w/stage.corrupt-x.json', from: { file: 'cubicle-2026-09-26-0900.tar.gz', at: 1 } }, NOON);
    expect(back).toMatchObject({ id: 'file-damaged:stage.json:' + NOON, kind: 'file-damaged', at: NOON });
    expect(back.title).toBe('The canvas file was damaged, and was put back from a backup');
    expect(back.detail).toContain('/w/stage.corrupt-x.json');
    expect(back.detail).toContain('cubicle-2026-09-26-0900.tar.gz');
    const fresh = damageAttention({ file: 'stage.json', aside: '/w/stage.corrupt-x.json', from: null }, NOON);
    expect(fresh.title).toBe('The canvas file was damaged, and the canvas started again');
    expect(fresh.detail).toContain('no backup held it');
    const chat = damageAttention({ file: 'rooms/marketing.json', aside: '/w/rooms/marketing.corrupt-x.json', from: null }, NOON);
    expect(chat.title).toBe('A conversation file was damaged, and that conversation started again');
    expect(chat.roomId).toBe('marketing');
    expect(chat.detail).toContain('/w/rooms/marketing.corrupt-x.json');
    const memory = damageAttention({ file: 'rooms/marketing.memory.json', aside: '/w/a', from: null }, NOON);
    expect(memory.title).toBe('A person\'s memory file was damaged, and their memory started again');
    expect(memory.roomId).toBe('marketing');
  });

  it('stays through a restart until the founder dismisses it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'attention-'));
    const first = createAttention(dir, () => NOON);
    await first.raise(damageAttention({ file: 'stage.json', aside: '/w/a', from: null }, NOON));
    await first.settled();
    const later = createAttention(dir, () => NOON + 3 * 86_400_000);
    const [held] = await later.list();
    expect(held).toMatchObject({ kind: 'file-damaged' });
    expect(held.lapsed).toBeUndefined();
    await later.dismiss(held.id);
    expect(await later.list()).toHaveLength(0);
  });
});

describe('a daily backup that failed', () => {
  it('raises one item with the error, keeps it through more failures, and clears it on the next success', async () => {
    const attention = createAttention(await mkdtemp(join(tmpdir(), 'attention-')), () => NOON);
    const told = backupAttention(attention, () => NOON);
    await told({ problem: 'ENOSPC: no space left on device', where: '/media/usb/backups' });
    const [item] = await attention.list();
    expect(item).toMatchObject({ id: 'backup-failed', kind: 'backup-failed', title: 'The daily backup failed' });
    expect(item.detail).toContain('ENOSPC: no space left on device');
    expect(item.detail).toContain('/media/usb/backups');
    await told({ problem: 'ENOSPC again', where: '/media/usb/backups' });
    expect(await attention.list()).toHaveLength(1);
    // A tick with nothing to do says nothing either way.
    await told(null);
    expect(await attention.list()).toHaveLength(1);
    await told({ made: true });
    expect(await attention.list()).toHaveLength(0);
  });

  it('can be dismissed, and is not brought back from the last run: the next start tries again and says so', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'attention-'));
    const first = createAttention(dir, () => NOON);
    await backupAttention(first, () => NOON)({ problem: 'EACCES', where: '/x' });
    await first.settled();
    expect(await createAttention(dir, () => NOON).list()).toHaveLength(0);
    await first.dismiss('backup-failed');
    expect(await first.list()).toHaveLength(0);
  });
});

describe('what is already done leaves Needs you', () => {
  const setUp = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'attention-done-'));
    // One clock for the boards, the bets and the decisions, moved by a test that needs one thing earlier than another.
    const time = { now: NOON, decisions: NOON - 60_000 };
    const store = createStore(dir); const boards = createBoards(dir, () => time.now); const decisions = createDecisions(dir, () => time.decisions); const bets = betsBook(dir, () => time.now);
    const stage = await store.loadStage();
    await store.saveStage({ ...stage, cards: [{ id: 'b1', kind: 'board', x: 0, y: 0, w: 900, h: 400 }] });
    const attention = createAttention(dir, () => NOON);
    attention.source(boardAttention(store, boards));
    attention.source(decisionAttention(decisions));
    attention.settle(doneAttention({ workspace: dir, store, boards, decisions }));
    return { dir, store, boards, decisions, bets, attention, time };
  };
  const plan = (id: string, steps: string[]) => ({ id, at: NOON, who: 'Sam', roomId: 'partner', title: 'Invoicing week', steps: steps.map((text) => ({ text })) });

  it('drops a plan whose steps are already tasks on a board, and keeps one that is not', async () => {
    const { dir, boards, attention } = await setUp();
    await writeFile(join(dir, 'partner.json'), JSON.stringify({ decided: [], plans: [plan('plan-a', ['Ship the invoice form', 'Call the three beta users']), plan('plan-b', ['Write the pricing page', 'Email the waitlist'])] }));
    const shown = async () => (await attention.list()).filter((one) => one.kind === 'proposed-plan').map((one) => one.id);
    const source = async () => [{ id: 'proposed-plan:plan-a', kind: 'proposed-plan' as const, title: 'Add these 2 tasks to the board? (Invoicing week)', at: NOON }, { id: 'proposed-plan:plan-b', kind: 'proposed-plan' as const, title: 'Add these 2 tasks to the board? (Pricing)', at: NOON }];
    attention.source(source);
    expect(await shown()).toEqual(['proposed-plan:plan-a', 'proposed-plan:plan-b']);
    // One step on the board is not the plan done.
    await boards.add('b1', { title: 'Ship the invoice form' });
    expect(await shown()).toEqual(['proposed-plan:plan-a', 'proposed-plan:plan-b']);
    await boards.add('b1', { title: 'call the three beta users', column: 'done' });
    expect(await shown()).toEqual(['proposed-plan:plan-b']);
  });

  it('drops a proposed bet once the same bet is taken, and a decision to choose a bet once one is taken after it', async () => {
    const { bets, decisions, attention } = await setUp();
    const input = { what: 'Retain 5 paying beta users', hypothesis: 'Invoicing keeps them', metric: 'paying_users', target: 5, checkDate: '2026-10-04' };
    const first = await bets.propose(input);
    const again = await bets.propose({ ...input, what: 'Retain 5 paying beta users.' });
    const choose = await decisions.propose({ title: 'Choose a 2-week validation bet', options: ['Retention', 'Signups'] });
    const other = await decisions.propose({ title: 'Raise the price?', options: ['Yes', 'No'] });
    const source = async () => (await bets.list()).filter((bet) => bet.status === 'proposed').map((bet) => ({ id: `proposed-bet:${bet.id}`, kind: 'proposed-bet' as const, title: bet.what, at: bet.at }));
    attention.source(source);
    const ids = async () => (await attention.list()).map((one) => one.id).sort();
    expect(await ids()).toEqual([`proposed-bet:${again.id}`, `proposed-bet:${first.id}`, `proposed-decision:${choose.id}`, `proposed-decision:${other.id}`].sort());
    await bets.answer(first.id, true);
    // The copy of the bet the founder already took, and the question the bet answered, both go; the price stays.
    expect(await ids()).toEqual([`proposed-decision:${other.id}`]);
  });

  it('drops a proposed decision once the same decision is on record as decided', async () => {
    const { decisions, attention } = await setUp();
    const proposed = await decisions.propose({ title: 'Build invoicing first', options: ['Invoicing', 'Profiles'] });
    expect((await attention.list()).map((one) => one.id)).toEqual([`proposed-decision:${proposed.id}`]);
    await decisions.record({ title: 'Build invoicing first.', chosen: 'Invoicing' });
    expect(await attention.list()).toEqual([]);
  });

  it('counts only tasks made since the plan was offered, so a weekly plan is not hidden by last week\'s tasks', async () => {
    const { dir, boards, attention, time } = await setUp();
    await writeFile(join(dir, 'partner.json'), JSON.stringify({ decided: [], plans: [plan('plan-a', ['Ship the invoice form', 'Call the three beta users'])] }));
    attention.source(async () => [{ id: 'proposed-plan:plan-a', kind: 'proposed-plan' as const, title: 'Add these 2 tasks', at: NOON }]);
    time.now = NOON - 7 * 86_400_000;
    await boards.add('b1', { title: 'Ship the invoice form', column: 'done' });
    await boards.add('b1', { title: 'Call the three beta users', column: 'done' });
    expect((await attention.list()).map((one) => one.id)).toEqual(['proposed-plan:plan-a']);
    // Made in the same turn, a moment before the offer was written down, they count.
    time.now = NOON - 60_000;
    await boards.add('b1', { title: 'Ship the invoice form' });
    await boards.add('b1', { title: 'Call the three beta users' });
    expect(await attention.list()).toEqual([]);
  });

  it('keeps a question asked again after an old decision on the same title', async () => {
    const { decisions, attention, time } = await setUp();
    time.decisions = NOON - 7 * 86_400_000;
    await decisions.record({ title: 'Raise the price?', chosen: 'No' });
    time.decisions = NOON;
    const again = await decisions.propose({ title: 'Raise the price?', options: ['Yes', 'No'] });
    expect((await attention.list()).map((one) => one.id)).toEqual([`proposed-decision:${again.id}`]);
  });

  it('answers only a question that asks to choose a bet, only with an open bet taken after it, and never with a closed twin', async () => {
    const { bets, decisions, attention, time } = await setUp();
    const input = { what: 'Retain 5 paying beta users', hypothesis: 'Invoicing keeps them', metric: 'paying_users', target: 5, checkDate: '2026-10-04' };
    // A bet taken and closed a week ago: neither its words proposed again nor a new question to pick a bet are answered by it.
    time.now = NOON - 7 * 86_400_000;
    const old = await bets.propose(input);
    await bets.answer(old.id, true);
    await bets.close(old.id, { verdict: 'did-not', value: 3, note: '', by: 'Founder' });
    time.now = NOON; time.decisions = NOON - 60_000;
    const rerun = await bets.propose(input);
    const pick = await decisions.propose({ title: 'Pick the next bet', options: ['Retention', 'Signups'] });
    const kill = await decisions.propose({ title: 'Kill the retention bet?', options: ['Yes', 'No'] });
    const source = async () => (await bets.list()).filter((bet) => bet.status === 'proposed').map((bet) => ({ id: `proposed-bet:${bet.id}`, kind: 'proposed-bet' as const, title: bet.what, at: bet.at }));
    attention.source(source);
    const ids = async () => (await attention.list()).map((one) => one.id).sort();
    expect(await ids()).toEqual([`proposed-bet:${rerun.id}`, `proposed-decision:${kill.id}`, `proposed-decision:${pick.id}`].sort());
    // Taken now, the rerun answers "pick the next bet"; "kill the retention bet" is not a question about choosing one.
    await bets.answer(rerun.id, true);
    expect(await ids()).toEqual([`proposed-decision:${kill.id}`]);
  });

  it('does not take a bet proposed and taken before the question as its answer', async () => {
    const { bets, decisions, attention, time } = await setUp();
    time.now = NOON - 3_600_000;
    const early = await bets.propose({ what: 'Retain 5 paying beta users', hypothesis: '', metric: 'paying_users', target: 5, checkDate: '2026-10-04' });
    await bets.answer(early.id, true);
    time.decisions = NOON;
    const which = await decisions.propose({ title: 'Which bet next?', options: ['Retention', 'Signups'] });
    expect((await attention.list()).map((one) => one.id)).toEqual([`proposed-decision:${which.id}`]);
  });

  it('tells whoever watches when a board change makes a plan done', async () => {
    const { dir, boards, attention } = await setUp();
    await writeFile(join(dir, 'partner.json'), JSON.stringify({ decided: [], plans: [plan('plan-a', ['Ship the invoice form', 'Call the three beta users'])] }));
    attention.source(async () => [{ id: 'proposed-plan:plan-a', kind: 'proposed-plan' as const, title: 'Add these 2 tasks', at: NOON }]);
    const told: number[] = [];
    attention.watch((list) => told.push(list.length));
    boards.onChange(() => { void attention.refresh(); });
    await boards.add('b1', { title: 'Ship the invoice form' });
    await boards.add('b1', { title: 'Call the three beta users' });
    await expect.poll(() => told.at(-1)).toBe(0);
  });
});

describe('the new keys refused (round 6)', () => {
  const settle = () => new Promise((done) => setTimeout(done, 20));
  it('raises one item for a refused Mistral or NVIDIA key, named the way the Keys panel names them', async () => {
    const attention = createAttention(await mkdtemp(join(tmpdir(), 'attention-')));
    const usage = createUsage(null);
    keyAttention(usage, attention, () => NOON);
    usage.failed('mistral', Object.assign(new Error('401 Unauthorized'), { status: 401 }));
    usage.failed('nvidia#2', Object.assign(new Error('403 Forbidden'), { status: 403 }));
    await settle();
    const items = await attention.list();
    expect(items.map((one) => [one.id, one.title])).toEqual([
      ['key-rejected:MISTRAL_API_KEY:1', 'Mistral key rejected; fix it in Keys'],
      ['key-rejected:NVIDIA_API_KEY:2', 'NVIDIA key rejected; fix it in Keys'],
    ]);
    expect(items[1].detail).toContain('NVIDIA_API_KEY_2 was refused (403)');
    usage.record('mistral');
    await settle();
    expect((await attention.list()).map((one) => one.id)).toEqual(['key-rejected:NVIDIA_API_KEY:2']);
  });

  it('takes a 429 from a key whose plan allows no requests a minute (Mistral before its free plan is chosen) as refused, and says where to turn the plan on', async () => {
    const attention = createAttention(await mkdtemp(join(tmpdir(), 'attention-')));
    const usage = createUsage(null);
    keyAttention(usage, attention, () => NOON);
    // What Mistral answered on 2026-09-27 for a key with no plan: a 429 whose headers say the minute allows nothing.
    const planless = Object.assign(new Error('429 Rate limit exceeded'), { status: 429, headers: new Headers({ 'x-ratelimit-limit-req-minute': '0', 'x-ratelimit-remaining-req-minute': '0' }) });
    usage.failed('mistral', planless);
    await settle();
    expect(usage.dead('mistral')).toBe(true);
    const [item] = await attention.list();
    expect(item).toMatchObject({ id: 'key-rejected:MISTRAL_API_KEY:1', title: 'Mistral\'s free plan is not on; turn it on at console.mistral.ai' });
    expect(item.detail).toContain('its plan allows no requests yet');
    expect(item.detail).toContain('console.mistral.ai');
    // A busy minute is not a refused key.
    const busy = Object.assign(new Error('429 Rate limit exceeded'), { status: 429, headers: new Headers({ 'x-ratelimit-limit-req-minute': '60', 'x-ratelimit-remaining-req-minute': '0' }) });
    usage.failed('nvidia', busy);
    expect(usage.dead('nvidia')).toBe(false);
  });
});
