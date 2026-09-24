import { alerts, findMetric, formatValue, isDay, localDay, metricsBlock, metricsChannel, type Metric, type MetricAlert, type MetricsEvent, type Period } from '../../shared/metrics.ts';
import type { Attention, Card, Stage } from '../../shared/model.ts';
import { hub } from '../events.ts';
import type { Deps, Slice } from '../install.ts';
import { createMetrics, type MetricPatch, type MetricsStore } from '../metrics/store.ts';
import { wired } from '../prompt.ts';
import type { Handler } from '../seams.ts';
import { text, type Tool, type ToolContext } from '../tools/registry.ts';

// The Metrics card: the founder's north star and a few numbers beside it, with how they moved, which way they have
// been going and whether a target is in reach. Every sum is TypeScript. A wired person reads the numbers, and may
// suggest a target or a reading; a reading only lands once the founder has said yes to it.

export const NO_CARD = 'no Metrics card is connected to your room. The founder adds one from the dock and draws a wire to it.';
export const METRIC_TOOLS = ['read_metrics', 'log_metric', 'propose_target'];
const READ_POINTS = 60;

type MetricsCard = Extract<Card, { kind: 'metrics' }>;
const cardsOf = (stage: Stage) => (stage.cards ?? []).filter((card): card is MetricsCard => card.kind === 'metrics');
const periodOf = (card?: MetricsCard): Period => (card?.period === 'month' ? 'month' : 'week');
const cardOf = (context: ToolContext) => {
  const cards = cardsOf(context.stage);
  const id = wired(context.stage, context.roomId, cards.map((card) => card.id))[0];
  if (!id) throw new Error(NO_CARD);
  return cards.find((card) => card.id === id)!;
};
const nameOf = (context: ToolContext) => context.stage.rooms.find((room) => room.id === context.roomId)?.name ?? 'a person';
const numberOf = (args: Record<string, unknown>, key: string) => {
  const value = typeof args[key] === 'string' ? Number(String(args[key]).replace(/[,$€£%\s]/g, '')) : Number(args[key]);
  if (!Number.isFinite(value)) throw new Error(`"${key}" must be a number`);
  return value;
};

// A number's readings as lines a weak model can hold: the newest last, each with where it came from.
export function readingLines(metric: Metric, since?: string): string {
  const points = metric.points.filter((point) => !since || point.at >= since).slice(-READ_POINTS);
  const about = [`key ${metric.key}`, `better ${metric.better}`, metric.target ? `target ${formatValue(metric.target.value, metric.unit)} by ${metric.target.by}` : '', metric.northStar ? 'north star' : ''].filter(Boolean).join(', ');
  return [`${metric.label} (${about})`, ...(points.length ? points.map((point) => `- ${point.at}: ${formatValue(point.value, metric.unit)} · ${point.from}`) : ['- no readings' + (since ? ` since ${since}` : '')])].join('\n');
}

export function metricTools(store: MetricsStore, changed: () => Promise<void>, now: () => number = Date.now): Tool[] {
  return [
    {
      name: 'read_metrics', perTurn: 3,
      description: 'Read the Metrics card wired to you: every reading with its day and where it came from. Give "key" for one number, "since" (YYYY-MM-DD) for the recent ones.',
      parameters: { type: 'object', properties: { key: { type: 'string', description: 'The number\'s name or key' }, since: { type: 'string', description: 'YYYY-MM-DD' } } },
      async run(args, context) {
        const card = cardOf(context);
        const data = await store.load(card.id);
        const since = typeof args.since === 'string' && args.since.trim() ? args.since.trim() : undefined;
        if (since && !isDay(since)) throw new Error('"since" is a day, written YYYY-MM-DD');
        const key = typeof args.key === 'string' ? args.key.trim() : '';
        const shown = key ? [await store.metric(card.id, key)] : data.metrics;
        if (!shown.length) return { text: 'The Metrics card is empty. Ask the founder to paste their numbers on it.' };
        return { text: `${card.title ? `"${card.title}", ` : ''}${periodOf(card) === 'month' ? 'monthly' : 'weekly'} card; today is ${localDay(now())}.\n\n${shown.map((metric) => readingLines(metric, since)).join('\n\n')}` };
      },
    },
    {
      name: 'log_metric', perTurn: 3,
      description: 'Write one reading on the Metrics card, only a number the founder gave you (in this chat or a file). The founder is asked first. Say where it came from in "source".',
      parameters: { type: 'object', properties: { key: { type: 'string', description: 'The number\'s name or key' }, value: { type: 'number' }, at: { type: 'string', description: 'YYYY-MM-DD, today if left out' }, source: { type: 'string', description: 'Where the number came from, e.g. "founder in chat" or "stripe export, 24 Sep"' } }, required: ['key', 'value', 'source'] },
      // Always asked: a number on this card is the founder's to give.
      approval: async (args, context) => {
        const card = cardOf(context);
        const metric = findMetric((await store.load(card.id)).metrics, String(args.key ?? ''));
        const value = Number(args.value);
        const at = typeof args.at === 'string' && args.at ? args.at : localDay(now());
        return `Write ${Number.isFinite(value) ? formatValue(value, metric?.unit) : String(args.value)} for ${metric?.label ?? `a new number, ${String(args.key ?? '')}`} on ${at}?`;
      },
      async run(args, context) {
        const card = cardOf(context);
        const at = typeof args.at === 'string' && args.at.trim() ? args.at.trim() : undefined;
        if (at && !isDay(at)) throw new Error('"at" is a day, written YYYY-MM-DD');
        const source = text(args, 'source', 120);
        const metric = await store.log(card.id, { ref: text(args, 'key', 60), value: numberOf(args, 'value'), at, from: `${source || 'unsaid'}, logged by ${nameOf(context)}` });
        await changed();
        const point = metric.points.find((one) => one.at === (at ?? localDay(now())))!;
        return { text: `Wrote ${formatValue(point.value, metric.unit)} for ${metric.label} on ${point.at}.` };
      },
    },
    {
      name: 'propose_target',
      perTurn: 2,
      description: 'Suggest a target for one number on the Metrics card: a value to reach by a day. It waits in Needs you until the founder accepts or declines it.',
      parameters: { type: 'object', properties: { key: { type: 'string', description: 'The number\'s name or key' }, value: { type: 'number' }, by: { type: 'string', description: 'YYYY-MM-DD' }, why: { type: 'string', description: 'One line on why this target' } }, required: ['key', 'value', 'by'] },
      async run(args, context) {
        const card = cardOf(context);
        const proposal = await store.propose(card.id, { ref: text(args, 'key', 60), value: numberOf(args, 'value'), by: text(args, 'by', 10), who: nameOf(context), why: typeof args.why === 'string' ? args.why : '' });
        await changed();
        const metric = await store.metric(card.id, proposal.key);
        return { text: `Suggested ${formatValue(proposal.value, metric.unit)} by ${proposal.by} for ${metric.label}. It waits in Needs you for the founder.` };
      },
    },
  ];
}

// What waits for the founder on every Metrics card: targets suggested, and alerts not yet waved away. An alert is
// dated from the moment this app first saw it, so one about a quiet fortnight does not sort as a fortnight old.
export function metricsAttention(store: MetricsStore, loadStage: () => Promise<Stage>, seen: Map<string, number>, now: () => number = Date.now) {
  return async (): Promise<Attention[]> => {
    const stage = await loadStage();
    const found: Attention[] = [];
    for (const card of cardsOf(stage)) {
      const data = await store.load(card.id);
      for (const proposal of data.proposals ?? []) {
        const metric = findMetric(data.metrics, proposal.key);
        if (!metric) continue;
        found.push({ id: `proposed-target:${card.id}:${proposal.id}`, kind: 'proposed-target', cardId: card.id, who: proposal.who, at: proposal.at,
          title: `${metric.label}: ${formatValue(proposal.value, metric.unit)} by ${proposal.by}`,
          detail: [proposal.why, `Now ${formatValue(metric.points.at(-1)?.value ?? 0, metric.unit)}${metric.target ? `; the target today is ${formatValue(metric.target.value, metric.unit)} by ${metric.target.by}` : ''}.`].filter(Boolean).join(' ') });
      }
      for (const alert of cardAlerts(card, data.metrics, data.dismissed ?? [], now)) {
        if (!seen.has(alert.id)) seen.set(alert.id, now());
        found.push({ id: alert.id, kind: 'metric-alert', cardId: card.id, at: seen.get(alert.id)!, title: alert.title, detail: alert.detail });
      }
    }
    return found;
  };
}
const cardAlerts = (card: MetricsCard, metrics: Metric[], dismissed: string[], now: () => number): MetricAlert[] =>
  alerts(card.id, metrics, periodOf(card), localDay(now())).filter((alert) => !dismissed.includes(alert.id));

export default {
  name: 'metrics',
  install(deps: Deps) {
    const say = (cardId: string, event: MetricsEvent) => hub.say(metricsChannel(cardId), event);
    const store = createMetrics(deps.workspace, say);
    const onStage = async () => cardsOf(await deps.store.loadStage());
    const seen = new Map<string, number>();
    // Whatever changed a card may have raised or settled something in Needs you.
    const changed = async () => { await deps.attention?.refresh().catch(() => {}); };
    deps.attention?.source(metricsAttention(store, () => deps.store.loadStage(), seen));

    const opening = async () => Promise.all((await onStage()).map(async (card) => ({ channel: metricsChannel(card.id), data: await store.read(card.id) })));
    hub.opening.push(opening);

    // A person wired to a Metrics card reads its numbers in a few lines, beside the other cards they can reach.
    const before: Handler<'turn:before'> = async (payload, next) => {
      const [system, ...rest] = payload.messages;
      if (system?.role !== 'system') return next(payload);
      const stage = await deps.store.loadStage().catch(() => null);
      const cards = stage ? cardsOf(stage) : [];
      const mine = stage ? wired(stage, payload.roomId, cards.map((card) => card.id)) : [];
      if (!mine.length) return next(payload);
      const today = localDay(Date.now());
      const blocks = await Promise.all(cards.filter((card) => mine.includes(card.id)).map(async (card) => metricsBlock(card.title, (await store.load(card.id)).metrics, periodOf(card), today)));
      return next({ ...payload, messages: [{ ...system, content: `${system.content}\n\n${blocks.join('\n')}` }, ...rest] });
    };
    // In fake mode only: the Metrics lines exactly as the last model call saw them, for a browser test to read back.
    const heard = new Map<string, string>();
    const step: Handler<'step:before'> = async (payload, next) => {
      const system = payload.messages[0];
      if (system?.role === 'system' && typeof system.content === 'string') heard.set(payload.roomId, system.content.split('\n').filter((one, index, all) => one.startsWith('- A Metrics card') || (index > 0 && all.slice(0, index).some((line) => line.startsWith('- A Metrics card')) && /^ {2}\S/.test(one))).join('\n'));
      return next(payload);
    };
    const off = deps.seams ? [deps.seams.on('turn:before', before), ...(deps.fake ? [deps.seams.on('step:before', step)] : [])] : [];

    // Alerts come up on their own: a new day can make a number quiet without anybody touching it.
    let known: Set<string> | null = null;
    async function tick() {
      const now = new Set<string>();
      const fresh: MetricAlert[] = [];
      for (const card of await onStage()) {
        const data = await store.load(card.id);
        for (const alert of cardAlerts(card, data.metrics, data.dismissed ?? [], Date.now)) { now.add(alert.id); if (known && !known.has(alert.id)) fresh.push(alert); }
      }
      const first = known === null;
      known = now;
      if (first || !fresh.length) return;
      await changed();
      deps.notify?.(fresh[0].title, fresh[0].detail);
    }

    return {
      tools: metricTools(store, changed),
      offer(tools, stage, roomId) {
        if (wired(stage, roomId, cardsOf(stage).map((card) => card.id)).length) return tools;
        return tools.filter((tool) => !METRIC_TOOLS.includes(tool.name));
      },
      tick,
      async route(req, res, path) {
        const asked = /^\/api\/metrics\/([a-z0-9][a-z0-9-]{0,63})(?:\/(import|log|dismiss|numbers|proposals|heard)(?:\/([a-z0-9][a-z0-9-]{0,63}))?)?$/.exec(path);
        if (!asked) return false;
        const [, cardId, part, item] = asked;
        if (!(await onStage()).some((card) => card.id === cardId)) { deps.json(res, 404, { error: 'there is no Metrics card by that name' }); return true; }
        const method = req.method ?? 'GET';
        try {
          if (!part && method === 'GET') { deps.json(res, 200, await store.read(cardId)); return true; }
          if (part === 'heard' && item && method === 'GET' && deps.fake) { deps.json(res, 200, { text: heard.get(item) ?? '' }); return true; }
          if (part === 'import' && method === 'POST') {
            const sent = await deps.body(req);
            const result = await store.importText(cardId, String(sent?.text ?? '').slice(0, 2_000_000), String(sent?.name ?? 'pasted'));
            await changed();
            deps.json(res, 200, result);
            return true;
          }
          if (part === 'log' && method === 'POST') {
            const sent = await deps.body(req);
            const at = typeof sent?.at === 'string' && sent.at ? sent.at : undefined;
            const metric = await store.log(cardId, { ref: String(sent?.key ?? ''), value: Number(sent?.value), at, from: 'founder, typed' });
            await changed();
            deps.json(res, 200, metric);
            return true;
          }
          if (part === 'numbers' && item && method === 'PATCH') {
            const sent = (await deps.body(req)) as MetricPatch;
            const metric = await store.change(cardId, item, sent ?? {});
            await changed();
            deps.json(res, 200, metric);
            return true;
          }
          if (part === 'numbers' && item && method === 'DELETE') { await store.remove(cardId, item); await changed(); deps.json(res, 200, { ok: true }); return true; }
          if (part === 'proposals' && item && method === 'POST') {
            const sent = await deps.body(req);
            const metric = await store.answer(cardId, item, sent?.accept === true);
            await changed();
            deps.json(res, 200, { ok: true, metric });
            return true;
          }
          if (part === 'dismiss' && method === 'POST') {
            const id = String((await deps.body(req))?.id ?? '');
            if (!id.startsWith(`metric-alert:${cardId}:`)) { deps.json(res, 400, { error: 'that is not an alert on this card' }); return true; }
            await store.dismiss(cardId, id);
            await changed();
            deps.json(res, 200, { ok: true });
            return true;
          }
        } catch (error) { deps.json(res, 400, { error: (error as Error).message }); return true; }
        return false;
      },
      async close() {
        for (const stop of off) stop();
        const at = hub.opening.indexOf(opening);
        if (at >= 0) hub.opening.splice(at, 1);
        await store.settled();
      },
    };
  },
} satisfies Slice;

