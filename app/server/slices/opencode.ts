import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { coderChannel, type CoderEvent } from '../../shared/coder.ts';
import type { Card, Stage } from '../../shared/model.ts';
import { hub } from '../events.ts';
import { projectDir } from '../folder.ts';
import type { Deps, Slice } from '../install.ts';
import { graphMcp, writeCoderHome } from '../opencode/config.ts';
import { fakeEngine } from '../opencode/fake.ts';
import { coderHealth, createOpencodeServer, findBin } from '../opencode/server.ts';
import { createCoder, type Coder } from '../opencode/session.ts';
import { wired } from '../prompt.ts';
import { text, type Tool, type ToolContext } from '../tools/registry.ts';
import { cardLog, GRAPH_HINT, graphJson, mcpCommand } from './graph.ts';

// The coder card: a running OpenCode in one project folder, driven by the founder from the card or by any person
// wired to it. One server for the whole app, one lasting session per card, every step on the card as it happens.
type Project = Extract<Card, { kind: 'project' }>;
const projects = (stage: Stage) => (stage.cards ?? []).filter((card): card is Project => card.kind === 'project');
const nameOf = (card: Project) => basename(card.path.trim().replace(/\/+$/, '')) || 'Project';
const NO_CARD = 'no coder card is connected to your room. Ask the founder to add one from the dock (More cards, then Coder), set its folder and draw a wire to it.';

// The card as the coder needs it: the folder checked, its name, and whatever session and model the stage holds.
const refOf = (card: Project, forbidden: string[]) => ({ id: card.id, dir: projectDir(card.path, forbidden), name: nameOf(card), session: card.session, model: card.model });

// What a wired person may do with the coder. Starting work and following it up wait for the founder's yes, with the
// words editable; stopping and looking never do.
export function coderTools(coder: Coder, forbidden: string[]): Tool[] {
  const cardFor = (context: ToolContext) => {
    const cards = projects(context.stage);
    const [id] = wired(context.stage, context.roomId, cards.map((one) => one.id));
    return cards.find((one) => one.id === id);
  };
  const need = (context: ToolContext) => { const card = cardFor(context); if (!card) throw new Error(NO_CARD); return card; };
  const who = (context: ToolContext) => context.stage.rooms.find((one) => one.id === context.roomId)?.name;
  const folder = (context: ToolContext) => cardFor(context)?.path || '(no folder set)';

  // The person's turn waits as long as the work does, up to ten minutes; the founder stopping the turn stops the coder.
  async function finished(cardId: string, signal?: AbortSignal) {
    const how = await coder.wait(cardId, { signal });
    if (how === 'cap') return { text: 'The coder is still working after 10 minutes. Every step shows on the card. Look again later with code_status, or tell the founder it is still going.' };
    if (how === 'stopped') {
      const why = coder.snapshot(cardId).lines.findLast((one) => one.kind === 'note' || one.kind === 'error')?.text ?? 'it stopped';
      throw new Error(`the coder stopped (${why}). ${await coder.result(cardId)}`);
    }
    return { text: await coder.result(cardId) };
  }
  async function send(context: ToolContext, words: string) {
    const card = need(context);
    const ref = refOf(card, forbidden);
    await coder.prompt(ref, words, { by: who(context) });
    return finished(card.id, context.signal);
  }

  return [
    {
      name: 'code_task', perTurn: 1,
      description: 'Give the coder wired to your room a piece of coding work. It works inside that project folder: reads the code, edits files and runs commands, each step shown to the founder, then reports what it did and what changed. '
        + 'Write a complete brief: the goal, the files or area, how to check it works. It remembers earlier work in the same folder. The founder approves the brief before it starts, and approves each edit and command.',
      parameters: { type: 'object', properties: { brief: { type: 'string', description: 'The full brief for the coder' } }, required: ['brief'] },
      ready: () => null,
      approval: async (_args, context) => (cardFor(context) ? `Start this coding task in ${folder(context)}?` : null),
      run: (args, context) => send(context, text(args, 'brief', 8000)),
    },
    {
      name: 'code_reply', perTurn: 3,
      description: 'Say something more to the coder in the same session: steer it, answer what it asked, or ask for changes to what it just did. Same wait and report as code_task, and the founder approves it the same way.',
      parameters: { type: 'object', properties: { text: { type: 'string', description: 'What to tell the coder' } }, required: ['text'] },
      ready: () => null,
      approval: async (_args, context) => (cardFor(context) ? `Send this to the coder in ${folder(context)}?` : null),
      run: (args, context) => send(context, text(args, 'text', 8000)),
    },
    {
      name: 'code_stop',
      description: 'Stop whatever the coder wired to your room is doing right now. What it already changed stays.',
      parameters: { type: 'object', properties: {} },
      async run(_args, context) {
        const card = need(context);
        const state = coder.snapshot(card.id).state;
        if (state !== 'working' && state !== 'waiting') return { text: 'The coder was not working on anything.' };
        await coder.stop(card.id, `by ${who(context) ?? 'a colleague'}`);
        return { text: 'Stopped. What it changed so far stays in the folder.' };
      },
    },
    {
      name: 'code_status',
      description: 'Where the coder wired to your room is: working or not, its last 20 steps and what has changed in the folder. It does not wait.',
      parameters: { type: 'object', properties: {} },
      async run(_args, context) { return { text: await coder.status(need(context).id) }; },
    },
  ];
}

export default {
  name: 'opencode',
  install(deps: Deps) {
    const forbidden = [deps.workspace, deps.root];
    const bin = findBin();
    const engine = deps.fake ? fakeEngine() : createOpencodeServer({ bin, env: process.env, home: () => writeCoderHome({ workspace: deps.workspace, env: process.env }) });
    coderHealth.now = () => ({ ...engine.health(), bin });

    // The session lives on the card in the saved stage, so the same conversation carries on after a restart.
    async function remember(cardId: string, session: string) {
      const stage = await deps.store.loadStage();
      if (!projects(stage).some((one) => one.id === cardId)) return;
      await deps.store.saveStage({ ...stage, cards: (stage.cards ?? []).map((one) => (one.id === cardId && one.kind === 'project' ? { ...one, session: session || undefined } : one)) });
    }
    // A folder Graphify has mapped: the coder reads that map through Graphify's own tools, told so in one sentence.
    async function map(dir: string) {
      const graph = graphJson(deps.workspace, dir);
      if (!existsSync(graph)) return null;
      const command = deps.fake ? ['graphify-mcp', graph] : mcpCommand(graph);
      return command ? { mcp: graphMcp(command), hint: GRAPH_HINT } : null;
    }
    const coder = createCoder({
      engine, approvals: deps.approvals, attention: deps.attention, remember, env: process.env, map,
      say: (cardId, event: CoderEvent) => hub.say(coderChannel(cardId), event),
    });
    // A map being made writes its lines on the card's own log, kept with the coder's steps.
    const logBefore = cardLog.add;
    cardLog.add = (card, one) => coder.note(card, one);
    // A window that opens late gets each card's log, its question and its state at once.
    const opening = async () => coder.cards().map(({ id }) => {
      const { lines, state, permission, waiting, session, model } = coder.snapshot(id);
      return { channel: coderChannel(id), data: { lines, state, permission: permission ?? null, waiting, session, model } satisfies CoderEvent };
    });
    hub.opening.push(opening);

    const cardOf = async (cardId: string) => projects(await deps.store.loadStage()).find((one) => one.id === cardId);

    return {
      tools: coderTools(coder, forbidden),
      async route(req, res, path) {
        if (path === '/api/coder/models' && req.method === 'GET') {
          try { deps.json(res, 200, await coder.models()); } catch (error) { deps.json(res, 503, { error: (error as Error).message }); }
          return true;
        }
        const asked = /^\/api\/coder\/([\w-]{1,80})(?:\/(ask|stop|undo|new|diff|permission)(?:\/([\w-]{1,120}))?)?$/.exec(path);
        if (!asked) return false;
        const [, cardId, action, permissionId] = asked;
        const card = await cardOf(cardId);
        if (!card) { deps.json(res, 404, { error: 'there is no coder card by that name' }); return true; }
        try {
          if (!action && req.method === 'GET') { deps.json(res, 200, coder.snapshot(cardId)); return true; }
          if (action === 'ask' && req.method === 'POST') {
            // The card's own folder and model as the window has them now: the stage is saved a moment after a change.
            const sent = await deps.body(req);
            const words = String(sent.text ?? '').trim();
            if (!words) { deps.json(res, 400, { error: 'tell the coder what to do first' }); return true; }
            const now = { ...card, ...(typeof sent.path === 'string' ? { path: sent.path } : {}), ...(typeof sent.model === 'string' ? { model: sent.model || undefined } : {}) };
            await coder.prompt(refOf(now, forbidden), words.slice(0, 8000), {});
            deps.json(res, 202, { started: true });
            return true;
          }
          if (action === 'stop' && req.method === 'POST') { await coder.stop(cardId); deps.json(res, 200, { ok: true }); return true; }
          if (action === 'undo' && req.method === 'POST') { await coder.undo(cardId); deps.json(res, 200, { ok: true }); return true; }
          if (action === 'new' && req.method === 'POST') { coder.open(refOf(card, forbidden)); await coder.fresh(cardId); deps.json(res, 200, { ok: true }); return true; }
          if (action === 'diff' && req.method === 'GET') {
            coder.open(refOf(card, forbidden));
            deps.json(res, 200, { files: await coder.patches(cardId) });
            return true;
          }
          if (action === 'permission' && permissionId && req.method === 'POST') {
            const sent = await deps.body(req);
            const reply = sent.reply === 'always' || sent.reply === 'reject' ? sent.reply : 'once';
            await coder.answer(cardId, permissionId, reply, typeof sent.message === 'string' ? sent.message.slice(0, 500) : undefined);
            deps.json(res, 200, { ok: true });
            return true;
          }
        } catch (error) { deps.json(res, 409, { error: (error as Error).message }); return true; }
        return false;
      },
      // The watchdog, the memory check, and folders let go of for cards that left the stage.
      async tick() {
        await coder.tick();
        await coder.forget(new Set(projects(await deps.store.loadStage()).map((one) => one.id)));
      },
      async close() {
        cardLog.add = logBefore;
        const at = hub.opening.indexOf(opening);
        if (at >= 0) hub.opening.splice(at, 1);
        await engine.stop();
      },
    };
  },
} satisfies Slice;
