import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { templateQuestions, type SurveyEvent } from '../../shared/survey.ts';
import { hub } from '../events.ts';
import type { Deps } from '../install.ts';
import { createSeams } from '../seams.ts';
import { createStore } from '../store.ts';
import type { Tool, ToolContext } from '../tools/registry.ts';
import survey, { SURVEY_TOOLS } from './survey.ts';

const CSV = [
  'Submitted at,How would you feel if you could no longer use Acme?,What type of people do you think would most benefit from Acme?,What is the main benefit you receive from Acme?,How can we improve Acme for you?',
  '2026-09-20 10:00,Very disappointed,Agency founders,Saves me the Monday report,Faster exports',
  '2026-09-20 11:00,Very disappointed,Agency founders,The Monday report is done for me,',
  '2026-09-21 09:00,Somewhat disappointed,Agency founders,Dashboards,Faster exports',
  '2026-09-21 10:00,Not disappointed,Students,Free plan,Cheaper',
].join('\n');

// The slice on a throwaway workspace: a real store, a PMF Survey card wired to Maya.
async function setup() {
  const workspace = await mkdtemp(join(tmpdir(), 'survey-slice-'));
  const store = createStore(workspace);
  const stage = await store.loadStage();
  stage.cards = [{ id: 'survey-1', kind: 'survey', title: 'September PMF', template: 'pmf', product: 'Acme', questions: templateQuestions('pmf'), x: 0, y: 0, w: 1, h: 1 }];
  stage.wires.push({ id: 'w', from: 'marketing', fromHandle: 'r', to: 'survey-1', toHandle: 'l' });
  await store.saveStage(stage);
  const seams = createSeams();
  const answered: { status: number; body: any }[] = [];
  let sent: unknown = {};
  const deps = {
    workspace, root: workspace, fake: true, store, seams,
    json: (_res: ServerResponse, status: number, body: unknown) => { answered.push({ status, body }); },
    body: async () => sent,
  } as unknown as Deps;
  const heard: { channel: string; data: SurveyEvent }[] = [];
  hub.say = (channel, data) => heard.push({ channel, data: data as SurveyEvent });
  const part = await survey.install(deps);
  const context = async (roomId = 'marketing'): Promise<ToolContext> => ({ stage: await store.loadStage(), roomId, store, granted: new Map() });
  const use = async (args: Record<string, unknown>, roomId?: string) => part.tools!.find((one) => one.name === 'read_survey')!.run(args, await context(roomId));
  const call = async (path: string, method = 'GET', body: unknown = {}) => { sent = body; await part.route!({ method } as IncomingMessage, {} as ServerResponse, path); return answered.at(-1)!; };
  const system = (roomId: string) => seams.run('turn:before', { roomId, source: 'chat' as never, query: 'hi', messages: [{ role: 'system', content: 'You are Maya.' }] }).then((payload) => payload.messages[0].content as string);
  return { part, store, heard, use, call, system, workspace };
}

let closing: (() => Promise<void>) | undefined;
afterEach(async () => { await closing?.(); closing = undefined; });

describe('the Survey card', () => {
  it('is offered only to a person wired to one, and only they read its lines', async () => {
    const { part, store, system } = await setup();
    closing = part.close;
    const stage = await store.loadStage();
    const names = (roomId: string) => part.offer!(part.tools!, stage, roomId).map((one: Tool) => one.name);
    expect(names('marketing')).toEqual(SURVEY_TOOLS);
    expect(names('build')).toEqual([]);
    expect(await system('marketing')).toMatch(/\n\n- PMF survey "September PMF": 4 questions, no answers yet; .* Today is \d{4}-\d{2}-\d{2}\.$/);
    expect(await system('build')).toBe('You are Maya.');
  });

  it('imports an export once, keeps it one response a line, and says it to the card', async () => {
    const { part, call, heard, workspace, system } = await setup();
    closing = part.close;
    const first = await call('/api/surveys/survey-1/import', 'POST', { text: CSV, name: 'tally.csv' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ imported: 4, already: 0, skipped: [], unmatchedQuestions: [], unmatchedColumns: [] });
    expect(first.body.matched[0]).toEqual({ question: 'How would you feel if you could no longer use {product}?', header: 'How would you feel if you could no longer use Acme?' });
    expect(heard.at(-1)).toMatchObject({ channel: 'survey:survey-1' });
    expect(heard.at(-1)!.data.responses).toHaveLength(4);
    // The same file again adds nothing.
    expect((await call('/api/surveys/survey-1/import', 'POST', { text: CSV, name: 'tally.csv' })).body).toMatchObject({ imported: 0, already: 4 });
    const line = await system('marketing');
    expect(line).toContain('- PMF survey "September PMF": 4 answers, 50% very disappointed (at or above 40%). Most disappointed: agency founders (66%, 3 answers). Top reason: \'Saves me the Monday report\'.');
    expect(line).toMatch(/\n {2}Under 30 answers: too few to trust\. Raw answers with read_survey\. Newest answer 2026-09-21\.$/);
    await (part.close as () => Promise<void>)();
    closing = undefined;
    const file = (await readFile(join(workspace, 'surveys', 'survey-1.jsonl'), 'utf8')).trim().split('\n');
    expect(file).toHaveLength(4);
    expect(JSON.parse(file[0]).answers.segment).toBe('Agency founders');
  });

  it('reads the raw answers to a wired person, narrowed by a query, and refuses one with no card', async () => {
    const { part, call, use } = await setup();
    closing = part.close;
    await call('/api/surveys/survey-1/import', 'POST', { text: CSV, name: 'tally.csv' });
    const all = (await use({})).text;
    expect(all).toContain('1. [disappointed] How would you feel if you could no longer use Acme?');
    expect(all).toContain('4 answers:');
    expect(all).toContain('- 2026-09-20 · disappointed: Very disappointed · segment: Agency founders · benefit: Saves me the Monday report · improve: Faster exports');
    const narrow = (await use({ query: 'monday report' })).text;
    expect(narrow).toContain('2 of 4 answers hold "monday report":');
    expect(narrow).not.toContain('Dashboards');
    await expect(use({}, 'build')).rejects.toThrow('no Survey card is connected');
  });

  it('clears into the trash, and answers 404 for a card that is not on the stage', async () => {
    const { part, call, workspace } = await setup();
    closing = part.close;
    await call('/api/surveys/survey-1/import', 'POST', { text: CSV, name: 'tally.csv' });
    expect((await call('/api/surveys/survey-1', 'DELETE')).status).toBe(200);
    expect(((await call('/api/surveys/survey-1')).body as SurveyEvent).responses).toEqual([]);
    await (part.close as () => Promise<void>)();
    closing = undefined;
    expect((await readdir(join(workspace, 'trash'))).some((name) => name.endsWith('-survey-survey-1.jsonl'))).toBe(true);
    expect((await call('/api/surveys/nope')).status).toBe(404);
  });
});
