import { matching, responseLine, surveyBlock, surveyChannel, templateTitle, type SurveyEvent } from '../../shared/survey.ts';
import { localDay, now as clockNow } from '../clock.ts';
import { hub } from '../events.ts';
import type { Slice } from '../install.ts';
import { wired } from '../prompt.ts';
import type { Handler } from '../seams.ts';
import { offerWhenWired } from '../slice-kit.ts';
import { createSurveys, surveyCards, type SurveyCard, type Surveys } from '../surveys/store.ts';
import type { Tool, ToolContext } from '../tools/registry.ts';

// The Survey card: a PMF, NPS or blank survey written on the card, copied out to Tally or Google Forms, and its
// answers imported back from their CSV. The app hosts nothing: the api answers only its own page. Every number is
// counted in `shared/survey.ts`. A wired person reads a two-line summary each turn and the raw answers with read_survey.

export const NO_CARD = 'no Survey card is connected to your room. The founder adds one from the dock and draws a wire to it.';
export const SURVEY_TOOLS = ['read_survey'];
const READ_MOST = 60;

const nameOf = (card: SurveyCard) => card.title?.trim() || templateTitle(card.template ?? 'blank');
const mine = (context: ToolContext) => {
  const cards = surveyCards(context.stage);
  const ids = wired(context.stage, context.roomId, cards.map((card) => card.id));
  return ids.map((id) => cards.find((card) => card.id === id)!);
};

export function surveyTools(surveys: Surveys, now: () => number = Date.now): Tool[] {
  return [{
    name: 'read_survey', perTurn: 3,
    description: 'Read the Survey card wired to you: its questions, its counted summary, and the raw answers one line each. Give "query" to see only answers holding those words.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Words the answers must hold, e.g. "agency" or "monday report"' }, survey: { type: 'string', description: 'Which survey, by title, when more than one is wired' } } },
    async run(args, context) {
      const cards = mine(context);
      if (!cards.length) throw new Error(NO_CARD);
      const asked = typeof args.survey === 'string' ? args.survey.trim().toLowerCase() : '';
      const card = (asked && cards.find((one) => nameOf(one).toLowerCase().includes(asked))) || cards[0];
      const questions = card.questions ?? [];
      const all = await surveys.list(card.id);
      const query = typeof args.query === 'string' ? args.query.trim().slice(0, 120) : '';
      const found = query ? matching(all, query) : all;
      const head = [
        surveyBlock(card, all, localDay(now()), localDay),
        'Questions:', ...questions.map((question, at) => `${at + 1}. [${question.role ?? question.type}] ${question.text.split('{product}').join(card.product?.trim() || 'the product')}`),
      ];
      if (!all.length) return { text: head.join('\n') };
      const shown = found.slice(-READ_MOST);
      const about = query ? `${found.length} of ${all.length} answers hold "${query}"` : `${all.length} answers`;
      const more = found.length > shown.length ? ` (the newest ${shown.length}; narrow with query)` : '';
      return { text: [...head, '', `${about}${more}:`, ...(shown.length ? shown.map((response) => responseLine(questions, response, localDay)) : ['- none'])].join('\n') };
    },
  }];
}

export default {
  name: 'survey',
  install(deps) {
    const say = (cardId: string, event: SurveyEvent) => hub.say(surveyChannel(cardId), event);
    const surveys = createSurveys(deps.workspace, say);
    const onStage = async () => surveyCards(await deps.store.loadStage());
    const unopen = hub.open(async () => Promise.all((await onStage()).map(async (card) => ({ channel: surveyChannel(card.id), data: await surveys.read(card.id) }))));

    // A person wired to a Survey card reads its counted summary in two lines, beside the other cards they can reach.
    const before: Handler<'turn:before'> = async (payload, next) => {
      const [system, ...rest] = payload.messages;
      if (system?.role !== 'system') return next(payload);
      const stage = await deps.store.loadStage().catch(() => null);
      const cards = stage ? surveyCards(stage) : [];
      const ids = stage ? wired(stage, payload.roomId, cards.map((card) => card.id)) : [];
      if (!ids.length) return next(payload);
      const today = localDay(clockNow());
      const blocks = await Promise.all(cards.filter((card) => ids.includes(card.id)).map(async (card) => surveyBlock(card, await surveys.list(card.id), today, localDay)));
      return next({ ...payload, messages: [{ ...system, content: `${system.content}\n\n${blocks.join('\n')}` }, ...rest] });
    };
    // In fake mode only: the survey lines exactly as the last model call saw them, for a browser test to read back.
    const heard = new Map<string, string>();
    const step: Handler<'step:before'> = async (payload, next) => {
      const system = payload.messages[0];
      if (system?.role === 'system' && typeof system.content === 'string') {
        const lines = system.content.split('\n');
        const from = lines.findIndex((line) => /^- (PMF |NPS )?[Ss]urvey "/.test(line));
        heard.set(payload.roomId, from < 0 ? '' : [lines[from], ...(lines[from + 1]?.startsWith('  ') ? [lines[from + 1]] : [])].join('\n'));
      }
      return next(payload);
    };
    const off = deps.seams ? [deps.seams.on('turn:before', before), ...(deps.fake ? [deps.seams.on('step:before', step)] : [])] : [];

    return {
      tools: surveyTools(surveys),
      // Offered only to a person with a Survey card wired to them.
      offer: offerWhenWired('survey', SURVEY_TOOLS),
      async route(req, res, path) {
        const asked = /^\/api\/surveys\/([a-z0-9][a-z0-9-]{0,63})(?:\/(import|heard)(?:\/([a-z0-9][a-z0-9-]{0,63}))?)?$/.exec(path);
        if (!asked) return false;
        const [, cardId, part, item] = asked;
        const card = (await onStage()).find((one) => one.id === cardId);
        if (!card) { deps.json(res, 404, { error: 'there is no Survey card by that name' }); return true; }
        const method = req.method ?? 'GET';
        try {
          if (!part && method === 'GET') { deps.json(res, 200, await surveys.read(cardId)); return true; }
          if (!part && method === 'DELETE') { await surveys.clear(cardId); deps.json(res, 200, { ok: true }); return true; }
          if (part === 'heard' && item && method === 'GET' && deps.fake) { deps.json(res, 200, { text: heard.get(item) ?? '' }); return true; }
          if (part === 'import' && method === 'POST') {
            const sent = await deps.body(req);
            deps.json(res, 200, await surveys.importText(cardId, String(sent?.text ?? '').slice(0, 2_000_000), String(sent?.name ?? 'pasted'), card.questions ?? [], card.product));
            return true;
          }
        } catch (error) { deps.json(res, 400, { error: (error as Error).message }); return true; }
        return false;
      },
      async close() {
        for (const stop of off) stop();
        unopen();
        await surveys.settled();
      },
    };
  },
} satisfies Slice;
