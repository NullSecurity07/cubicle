import type { Attention, Card, Stage } from '../../shared/model.ts';
import {
  CATEGORIES, months, project, proposalTitle, runwayChannel, runwayDetail, runwayLine, todayOf, type RunwayEvent, type RunwayProposal,
} from '../../shared/runway.ts';
import { hub } from '../events.ts';
import type { Slice } from '../install.ts';
import { wired } from '../prompt.ts';
import { createRunways, type RunwayBook } from '../runway/store.ts';
import type { Handler } from '../seams.ts';
import { text, type Tool, type ToolContext } from '../tools/registry.ts';
import { now as clockNow } from '../clock.ts';

// The Runway card: cash, what goes out and comes in, and when it runs out. The numbers are the founder's: a person
// wired to the card reads them and may suggest a flow or a scenario, which waits in Needs you until the founder
// accepts it on the card. Nothing a person says is ever written straight into the numbers.

export const NO_CARD = 'no Runway card is connected to your room. The founder adds one from the dock and draws a wire to it.';
export const RUNWAY_TOOLS = ['read_runway', 'propose_flow', 'propose_scenario'];

type RunwayCard = Extract<Card, { kind: 'runway' }>;
const cardsOf = (stage: Stage) => (stage.cards ?? []).filter((card): card is RunwayCard => card.kind === 'runway');
const cardOf = (context: ToolContext) => { const ids = wired(context.stage, context.roomId, cardsOf(context.stage).map((card) => card.id)); return cardsOf(context.stage).find((card) => card.id === ids[0]); };
const need = (context: ToolContext) => { const card = cardOf(context); if (!card) throw new Error(NO_CARD); return card; };
const who = (context: ToolContext) => ({ by: context.stage.rooms.find((room) => room.id === context.roomId)?.name || 'A person', roomId: context.roomId });
const currencyOf = (card?: RunwayCard) => card?.currency || 'USD';

const FLOW = {
  label: { type: 'string', description: 'What it is, e.g. "Two engineers"' },
  monthly: { type: 'number', description: 'Amount a month. Negative for money out, positive for money in' },
  from: { type: 'string', description: 'First month, YYYY-MM' },
  to: { type: 'string', description: 'Last month, YYYY-MM. Leave out if it carries on' },
  grows: { type: 'number', description: '% a month it grows, for revenue' },
  category: { type: 'string', enum: [...CATEGORIES] },
};

export function runwayTools(book: RunwayBook, now: () => number = clockNow): Tool[] {
  const today = () => todayOf(now());
  return [
    {
      name: 'read_runway', perTurn: 3,
      description: 'Read the Runway card wired to you: cash, each flow, months left, and cash every quarter. Name a scenario to read that plan instead of Base.',
      parameters: { type: 'object', properties: { scenario: { type: 'string', description: 'A scenario\'s name. Leave out for Base' } } },
      async run(args, context) {
        const card = need(context);
        const file = await book.load(card.id);
        const asked = typeof args.scenario === 'string' && args.scenario.trim() && args.scenario.trim().toLowerCase() !== 'base' ? await book.scenarioNamed(card.id, args.scenario) : undefined;
        if (typeof args.scenario === 'string' && args.scenario.trim() && args.scenario.trim().toLowerCase() !== 'base' && !asked) throw new Error(`there is no scenario called "${args.scenario}". The plans are Base${file.scenarios.map((one) => `, "${one.name}"`).join('')}`);
        return { text: runwayDetail(file, asked?.id, today(), currencyOf(card)) };
      },
    },
    {
      name: 'propose_flow', perTurn: 5,
      description: 'Suggest a line of money a month for the Runway card: a hire, a tool, rent, revenue. It waits for the founder to accept. Name a scenario to put it there instead of Base.',
      parameters: { type: 'object', properties: { ...FLOW, scenario: { type: 'string', description: 'A scenario\'s name, when it belongs in one' }, why: { type: 'string', description: 'Why, in a line, with where the number came from' } }, required: ['label', 'monthly', 'from'] },
      async run(args, context) {
        const card = need(context);
        const proposal = await book.proposeFlow(card.id, who(context), args, typeof args.scenario === 'string' && args.scenario.trim() && args.scenario.trim().toLowerCase() !== 'base' ? args.scenario : undefined, typeof args.why === 'string' ? args.why : undefined);
        return { text: `Suggested ${proposalTitle(proposal, [], currencyOf(card))}. It waits in Needs you until the founder accepts it on the card.` };
      },
    },
    {
      name: 'propose_scenario', perTurn: 2,
      description: 'Suggest a what-if plan for the Runway card, e.g. "Hire in January" or "Raise $500k in March": flows to add, Base flows to drop, one-off sums. It waits for the founder to accept.',
      parameters: { type: 'object', properties: {
        name: { type: 'string', description: 'A short name, e.g. "Hire in January"' },
        add: { type: 'array', description: 'Flows this plan adds', items: { type: 'object', properties: FLOW, required: ['label', 'monthly', 'from'] } },
        drop: { type: 'array', description: 'Labels of Base flows this plan stops', items: { type: 'string' } },
        cash: { type: 'array', description: 'One-off sums: a raise is positive, a one-off bill negative', items: { type: 'object', properties: { amount: { type: 'number' }, at: { type: 'string', description: 'Month, YYYY-MM' } }, required: ['amount', 'at'] } },
        why: { type: 'string' },
      }, required: ['name'] },
      async run(args, context) {
        const card = need(context);
        const file = await book.load(card.id);
        const drops = (Array.isArray(args.drop) ? args.drop : []).map((label) => {
          const found = file.flows.find((flow) => flow.label.toLowerCase() === String(label).trim().toLowerCase() || flow.id === label);
          if (!found) throw new Error(`there is no Base flow called "${String(label)}". The flows are ${file.flows.map((flow) => `"${flow.label}"`).join(', ') || 'none yet'}`);
          return { drop: found.id };
        });
        const changes = [
          ...(Array.isArray(args.add) ? args.add : []).map((flow) => ({ add: flow })),
          ...drops,
          ...(Array.isArray(args.cash) ? args.cash : []).map((one) => ({ cash: (one as { amount?: unknown }).amount, at: (one as { at?: unknown }).at })),
        ];
        const proposal = await book.proposeScenario(card.id, who(context), { name: text(args, 'name', 60), changes }, typeof args.why === 'string' ? args.why : undefined);
        return { text: `Suggested ${proposalTitle(proposal, file.flows, currencyOf(card))}. It waits in Needs you until the founder accepts it on the card.` };
      },
    },
  ];
}

export default {
  name: 'runway',
  install(deps) {
    const say = (cardId: string, event: RunwayEvent) => { hub.say(runwayChannel(cardId), event); void deps.attention.refresh().catch(() => {}); };
    const book = createRunways(deps.workspace, say);
    const today = () => todayOf(clockNow());
    const onStage = async () => cardsOf(await deps.store.loadStage());

    const opening = async () => Promise.all((await onStage()).map(async (card) => ({ channel: runwayChannel(card.id), data: await book.read(card.id) })));
    hub.opening.push(opening);

    // What waits for the founder: every suggestion, and a runway that crossed six or three months and was not seen yet.
    deps.attention.source(async (): Promise<Attention[]> => {
      const found: Attention[] = [];
      for (const card of await onStage()) {
        const file = await book.load(card.id);
        for (const proposal of file.proposals ?? []) {
          found.push({ id: `proposed-runway:${card.id}:${proposal.id}`, kind: 'proposed-runway', cardId: card.id, roomId: proposal.roomId, who: proposal.by, at: proposal.at,
            title: `${proposalTitle(proposal, file.flows, currencyOf(card)).replace(/^./, (first) => first.toUpperCase())}${proposal.kind === 'flow' && proposal.into ? `, in "${file.scenarios.find((one) => one.id === proposal.into)?.name ?? 'a scenario'}"` : ''}`,
            detail: [proposal.why, 'Accept or decline it on the Runway card.'].filter(Boolean).join(' ') });
        }
        if (file.alert && !file.alert.seen) {
          const base = project(file, undefined, today());
          found.push({ id: `runway-low:${card.id}:${file.alert.at}`, kind: 'runway-low', cardId: card.id, at: file.alert.at,
            title: base.monthsLeft !== null ? `Cash runs out in ${months(base.monthsLeft)}` : `Cash is under ${file.alert.level} months`,
            detail: base.zero ? `On ${base.zero}, on the Base plan. Mark it seen on the Runway card.` : 'Mark it seen on the Runway card.' });
        }
      }
      return found;
    });

    // A person wired to a Runway card reads it in one compact line, dated, beside the other cards they can reach.
    const before: Handler<'turn:before'> = async (payload, next) => {
      const [system, ...rest] = payload.messages;
      if (system?.role !== 'system') return next(payload);
      const stage = await deps.store.loadStage().catch(() => null);
      const ids = stage ? wired(stage, payload.roomId, cardsOf(stage).map((card) => card.id)) : [];
      if (!stage || !ids.length) return next(payload);
      const lines = await Promise.all(cardsOf(stage).filter((card) => ids.includes(card.id)).map(async (card) => runwayLine(await book.load(card.id), today(), currencyOf(card))));
      return next({ ...payload, messages: [{ ...system, content: `${system.content}\n\n${lines.join('\n')}` }, ...rest] });
    };
    const off = deps.seams ? [deps.seams.on('turn:before', before)] : [];

    return {
      tools: runwayTools(book),
      offer(tools, stage, roomId) {
        if (wired(stage, roomId, cardsOf(stage).map((card) => card.id)).length) return tools;
        return tools.filter((tool) => !RUNWAY_TOOLS.includes(tool.name));
      },
      // The day moves on while the app is open: a runway that was fine this morning may be under six months tonight.
      async tick() {
        for (const card of await onStage()) await book.check(card.id);
      },
      async route(req, res, path) {
        const asked = /^\/api\/runway\/([a-z0-9][a-z0-9-]{0,63})(?:\/(seen|proposals\/(ask-[a-z0-9]{1,40})))?$/.exec(path);
        if (!asked) return false;
        const [, cardId, part, proposalId] = asked;
        if (!(await onStage()).some((card) => card.id === cardId)) { deps.json(res, 404, { error: 'there is no Runway card by that name' }); return true; }
        const method = req.method ?? 'GET';
        try {
          if (!part && method === 'GET') { deps.json(res, 200, await book.read(cardId)); return true; }
          if (!part && method === 'PUT') { await book.put(cardId, await deps.body(req)); await book.check(cardId); deps.json(res, 200, await book.read(cardId)); return true; }
          if (part === 'seen' && method === 'POST') { await book.seen(cardId); deps.json(res, 200, await book.read(cardId)); return true; }
          if (proposalId && method === 'POST') { deps.json(res, 200, await book.accept(cardId, proposalId)); await book.check(cardId); return true; }
          if (proposalId && method === 'DELETE') { await book.decline(cardId, proposalId); deps.json(res, 200, await book.read(cardId)); return true; }
        } catch (error) { deps.json(res, 400, { error: (error as Error).message }); return true; }
        return false;
      },
      async close() {
        for (const stop of off) stop();
        const at = hub.opening.indexOf(opening);
        if (at >= 0) hub.opening.splice(at, 1);
        await book.settled();
      },
    };
  },
} satisfies Slice;
