import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createJob, readJob, updateJob, listJobs, listIdeas, loadOrg, teamOf, HOUSE, PANTRY_DIR } from '@cubicle/core';
import type { RoutedChatResult, RouteRequest, ChatMessage, ToolSchema } from '@cubicle/router';
import type { Llm } from '@cubicle/harness';
import { NON_WORK_TYPES, type HeartbeatDeps } from '../src/heartbeat.js';
import { Daemon, defaultConfig } from '../src/index.js';
import { PANTRY_ROLE_ID, PANTRY_TURN_TOKENS, idleRoles, pantryPair, pantryJobId, lastPantryChat, pantryNoteFor, maybeEnqueuePantryChat, runPantryChat, pantryPrompt } from '../src/pantry.js';
import { orgLlm } from '../../../scripts/lib/org-llm.js';
import { WAIT_MS, LOAD_1M, LOAD_SCALE, TEST_MS } from './helpers/load.js';

const root = path.resolve(__dirname, '../../..');
const NOW = new Date('2026-09-12T15:30:00.000Z');

/** Poll a condition on real timers, against a budget that moves with the machine's load (helpers/load.ts). */
async function waitFor(pred: () => boolean, ms = WAIT_MS): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`waitFor: timeout after ${Date.now() - t0} ms (budget ${ms} ms, 1-min load ${LOAD_1M.toFixed(2)}, scale ${LOAD_SCALE})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A scripted model that says one line per turn and closes with whatever `idea` says. */
function chatter(opts: { idea?: string; silentAfter?: number } = {}): Llm & { calls: { roleId: string; tier: string; maxTokens?: number; budgetDivision?: string }[] } {
  const calls: { roleId: string; tier: string; maxTokens?: number; budgetDivision?: string }[] = [];
  return {
    calls,
    async chat(req: RouteRequest, c: { messages: ChatMessage[]; tools?: ToolSchema[]; maxTokens?: number }): Promise<RoutedChatResult> {
      calls.push({ roleId: req.roleId ?? '?', tier: req.tier, maxTokens: c.maxTokens, budgetDivision: req.budgetDivision });
      if (opts.silentAfter !== undefined && calls.length > opts.silentAfter) throw new Error('no model available');
      const closing = /IDEA: <one sentence>/.test(String(c.messages.at(-1)?.content ?? ''));
      const content = closing ? `So we should try it.\nIDEA: ${opts.idea ?? 'none'}` : `Turn ${calls.length}: the nurseries keep asking about a weekly box.`;
      return { content, toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 5, completion_tokens: 2 }, provider: 'f', model: 'f', tier: 'cheap', downgraded: false, parsedToolCalls: [] };
    },
    promptBudget: () => 2000,
  };
}

let dir: string; let vault: Vault;
/** Every daemon the acceptance case starts, stopped before the vault it writes to is removed. */
const daemons: Daemon[] = [];
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-pantry-run-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => undefined);
  await new Promise((r) => setImmediate(r));
  vault.close(); rmSync(dir, { recursive: true, force: true });
});

const cycle = (n = 1) => { for (let i = 0; i < n; i++) vault.events.emit({ type: 'heartbeat.completed', payload: { id: `hb${i}` } }); };
/** The owner has said what the company is: the pantry's other floor (Decision 20, as refined by review I3). */
const anIdea = () => vault.updateNote('Brand/name.md', (n) => ({ data: { ...n.data, name: 'PlateReady' }, body: n.body }), 'owner');
/** A company with an idea and a cycle behind it — the two things the pantry waits for. */
const ready = (n = 1) => { anIdea(); cycle(n); };
const deps = (llm: Llm): HeartbeatDeps => ({ vault, llm, now: () => NOW, modelBudget: () => ({ used: 3, quota: 600 }) });
const notes = () => vault.list(PANTRY_DIR, { ext: '.md' }).filter((r) => !r.endsWith('_about.md'));

describe('who goes to the pantry (spec §6)', () => {
  it('nobody, until the company has had a cycle', () => {
    anIdea();
    expect(maybeEnqueuePantryChat(vault)).toBeNull();
    cycle();
    expect(maybeEnqueuePantryChat(vault)).not.toBeNull();
  });

  // Decision 20 as refined by review I3: the first tick of a fresh vault requests a heartbeat, so a completed
  // cycle on its own does not mean the company has started. Nobody has a coffee about nothing.
  it('nobody on a vault the owner has said nothing to, however many cycles it has run', () => {
    cycle(3);
    expect(maybeEnqueuePantryChat(vault)).toBeNull();
    expect(notes()).toEqual([]);
    anIdea();
    expect(maybeEnqueuePantryChat(vault)).not.toBeNull();
  });

  it('nobody while the company is dormant, and a dormancy check that throws is not dormant', () => {
    ready();
    expect(maybeEnqueuePantryChat(vault, { dormant: () => true })).toBeNull();
    expect(maybeEnqueuePantryChat(vault, { dormant: () => { throw new Error('unreadable ledger'); } })).not.toBeNull();
  });

  it('one chat per cycle, re-found rather than re-filed', () => {
    ready();
    expect(maybeEnqueuePantryChat(vault)).toBe(pantryJobId(1));
    expect(maybeEnqueuePantryChat(vault)).toBeNull();          // the job note is already there
    cycle();                                                    // cycle 2, but the first chat is still open
    expect(maybeEnqueuePantryChat(vault)).toBeNull();
  });

  it('the pair is two idle people from different rooms, and the board is left out', () => {
    const org = loadOrg(vault);
    const idle = idleRoles(org, []);
    const board = org.teams.board!;
    for (const advisor of [board.lead, ...board.members]) expect(idle).not.toContain(advisor);
    const pair = pantryPair(idle, 0, (r) => teamOf(org, r)?.id)!;
    expect(pair[0]).not.toBe(pair[1]);
    expect(teamOf(org, pair[0])?.id).not.toBe(teamOf(org, pair[1])?.id);
    expect(pantryPair(idle, 1, (r) => teamOf(org, r)?.id)![0]).not.toBe(pair[0]);   // `a` rotates with the cycle
    expect(pantryPair([], 0, () => undefined)).toBeNull();
    expect(pantryPair(['cmo'], 0, () => 'revenue')).toBeNull();
  });

  // Review M1: with an alphabetical list and `rest.find(…)`, the second seat was nearly always the same person.
  // Both seats now come off "who was in the pantry longest ago", read from the notes themselves.
  it('both seats go to whoever has been in the pantry longest ago', () => {
    const teamFor = (r: string) => ({ a1: 'x', a2: 'x', b1: 'y', b2: 'y' } as Record<string, string>)[r];
    const idle = ['a1', 'a2', 'b1', 'b2'];
    // Nobody has been yet: the cycle decides, and it moves both seats rather than just the first.
    const [a0, b0] = pantryPair(idle, 0, teamFor)!;
    const [a1, b1] = pantryPair(idle, 1, teamFor)!;
    expect(a1).not.toBe(a0);
    expect(b1).not.toBe(b0);
    // Two of them had a coffee yesterday; the two who did not go next, whatever the cycle says.
    const seen = { [a0]: 'Pantry/2026-09-11-one.md', [b0]: 'Pantry/2026-09-11-one.md' };
    for (const c of [0, 1, 2, 3]) {
      const pair = pantryPair(idle, c, teamFor, seen)!;
      expect(pair, `cycle ${c}`).not.toContain(a0);
      expect(pair, `cycle ${c}`).not.toContain(b0);
      expect(teamFor(pair[0])).not.toBe(teamFor(pair[1]));
    }
    // And of two who have both been, the older note goes first.
    const older = pantryPair(['a1', 'b1'], 0, teamFor, { a1: 'Pantry/2026-09-01-x.md', b1: 'Pantry/2026-09-11-y.md' })!;
    expect(older[0]).toBe('a1');
  });

  it('the pair the tick picks avoids whoever the last note names', () => {
    ready();
    const first = readJob(vault, maybeEnqueuePantryChat(vault)!)!.data;
    const was = [first.assigned, String(first.pantry_with)];
    vault.writeText('Pantry/2026-09-12-one.md', `---\ndate: 2026-09-12\ncycle: 1\nparticipants: [${was.join(', ')}]\nturns: 6\nidea: ''\n---\n# Pantry\n`, 'daemon');
    expect(lastPantryChat(vault)[was[0]]).toBe('Pantry/2026-09-12-one.md');
    cycle();                                       // cycle 2, and the first chat is closed out of the way
    updateJob(vault, first.id, { status: 'done' }, 'daemon');
    const next = readJob(vault, maybeEnqueuePantryChat(vault)!)!.data;
    expect(was).not.toContain(next.assigned);
    expect(was).not.toContain(String(next.pantry_with));
  });

  it('somebody with an open job is not idle', () => {
    const org = loadOrg(vault);
    const before = idleRoles(org, listJobs(vault, { status: ['queued'] }));
    createJob(vault, { type: 'custom', title: 'busy', assigned: before[0], goal: 'g' }, 'ceo');
    const after = idleRoles(org, listJobs(vault, { status: ['queued'] }));
    expect(after).not.toContain(before[0]);
    expect(after.length).toBe(before.length - 1);
  });

  it('the job carries no team, the cheapest tier, the lowest priority, and is not work', () => {
    ready();
    const j = readJob(vault, maybeEnqueuePantryChat(vault)!)!.data;
    expect(j.type).toBe('pantry.chat');
    expect(j.team).toBeUndefined();          // Decision 10: no WIP limit may hold a coffee break
    expect(j.model_tier).toBe('cheap');
    expect(j.priority).toBe(5);
    expect(String(j.pantry_with)).toBeTruthy();
    expect(j.title).toMatch(/^Pantry: .+ and .+$/);
    expect(NON_WORK_TYPES).toContain('pantry.chat');
  });
});

describe('the chat costs the house and nothing else (spec §6)', () => {
  it('six turns at most, all on the cheap tier, all charged to the house', async () => {
    ready();
    const id = maybeEnqueuePantryChat(vault)!;
    const llm = chatter({ idea: 'Weekly meal kits for nurseries' });
    await runPantryChat(deps(llm), id);
    expect(llm.calls).toHaveLength(6);
    for (const c of llm.calls) {
      expect(c.roleId).toBe(PANTRY_ROLE_ID);          // not a role, so `divisionOfRole` sends it to the house
      expect(c.tier).toBe('cheap');
      expect(c.maxTokens).toBe(PANTRY_TURN_TOKENS);
      // The stamp the router copies on to `router.call` as `budget_division` (SP4 §4, ruling Q15): the bank
      // screen counts a coffee break against the reserve instead of guessing a pool from the speaker's room.
      expect(c.budgetDivision).toBe(HOUSE);
    }
    const j = readJob(vault, id)!.data;
    expect(j.status).toBe('done');
    expect(j.checkpoint_step).toBe(6);
  });

  it('opens and closes the pantry room, one turn event per turn, alternating', async () => {
    ready();
    const id = maybeEnqueuePantryChat(vault)!;
    const { assigned: a, pantry_with: b } = readJob(vault, id)!.data;
    await runPantryChat(deps(chatter({ idea: 'Weekly meal kits for nurseries' })), id);
    expect(vault.events.query({ types: ['meeting.opened'] }).at(-1)!.payload).toMatchObject({ room: 'pantry', participants: [a, b] });
    const turns = vault.events.query({ types: ['meeting.turn'] });
    expect(turns).toHaveLength(6);
    expect(turns.map((t) => t.agent)).toEqual([a, b, a, b, a, b]);
    expect(String(turns[0].payload.text).length).toBeLessThanOrEqual(280);
    const closed = vault.events.query({ types: ['meeting.closed'] }).at(-1)!;
    expect(closed.payload).toMatchObject({ room: 'pantry', turns: 6, path: notes()[0] });
    expect(String(closed.payload.decision)).toContain('IDEA: Weekly meal kits for nurseries');
  });

  it('writes the note, and files one card through the ideas path', async () => {
    ready();
    const id = maybeEnqueuePantryChat(vault)!;
    await runPantryChat(deps(chatter({ idea: 'Weekly meal kits for nurseries' })), id);
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toMatch(/^Pantry\/2026-09-12-.+\.md$/);
    const note = vault.readNote<{ cycle: number; turns: number; idea: string }>(notes()[0]);
    expect(note.data).toMatchObject({ cycle: 1, turns: 6, idea: 'weekly-meal-kits-for-nurseries' });
    expect(note.body).toContain('## Chat');
    expect(note.body).toContain('## Idea');
    const cards = listIdeas(vault).filter((i) => i.source === 'pantry');
    expect(cards).toHaveLength(1);
    expect(cards[0].evidence).toEqual([notes()[0]]);
  });

  it('IDEA: none writes the note and files nothing', async () => {
    ready();
    const id = maybeEnqueuePantryChat(vault)!;
    await runPantryChat(deps(chatter()), id);
    expect(listIdeas(vault).filter((i) => i.source === 'pantry')).toEqual([]);
    expect(vault.readNote(notes()[0]).body).toContain('_Nothing new._');
    expect(readJob(vault, id)!.data.status).toBe('done');
  });

  it('no model available ends the chat early and the job still finishes done', async () => {
    ready();
    const id = maybeEnqueuePantryChat(vault)!;
    const llm = chatter({ silentAfter: 2 });
    await runPantryChat(deps(llm), id);
    expect(llm.calls).toHaveLength(3);                   // two answers, then the failure that stops it
    expect(readJob(vault, id)!.data).toMatchObject({ status: 'done', checkpoint_step: 2 });
    expect(vault.readNote<{ turns: number }>(notes()[0]).data.turns).toBe(2);
    expect(vault.events.query({ types: ['meeting.closed'] }).at(-1)!.payload.turns).toBe(2);
  });

  it('a chat whose partner has gone holds no turns at all rather than talking to itself', async () => {
    ready();
    const id = maybeEnqueuePantryChat(vault)!;
    vault.remove(`Roles/${readJob(vault, id)!.data.pantry_with}.md`, 'owner');
    const llm = chatter({ idea: 'Weekly meal kits for nurseries' });
    await runPantryChat(deps(llm), id);
    expect(llm.calls).toEqual([]);
    expect(readJob(vault, id)!.data.status).toBe('done');
    expect(vault.readNote<{ turns: number }>(notes()[0]).data.turns).toBe(0);
  });

  /**
   * The one end-to-end case (ruling Q16). `scripts/test-kill9.ts`, `scripts/test-replay.ts` and the scripts the
   * acceptance sweep drives all set `disablePantry` so their job counts stay deterministic, which would otherwise
   * leave the whole tick → worker → note path untested outside this file's direct calls. So it is tested here,
   * once, on the same scripted model those scripts use: the daemon's own tick schedules the chat, its own worker
   * pool runs it through the `pantry.chat` branch, and the note and the card are on disk at the end of it.
   */
  it('the daemon tick schedules a coffee and its worker pool holds it, on the scripted model (acceptance test 12)', async () => {
    ready();                                                   // one completed cycle: the pantry is open (Decision 20)
    const d = new Daemon(
      defaultConfig(dir, { CUBICLE_MOCK_TOOLS: '1' } as NodeJS.ProcessEnv, { port: 0, tickMs: 300, maxConcurrentJobs: 3, providersPath: path.join(root, 'config/providers.yaml'), toolsPath: path.join(root, 'config/tools.yaml') }),
      { llm: orgLlm({ vetoes: 0 }), disableWs: true, disableSleepWatch: true, memory: false, log: () => undefined },
    );
    daemons.push(d);
    await d.start();
    const chat = () => listJobs(d.vault).find((j) => j.type === 'pantry.chat');
    await waitFor(() => chat()?.status === 'done');
    const job = chat()!;
    expect(job.id).toBe(pantryJobId(1));                       // the deterministic id, so a replayed tick re-finds it
    expect(job.team).toBeUndefined();
    expect(job.checkpoint_step).toBe(6);
    const closed = d.vault.events.query({ types: ['meeting.closed'] }).find((e) => e.payload.room === 'pantry')!;
    expect(closed.payload).toMatchObject({ turns: 6 });
    expect(String(closed.payload.path)).toMatch(/^Pantry\/\d{4}-\d{2}-\d{2}-.+\.md$/);
    expect(d.vault.readNote<{ turns: number }>(String(closed.payload.path)).data.turns).toBe(6);
    const cards = listIdeas(d.vault).filter((i) => i.source === 'pantry');
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe('A weekly meal-kit box for nurseries');
  }, TEST_MS);

  // Review I1: the chat is priority 5, so it waits behind everything queued for its own side of the pair, and by
  // the time it comes up either of the two may have work. Idleness is the premise, so it is re-checked.
  it('a coffee where either of the two has picked up work is called off, with no turns and no note', async () => {
    for (const who of ['assigned', 'pantry_with'] as const) {
      ready();
      const id = maybeEnqueuePantryChat(vault)!;
      const job = readJob(vault, id)!.data;
      createJob(vault, { type: 'custom', title: `busy ${who}`, assigned: String(job[who]), goal: 'g' }, 'ceo');
      const llm = chatter({ idea: 'Weekly meal kits for nurseries' });
      expect(await runPantryChat(deps(llm), id)).toEqual({ status: 'cancelled', skipped: String(job[who]) });
      expect(llm.calls).toEqual([]);
      expect(readJob(vault, id)!.data.status).toBe('cancelled');
      expect(notes()).toEqual([]);                                     // no note, and nothing filed
      expect(vault.events.query({ types: ['meeting.opened'] })).toEqual([]);   // nobody walked to the counter
      const off = vault.events.query({ types: ['job.cancelled'] }).at(-1)!;
      expect(off.payload).toMatchObject({ reason: 'skipped', by: String(job[who]) });
      // The daemon called it off, not `a` — who may be the busy one, and whose own job the office's reducer
      // would otherwise take off the screen.
      expect(off.agent).toBe('daemon');
      // A fresh vault for the second half, so the two cases cannot mask each other.
      vault.close(); rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(path.join(tmpdir(), 'cubicle-pantry-run-'));
      vault = (await scaffoldVault(dir)).vault;
    }
  });

  // Review I2 / SP4 §4: one reading of the house budget per piece of work, not one per call. The gauge walks a
  // ledger that only grows, and a chat that re-read it every turn could change model halfway through itself.
  it('reads the house budget once for the whole chat', async () => {
    ready();
    const id = maybeEnqueuePantryChat(vault)!;
    let reads = 0;
    const llm = chatter({ idea: 'Weekly meal kits for nurseries' });
    await runPantryChat({ vault, llm, now: () => NOW, modelBudget: () => { reads++; return { used: 3, quota: 600 }; } }, id);
    expect(llm.calls).toHaveLength(6);
    expect(reads).toBe(1);
  });

  // Review M2: the kill window is between the note write and the `done` update. The conversation is on disk, so
  // the resume finishes pointing at it rather than spending six more calls and filing a second `-2` note.
  it('a resume after the note was written finishes on it instead of chatting again', async () => {
    ready();
    const id = maybeEnqueuePantryChat(vault)!;
    await runPantryChat(deps(chatter({ idea: 'Weekly meal kits for nurseries' })), id);
    const written = notes()[0];
    expect(pantryNoteFor(vault, id)).toBe(written);
    // The kill: the job is back to queued with its note already there (what the daemon's restart sweep does).
    updateJob(vault, id, { status: 'queued', checkpoint_step: 0 }, 'daemon');
    const llm = chatter({ idea: 'Weekly meal kits for nurseries' });
    await runPantryChat(deps(llm), id);
    expect(llm.calls).toEqual([]);
    expect(notes()).toEqual([written]);                       // no `-2` note for one coffee
    expect(readJob(vault, id)!.data).toMatchObject({ status: 'done', checkpoint_step: 6 });
    expect(listIdeas(vault).filter((i) => i.source === 'pantry')).toHaveLength(1);
    expect(vault.events.query({ types: ['job.done'], job: id }).at(-1)!.payload.artifacts).toEqual([written]);
  });

  it('the closing turn is the only one asked for an idea', () => {
    const mid = pantryPrompt({ speaker: 'clo', speakerName: 'CLO', otherName: 'CMO', turns: [], last: false });
    const last = pantryPrompt({ speaker: 'cmo', speakerName: 'CMO', otherName: 'CLO', turns: [{ role: 'clo', name: 'CLO', text: 'hi' }], last: true });
    expect(mid).not.toContain('IDEA:');
    expect(mid).toContain('at most two sentences');
    expect(last).toContain('IDEA: <one sentence>');
    expect(last).toContain('IDEA: none');
    expect(last).toContain('CLO: hi');
  });
});
