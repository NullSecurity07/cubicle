import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  alertLevel, cleanFlow, cleanRunway, cleanScenario, emptyRunway, MAX_SCENARIOS, monthOf, newRunwayId, project, todayOf,
  type Flow, type RunwayEvent, type RunwayFile, type RunwayProposal, type Scenario,
} from '../../shared/runway.ts';

export type RunwayBook = ReturnType<typeof createRunways>;
const safe = (id: string) => { if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error(`bad id: ${id}`); return id; };
const MAX_PROPOSALS = 20;

// One file per Runway card, beside the stage, owned by the server. The founder's window writes the numbers; a person
// only ever proposes, and a proposal counts once the founder accepts it on the card.
export function createRunways(dir: string, tell: (cardId: string, event: RunwayEvent) => void = () => {}, now: () => number = Date.now) {
  const path = (cardId: string) => join(dir, 'runway', `${safe(cardId)}.json`);
  const cache = new Map<string, RunwayFile>();
  const revs = new Map<string, number>();
  let queue: Promise<unknown> = Promise.resolve();
  const today = () => todayOf(now());

  async function load(cardId: string): Promise<RunwayFile> {
    const known = cache.get(cardId);
    if (known) return known;
    let file: RunwayFile = emptyRunway(today());
    try {
      const saved = JSON.parse(await readFile(path(cardId), 'utf8')) as RunwayFile;
      file = { ...cleanRunway(saved, today()), proposals: Array.isArray(saved.proposals) ? saved.proposals : [], ...(saved.alert ? { alert: saved.alert } : {}) };
    } catch { /* a new card, or a file that no longer reads: start clean rather than refuse */ }
    cache.set(cardId, file);
    revs.set(cardId, Math.max(revs.get(cardId) ?? 0, now()));
    return file;
  }
  const eventOf = (cardId: string, file: RunwayFile): RunwayEvent => ({
    runway: { cash: file.cash, flows: file.flows, scenarios: file.scenarios }, proposals: file.proposals ?? [], ...(file.alert ? { alert: file.alert } : {}), rev: revs.get(cardId)!,
  });
  function save(cardId: string) {
    const file = cache.get(cardId)!;
    const text = JSON.stringify(file, null, 2);
    queue = queue.then(async () => { await mkdir(join(dir, 'runway'), { recursive: true }); await writeFile(`${path(cardId)}.tmp`, text); await rename(`${path(cardId)}.tmp`, path(cardId)); }).catch(() => {});
    revs.set(cardId, Math.max((revs.get(cardId) ?? 0) + 1, now()));
    tell(cardId, eventOf(cardId, file));
  }
  const scenarioNamed = (file: RunwayFile, name: string) => file.scenarios.find((one) => one.name.toLowerCase() === name.trim().toLowerCase() || one.id === name.trim());

  return {
    settled: () => queue,
    load,
    async read(cardId: string): Promise<RunwayEvent> { return eventOf(cardId, await load(cardId)); },
    // The founder's own numbers, whole. Proposals and the alert stay as they were.
    async put(cardId: string, input: unknown): Promise<RunwayEvent> {
      const file = await load(cardId);
      const clean = cleanRunway(input, today());
      cache.set(cardId, { ...file, ...clean });
      save(cardId);
      return eventOf(cardId, cache.get(cardId)!);
    },
    scenarioNamed: async (cardId: string, name: string) => scenarioNamed(await load(cardId), name),
    async proposeFlow(cardId: string, who: { by: string; roomId?: string }, input: unknown, into?: string, why?: string): Promise<RunwayProposal> {
      const file = await load(cardId);
      const flow: Flow = cleanFlow({ ...(input as object), id: undefined }, monthOf(file.cash.asOf));
      const scenario = into ? scenarioNamed(file, into) : undefined;
      if (into && !scenario) throw new Error(`there is no scenario called "${into}". The plans are Base${file.scenarios.map((one) => `, "${one.name}"`).join('')}`);
      return add(cardId, { id: newRunwayId('ask'), ...who, at: now(), ...(why ? { why: why.slice(0, 400) } : {}), kind: 'flow', flow, ...(scenario ? { into: scenario.id } : {}) });
    },
    async proposeScenario(cardId: string, who: { by: string; roomId?: string }, input: unknown, why?: string): Promise<RunwayProposal> {
      const file = await load(cardId);
      const scenario: Scenario = cleanScenario({ ...(input as object), id: undefined }, monthOf(file.cash.asOf), new Set(file.flows.map((flow) => flow.id)));
      if (!scenario.changes.length) throw new Error('a scenario needs at least one change: a flow to add, a Base flow to drop, or a one-off sum');
      if (file.scenarios.length >= MAX_SCENARIOS) throw new Error(`the card already has ${MAX_SCENARIOS} scenarios beside Base. Ask the founder to remove one first`);
      if (scenarioNamed(file, scenario.name)) throw new Error(`there is already a scenario called "${scenario.name}"`);
      return add(cardId, { id: newRunwayId('ask'), ...who, at: now(), ...(why ? { why: why.slice(0, 400) } : {}), kind: 'scenario', scenario });
    },
    // The founder says yes: the flow joins Base or its scenario, or the scenario joins the tabs.
    async accept(cardId: string, proposalId: string): Promise<RunwayEvent> {
      const file = await load(cardId);
      const proposal = (file.proposals ?? []).find((one) => one.id === proposalId);
      if (!proposal) throw new Error('that suggestion is not waiting any more');
      const flows = [...file.flows];
      let scenarios = [...file.scenarios];
      if (proposal.kind === 'flow') {
        const flow = { ...proposal.flow, id: newRunwayId('flow') };
        const into = scenarios.find((one) => one.id === proposal.into);
        if (proposal.into && !into) throw new Error('the scenario it was for has been removed');
        if (into) scenarios = scenarios.map((one) => (one === into ? { ...one, changes: [...one.changes, { add: flow }] } : one));
        else flows.push(flow);
      } else {
        if (scenarios.length >= MAX_SCENARIOS) throw new Error(`there are already ${MAX_SCENARIOS} scenarios beside Base. Remove one first`);
        const ids = new Set(flows.map((flow) => flow.id));
        scenarios.push({ ...proposal.scenario, id: newRunwayId('plan'), changes: proposal.scenario.changes.filter((change) => !('drop' in change) || ids.has(change.drop)) });
      }
      const clean = cleanRunway({ cash: file.cash, flows, scenarios }, today());
      cache.set(cardId, { ...file, ...clean, proposals: (file.proposals ?? []).filter((one) => one.id !== proposalId) });
      save(cardId);
      return eventOf(cardId, cache.get(cardId)!);
    },
    async decline(cardId: string, proposalId: string) {
      const file = await load(cardId);
      if (!(file.proposals ?? []).some((one) => one.id === proposalId)) return;
      cache.set(cardId, { ...file, proposals: (file.proposals ?? []).filter((one) => one.id !== proposalId) });
      save(cardId);
    },
    // Worked out on every tick: the stricter threshold is raised once, and it goes away once cash is back above six
    // months. Says whether anything changed, so the tick knows to tell Needs you.
    async check(cardId: string): Promise<boolean> {
      const file = await load(cardId);
      const level = file.cash.amount || file.flows.length ? alertLevel(project(file, undefined, today()).monthsLeft) : null;
      if (level === null) {
        if (!file.alert) return false;
        cache.set(cardId, { ...file, alert: undefined });
        save(cardId);
        return true;
      }
      if (file.alert?.level === level) return false;
      // Back from under three to under six: the line turns amber, and nothing is raised again.
      const alert = file.alert && file.alert.level < level ? { ...file.alert, level } : { level, at: now() };
      cache.set(cardId, { ...file, alert });
      save(cardId);
      return true;
    },
    async seen(cardId: string) {
      const file = await load(cardId);
      if (!file.alert || file.alert.seen) return;
      cache.set(cardId, { ...file, alert: { ...file.alert, seen: true } });
      save(cardId);
    },
    forget(cardId: string) { cache.delete(cardId); },
  };

  async function add(cardId: string, proposal: RunwayProposal): Promise<RunwayProposal> {
    const file = await load(cardId);
    const waiting = file.proposals ?? [];
    if (waiting.length >= MAX_PROPOSALS) throw new Error(`${MAX_PROPOSALS} suggestions are already waiting for the founder. Let them answer those first`);
    cache.set(cardId, { ...file, proposals: [...waiting, proposal] });
    save(cardId);
    return proposal;
  }
}
