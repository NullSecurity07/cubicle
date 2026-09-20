import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedStage, type Card, type Stage } from '../../shared/model.ts';
import { createBoards } from '../boards.ts';
import { createBrowser, fakeRunner } from '../browser.ts';
import { fakeCoder } from '../coder.ts';
import { createDecisions } from '../decisions.ts';
import { createFounder } from '../founder.ts';
import { createMedia } from '../media/jobs.ts';
import { createMemory } from '../memory.ts';
import { buildMessages } from '../prompt.ts';
import { createMail, fakeMailHttp } from '../mail.ts';
import { wireTools } from '../providers.ts';
import { wordEmbedder, createRecall } from '../recall.ts';
import { createSkills } from '../skills.ts';
import { createStore } from '../store.ts';
import { decisionTools } from '../tools/decisions.ts';
import { docTools } from '../tools/docs.ts';
import { fileTools } from '../tools/files.ts';
import { founderTools } from '../tools/founder.ts';
import { mediaTools } from '../tools/media.ts';
import { outwardTools } from '../tools/outward.ts';
import { projectTools } from '../tools/project.ts';
import { recallTools } from '../tools/recall.ts';
import type { Tool } from '../tools/registry.ts';
import { memoryTools } from '../tools/remember.ts';
import { skillTools } from '../tools/skills.ts';
import { taskTools } from '../tools/tasks.ts';
import { teamTools } from '../tools/team.ts';
import { webTools } from '../tools/web.ts';
import { offered } from './offer.ts';

// The one tool list the app builds at start, with the fakes the tests use everywhere else. It is built for real
// rather than sketched, because the number this file prints is only worth anything if it is the real schema.
async function everything(mail = false): Promise<Tool[]> {
  const dir = await mkdtemp(join(tmpdir(), 'offer-'));
  const store = createStore(dir);
  const media = createMedia({ dir, store, makers: {} });
  return [
    ...docTools, ...fileTools, ...webTools(createBrowser(fakeRunner)),
    ...outwardTools(createMail(mail ? { AGENTMAIL_API_KEY: 'fake' } : {}, fakeMailHttp), store.filesDir),
    ...projectTools(fakeCoder, [dir]), ...teamTools(async () => 'said'), ...taskTools(createBoards(dir)),
    ...decisionTools(createDecisions(dir)), ...memoryTools(createMemory(store, async () => '')),
    ...recallTools(createRecall({ dir, embed: wordEmbedder, gather: async () => [] })),
    ...mediaTools(media), ...skillTools(createSkills(dir)), ...founderTools(createFounder(dir)),
  ];
}

const card = (id: string, kind: Card['kind']): Card => ({ id, kind, x: 0, y: 0, w: 1, h: 1 } as Card);
const wire = (id: string, from: string, to: string) => ({ id, from, fromHandle: 'r', to, toHandle: 'l' });
// A bare room: nobody on the stage but this person, nothing wired to them at all.
const bare: Stage = { rooms: [seedStage.rooms[0]], docs: [], wires: [], cards: [] };
// Everything the founder can put on a stage, all of it wired to the same person.
const kinds: Card['kind'][] = ['project', 'browser', 'board', 'imagegen', 'voicegen', 'videogen'];
const wiredUp: Stage = {
  ...seedStage,
  cards: kinds.map((kind, at) => card(`c${at}`, kind)),
  wires: [...seedStage.wires, wire('t', 'marketing', 'build'), ...kinds.map((_kind, at) => wire(`w${at}`, 'marketing', `c${at}`))],
};
const size = (tools: Tool[]) => JSON.stringify(wireTools(tools)).length;

describe('what a person is offered', () => {
  it('costs a bare room a fraction of what the whole list costs', async () => {
    const all = await everything();
    const mine = offered(all, bare, 'marketing');
    const wholly = offered(await everything(true), wiredUp, 'marketing');
    // The line that tells a bare room what to connect is the one thing the narrowing adds, so the saving is net of it.
    const system = buildMessages(bare, 'marketing', {}, [], mine.map((tool) => tool.name))[0].content;
    const told = /^Not connected to your room, so you cannot yet:.*$/m.exec(system)![0].length;
    console.log(`schema characters · whole list ${size(all)} (${all.length} tools)`
      + ` · bare room ${size(mine)} (${mine.length} tools) plus ${told} for the line saying what to connect`
      + ` · fully wired room ${size(wholly)} (${wholly.length} tools)`);
    expect(size(mine) + told).toBeLessThan(size(all) / 2);
    // A person alone on the stage keeps what needs nothing: the web, the files, their notes, the decisions, the playbook.
    expect(mine.map((tool) => tool.name)).toEqual([
      'create_doc', 'list_files', 'read_file', 'write_file', 'web_search', 'web_fetch', 'run_code',
      'propose_decision', 'read_decision', 'remember', 'recall', 'use_skill', 'note_founder',
    ]);
    // Wired to one of everything, and with mail set up, nothing at all is taken away.
    expect(wholly).toHaveLength((await everything(true)).length);
  });

  it('gives a tool only to the room that can use it', async () => {
    const all = await everything();
    const has = (stage: Stage, roomId: string, name: string) => offered(all, stage, roomId).some((tool) => tool.name === name);
    const withCard = (kind: Card['kind']): Stage => ({ ...bare, cards: [card('one', kind)], wires: [wire('w', 'marketing', 'one')] });
    for (const [kind, name] of [['project', 'delegate_coding'], ['browser', 'browse'], ['board', 'list_tasks'], ['imagegen', 'generate_image'], ['voicegen', 'generate_voice'], ['videogen', 'generate_video']] as const) {
      expect(has(withCard(kind), 'marketing', name)).toBe(true);
      expect(has(bare, 'marketing', name)).toBe(false);
      // A card on the stage that nobody drew a wire to is nobody's.
      expect(has({ ...withCard(kind), wires: [] }, 'marketing', name)).toBe(false);
    }
    // Writing a document needs one connected; making a new one never did.
    expect(has(seedStage, 'marketing', 'write_doc')).toBe(true);
    expect(has(seedStage, 'build', 'write_doc')).toBe(false);
    expect(has(seedStage, 'build', 'create_doc')).toBe(true);
    // Somebody to ask, and a mailbox to send from.
    expect(has({ ...seedStage, wires: [...seedStage.wires, wire('t', 'marketing', 'build')] }, 'marketing', 'ask_person')).toBe(true);
    expect(has(seedStage, 'marketing', 'ask_person')).toBe(false);
    expect(has(seedStage, 'marketing', 'send_email')).toBe(false);
    expect(offered(await everything(true), seedStage, 'marketing').some((tool) => tool.name === 'send_email')).toBe(true);
  });

  it('leaves alone every tool it does not know by name, so a later feature keeps its own', async () => {
    const mine: Tool = { name: 'delegate_task', description: 'a tool from another slice', parameters: {}, async run() { return { text: '' }; } };
    expect(offered([mine], bare, 'marketing')).toEqual([mine]);
  });

  it('never tells a person about a tool they were not offered', async () => {
    const all = await everything(true);
    // A video studio and no image studio is the case that catches this: one tool's own words name another's.
    const film: Stage = { ...bare, cards: [card('film', 'videogen')], wires: [wire('w', 'marketing', 'film')] };
    for (const [stage, roomId] of [[bare, 'marketing'], [film, 'marketing'], [wiredUp, 'marketing'], [wiredUp, 'build']] as const) {
      const mine = offered(all, stage, roomId);
      const system = buildMessages(stage, roomId, {}, [], mine.map((tool) => tool.name), {}, undefined, undefined, {}, ['- Pricing: per seat'])[0].content;
      // By whole words: the line that says what to connect talks about a browser card, which is not the browse tool.
      for (const tool of all) expect([tool.name, new RegExp(`\\b${tool.name}\\b`).test(system)]).toEqual([tool.name, mine.includes(tool)]);
    }
  });
});
