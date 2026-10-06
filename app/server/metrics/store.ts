import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyMetrics, findMetric, isDay, keyOf, localDay, MAX_METRICS, mergeRows, parseImport, UNITS, type Metric, type Metrics, type MetricsEvent, type TargetProposal, type Unit } from '../../shared/metrics.ts';
import { now as clockNow } from '../clock.ts';

export type MetricsStore = ReturnType<typeof createMetrics>;
export type Imported = { added: number; replaced: number; skipped: string[] };
export type MetricPatch = { label?: string; better?: Metric['better']; unit?: Unit; northStar?: true; target?: { value: number; by: string } | null };

const safe = (id: string) => { if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error(`bad id: ${id}`); return id; };
const newId = () => `target-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const line = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '');

// One file per Metrics card, beside the stage, the way a leads card keeps its list. The server owns it: people and
// the founder's window only ask for changes, and every change is said to whoever listens.
export function createMetrics(dir: string, tell: (cardId: string, event: MetricsEvent) => void = () => {}, now: () => number = clockNow) {
  const path = (cardId: string) => join(dir, 'metrics', `${safe(cardId)}.json`);
  const cache = new Map<string, Metrics>();
  const revs = new Map<string, number>();
  let queue: Promise<unknown> = Promise.resolve();

  async function load(cardId: string): Promise<Metrics> {
    const known = cache.get(cardId);
    if (known) return known;
    const file = path(cardId);
    let data = emptyMetrics();
    try { data = { ...data, ...JSON.parse(await readFile(file, 'utf8')) }; } catch { /* a new card */ }
    cache.set(cardId, data);
    revs.set(cardId, Math.max(revs.get(cardId) ?? 0, now()));
    return data;
  }
  function save(cardId: string) {
    const data = cache.get(cardId)!;
    data.updatedAt = now();
    const text = JSON.stringify(data, null, 2);
    queue = queue.then(async () => { await mkdir(join(dir, 'metrics'), { recursive: true }); await writeFile(`${path(cardId)}.tmp`, text); await rename(`${path(cardId)}.tmp`, path(cardId)); }).catch(() => {});
    revs.set(cardId, Math.max((revs.get(cardId) ?? 0) + 1, now()));
    tell(cardId, { data, rev: revs.get(cardId)! });
  }
  async function metric(cardId: string, ref: string): Promise<Metric> {
    const found = findMetric((await load(cardId)).metrics, ref);
    if (!found) throw new Error(`no number called "${ref.trim()}" on this card`);
    return found;
  }

  return {
    settled: () => queue,
    load,
    async read(cardId: string): Promise<MetricsEvent> { const data = await load(cardId); return { data, rev: revs.get(cardId)! }; },
    metric,
    // A pasted table or a dropped file, read and folded in. What could not be read, or did not fit, is said back.
    async importText(cardId: string, text: string, name: string): Promise<Imported> {
      const parsed = parseImport(text, line(name, 80) || 'pasted');
      const data = await load(cardId);
      if (!parsed.rows.length) return { added: 0, replaced: 0, skipped: parsed.skipped.length ? parsed.skipped : ['no numbers were found'] };
      const merged = mergeRows(data.metrics, parsed.rows);
      data.metrics = merged.metrics;
      save(cardId);
      const full = merged.full.map((label) => `${label}: the card holds ${MAX_METRICS} numbers`);
      return { added: merged.added, replaced: merged.replaced, skipped: [...parsed.skipped, ...full] };
    },
    // One reading, typed by the founder or given by a person the founder said yes to. A new name becomes a new number.
    async log(cardId: string, input: { ref: string; value: number; at?: string; from: string }): Promise<Metric> {
      const label = line(input.ref, 60);
      if (!label) throw new Error('say which number');
      if (!Number.isFinite(input.value)) throw new Error('a reading is a number');
      const at = input.at ?? localDay(now());
      if (!isDay(at)) throw new Error('a day is written YYYY-MM-DD');
      const data = await load(cardId);
      const there = findMetric(data.metrics, label);
      const merged = mergeRows(data.metrics, [{ key: there?.key ?? keyOf(label), label: there?.label ?? label, at, value: input.value, from: line(input.from, 120) || 'founder' }]);
      if (merged.full.length) throw new Error(`the card holds ${MAX_METRICS} numbers; remove one first`);
      data.metrics = merged.metrics;
      save(cardId);
      return findMetric(data.metrics, there?.key ?? keyOf(label))!;
    },
    async change(cardId: string, key: string, patch: MetricPatch): Promise<Metric> {
      const data = await load(cardId);
      const found = await metric(cardId, key);
      if (patch.label !== undefined) { const label = line(patch.label, 60); if (!label) throw new Error('a number needs a name'); found.label = label; }
      if (patch.better !== undefined) { if (patch.better !== 'up' && patch.better !== 'down') throw new Error('better is up or down'); found.better = patch.better; }
      if (patch.unit !== undefined) { if (!(UNITS as readonly string[]).includes(patch.unit)) throw new Error(`a unit is one of ${UNITS.filter(Boolean).join(' ')} or none`); if (patch.unit) found.unit = patch.unit; else delete found.unit; }
      if (patch.northStar) for (const one of data.metrics) { if (one === found) one.northStar = true; else delete one.northStar; }
      if (patch.target === null) delete found.target;
      else if (patch.target) found.target = checkTarget(patch.target);
      save(cardId);
      return found;
    },
    async remove(cardId: string, key: string) {
      const data = await load(cardId);
      const found = await metric(cardId, key);
      data.metrics = data.metrics.filter((one) => one !== found);
      if (found.northStar && data.metrics[0]) data.metrics[0].northStar = true;
      data.proposals = (data.proposals ?? []).filter((one) => one.key !== found.key);
      save(cardId);
    },
    // A target a person suggests waits for the founder; one for the same number replaces the one before it.
    async propose(cardId: string, input: { ref: string; value: number; by: string; who: string; why?: string }): Promise<TargetProposal> {
      const data = await load(cardId);
      const found = await metric(cardId, input.ref);
      const target = checkTarget({ value: input.value, by: input.by });
      const proposal: TargetProposal = { id: newId(), key: found.key, ...target, who: input.who, at: now(), ...(line(input.why, 300) ? { why: line(input.why, 300) } : {}) };
      data.proposals = [...(data.proposals ?? []).filter((one) => one.key !== found.key), proposal];
      save(cardId);
      return proposal;
    },
    async answer(cardId: string, proposalId: string, accept: boolean): Promise<Metric | null> {
      const data = await load(cardId);
      const proposal = (data.proposals ?? []).find((one) => one.id === proposalId);
      if (!proposal) throw new Error('that suggestion was already answered');
      data.proposals = (data.proposals ?? []).filter((one) => one !== proposal);
      const found = findMetric(data.metrics, proposal.key);
      if (accept && found) found.target = { value: proposal.value, by: proposal.by };
      save(cardId);
      return accept ? found ?? null : null;
    },
    async dismiss(cardId: string, alertId: string) {
      const data = await load(cardId);
      if ((data.dismissed ?? []).includes(alertId)) return;
      data.dismissed = [...(data.dismissed ?? []), alertId].slice(-200);
      save(cardId);
    },
  };
}

function checkTarget(target: { value: unknown; by: unknown }): { value: number; by: string } {
  const value = Number(target.value);
  if (!Number.isFinite(value)) throw new Error('a target is a number');
  if (!isDay(target.by)) throw new Error('a target needs a day, written YYYY-MM-DD');
  return { value, by: target.by };
}
