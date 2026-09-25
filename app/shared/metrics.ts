// The founder's numbers: a north star and a few beside it, one reading a day at most, each reading saying where it
// came from. Everything worked out about them (how much they moved, which way they have been going, whether a target
// is in reach) is worked out here, in plain arithmetic, and never by asking a model: a person reads these sums as
// text, and may only ever propose a number, never make one up.

export const UNITS = ['', '%', '$', '€', '£'] as const;
export type Unit = (typeof UNITS)[number];
export type Period = 'week' | 'month';
// `at` is a calendar day, YYYY-MM-DD. `from` is who or what gave the number: 'founder', a file and its row, a person
// the founder said yes to.
export type MetricPoint = { at: string; value: number; from: string };
export type Metric = {
  key: string; label: string; unit?: Unit;
  better: 'up' | 'down'; northStar?: true;
  target?: { value: number; by: string };
  points: MetricPoint[];
};
// A target a person suggested, waiting in Needs you for the founder.
export type TargetProposal = { id: string; key: string; value: number; by: string; who: string; why?: string; at: number };
// The sidecar at `workspace/metrics/<cardId>.json`, owned by the server. `dismissed` holds the alerts the founder waved away.
export type Metrics = { metrics: Metric[]; updatedAt: number; proposals?: TargetProposal[]; dismissed?: string[] };
// What a metrics card hears on the one live feed: the whole sidecar after every change, with a revision that only grows.
export type MetricsEvent = { data: Metrics; rev: number };
export const metricsChannel = (cardId: string) => `metrics:${cardId}`;

// One north star and six beside it: a card, not a spreadsheet.
export const MAX_METRICS = 7;
export const MAX_POINTS = 400;
export const SPARK = 12;
export const emptyMetrics = (): Metrics => ({ metrics: [], updatedAt: 0 });

// ---------------------------------------------------------------- days and periods

const DAY = 86_400_000;
const pad = (value: number) => String(value).padStart(2, '0');
const utc = (at: string) => Date.parse(`${at}T00:00:00Z`);
const iso = (ms: number) => { const day = new Date(ms); return `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}`; };
export const isDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && iso(utc(value)) === value;
// The founder's own calendar day for a moment, as YYYY-MM-DD.
export const localDay = (at: number) => { const day = new Date(at); return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`; };
export const daysBetween = (from: string, to: string) => Math.round((utc(to) - utc(from)) / DAY);
// The week a day falls in is named by its Monday; a month by its first day.
export function periodOf(at: string, period: Period): string {
  if (period === 'month') return `${at.slice(0, 7)}-01`;
  const ms = utc(at);
  return iso(ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY);
}
export const PERIOD_DAYS: Record<Period, number> = { week: 7, month: 30 };

// ---------------------------------------------------------------- the sums

// One reading a period: the last one in it. A metric here is a level (teams active, money in each month), so the
// newest reading of a week is that week's number.
export function series(metric: Pick<Metric, 'points'>, period: Period): MetricPoint[] {
  const out: MetricPoint[] = [];
  let last = '';
  for (const point of [...metric.points].sort((a, b) => a.at.localeCompare(b.at))) {
    const key = periodOf(point.at, period);
    if (key === last) out[out.length - 1] = point; else out.push(point);
    last = key;
  }
  return out;
}

export type Delta = { now: number; before?: number; abs?: number; pct?: number | null };
// How far the newest period moved from the one before it. `pct` is null when the one before was nought.
export function delta(metric: Pick<Metric, 'points'>, period: Period): Delta | null {
  const all = series(metric, period);
  const last = all.at(-1);
  if (!last) return null;
  const prev = all.at(-2);
  if (!prev) return { now: last.value };
  const abs = round(last.value - prev.value);
  return { now: last.value, before: prev.value, abs, pct: prev.value === 0 ? null : Math.round((abs / Math.abs(prev.value)) * 100) };
}

export type Trend = { dir: 'up' | 'down' | 'flat'; n: number };
// How many periods in a row it has moved the same way, counting back from the newest.
export function trend(metric: Pick<Metric, 'points'>, period: Period): Trend {
  const values = series(metric, period).map((point) => point.value);
  let dir: Trend['dir'] = 'flat';
  let n = 0;
  for (let at = values.length - 1; at > 0; at--) {
    const step = values[at] - values[at - 1];
    const way = step > 0 ? 'up' : step < 0 ? 'down' : 'flat';
    if (way === 'flat' || (dir !== 'flat' && way !== dir)) break;
    dir = way;
    n++;
  }
  return { dir, n };
}
// Periods in a row it got worse, by the metric's own idea of better.
export const worsening = (metric: Metric, period: Period) => {
  const { dir, n } = trend(metric, period);
  return dir !== 'flat' && dir !== metric.better ? n : 0;
};

export type Pace = { state: 'none' | 'met' | 'on' | 'behind' | 'missed'; gap?: number };
// Whether the target is in reach: a straight line from the first reading to the target on its day, and where the
// newest reading sits against that line on its own day. `gap` is how far behind, as a share of where it should be.
export function pace(metric: Metric, today: string): Pace {
  const target = metric.target;
  const points = [...metric.points].sort((a, b) => a.at.localeCompare(b.at));
  const first = points[0];
  const last = points.at(-1);
  if (!target || !first || !last) return { state: 'none' };
  const good = (value: number) => (metric.better === 'up' ? value >= target.value : value <= target.value);
  if (good(last.value)) return { state: 'met' };
  if (today > target.by) return { state: 'missed' };
  const span = daysBetween(first.at, target.by);
  const share = span > 0 ? Math.min(1, Math.max(0, daysBetween(first.at, last.at) / span)) : 1;
  const expected = first.value + (target.value - first.value) * share;
  const short = metric.better === 'up' ? expected - last.value : last.value - expected;
  if (short <= 0) return { state: 'on' };
  const scale = Math.abs(expected) || Math.abs(target.value - first.value) || 1;
  return { state: 'behind', gap: Math.max(1, Math.round((short / scale) * 100)) };
}

// ---------------------------------------------------------------- alerts

export type MetricAlert = { id: string; key: string; kind: 'target' | 'falling' | 'quiet'; title: string; detail: string; at: string };
export const FALLING = 3;
// What deserves the founder's eye on one card: a target reached, three periods worse in a row, or two periods with no
// reading at all. Each id names the moment it is about, so one the founder dismissed stays dismissed and a new one
// (next week's fall, a new target) comes up again.
export function alerts(cardId: string, metrics: Metric[], period: Period, today: string): MetricAlert[] {
  const found: MetricAlert[] = [];
  const word = period === 'week' ? 'weeks' : 'months';
  for (const metric of metrics) {
    const all = series(metric, period);
    const last = all.at(-1);
    if (!last) continue;
    const id = (kind: MetricAlert['kind'], mark: string) => `metric-alert:${cardId}:${metric.key}:${kind}:${mark}`;
    if (metric.target && pace(metric, today).state === 'met') {
      found.push({ id: id('target', `${metric.target.value}@${metric.target.by}`), key: metric.key, kind: 'target', at: last.at,
        title: `${metric.label} reached its target`, detail: `${formatValue(last.value, metric.unit)} on ${last.at}; the target was ${formatValue(metric.target.value, metric.unit)} by ${metric.target.by}.` });
    }
    const worse = worsening(metric, period);
    if (worse >= FALLING) {
      found.push({ id: id('falling', periodOf(last.at, period)), key: metric.key, kind: 'falling', at: last.at,
        title: `${metric.label} got worse ${worse} ${word} in a row`, detail: `From ${formatValue(all[all.length - 1 - worse].value, metric.unit)} to ${formatValue(last.value, metric.unit)}, last entry ${last.at}.` });
    }
    const quiet = daysBetween(last.at, today);
    if (quiet >= 2 * PERIOD_DAYS[period]) {
      found.push({ id: id('quiet', last.at), key: metric.key, kind: 'quiet', at: last.at,
        title: `No entry for ${metric.label} in ${quiet} days`, detail: `The last one was ${formatValue(last.value, metric.unit)} on ${last.at}. Type today's on the card, or paste the latest.` });
    }
  }
  return found;
}

// ---------------------------------------------------------------- words

const GROUPED = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const MINUS = '−';
export const round = (value: number) => Math.round(value * 100) / 100;
export function formatValue(value: number, unit: Unit = ''): string {
  const body = GROUPED.format(Math.abs(value));
  const sign = value < 0 ? MINUS : '';
  if (unit === '%') return `${sign}${body}%`;
  return unit ? `${sign}${unit}${body}` : `${sign}${body}`;
}
// A change, always signed. A change in a percentage is in points, so "+2 pts" never reads as "grew 2%".
export function formatChange(value: number, unit: Unit = ''): string {
  const sign = value > 0 ? '+' : value < 0 ? MINUS : '±';
  const body = GROUPED.format(Math.abs(value));
  if (unit === '%') return `${sign}${body} pts`;
  return `${sign}${unit}${body}`;
}
export const formatPct = (pct: number) => `${pct > 0 ? '+' : pct < 0 ? MINUS : '±'}${Math.abs(pct)}%`;
export function paceWords(metric: Metric, today: string): string {
  const now = pace(metric, today);
  if (now.state === 'none' || !metric.target) return '';
  const target = `target ${formatValue(metric.target.value, metric.unit)} by ${metric.target.by}`;
  return now.state === 'met' ? `${target}, reached` : now.state === 'missed' ? `${target}, date passed`
    : now.state === 'on' ? `${target}, on pace` : `${target}, behind pace by ${now.gap}%`;
}
export const northStarOf = (metrics: Metric[]) => metrics.find((metric) => metric.northStar) ?? metrics[0];

// What a person wired to the card reads, in a few hundred characters: the north star with its movement, trend and
// target, then one short clause for each of the others, ending on the day of the newest entry.
export function metricsBlock(title: string | undefined, metrics: Metric[], period: Period, today: string): string {
  const head = `- A Metrics card${title ? `, "${title}"` : ''}. Read more with read_metrics.`;
  const star = northStarOf(metrics);
  if (!star || !metrics.some((metric) => metric.points.length)) return `${head}\n  No numbers yet; the founder pastes or types them on the card. Today is ${today}.`;
  const when = period === 'week' ? 'last week' : 'last month';
  const many = period === 'week' ? 'weeks' : 'months';
  const clause = (metric: Metric, full: boolean) => {
    const moved = delta(metric, period);
    if (!moved) return `${metric.label} no entries`;
    const parts: string[] = [];
    if (moved.abs !== undefined) parts.push(full && moved.pct !== null && moved.pct !== undefined ? `${formatChange(moved.abs, metric.unit)}, ${formatPct(moved.pct)} vs ${when}` : formatChange(moved.abs, metric.unit));
    if (full) {
      const going = trend(metric, period);
      if (going.n >= 2) parts.push(`${going.n} ${many} ${going.dir}`);
      const target = paceWords(metric, today);
      if (target) parts.push(target);
    }
    return `${metric.label} ${formatValue(moved.now, metric.unit)}${parts.length ? ` (${parts.join('; ')})` : ''}`;
  };
  const last = metrics.flatMap((metric) => metric.points.map((point) => point.at)).sort().at(-1)!;
  const rest = metrics.filter((metric) => metric !== star).map((metric) => `${clause(metric, false)}. `).join('');
  return `${head}\n  North star: ${clause(star, true)}.\n  ${rest}Last entry ${last}.`;
}

// ---------------------------------------------------------------- names

export const keyOf = (label: string) => label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'metric';
// Most numbers are better going up. These are the usual ones that are not.
export const guessBetter = (label: string): Metric['better'] => (/churn|cost|burn|cac|latency|bugs?\b|refund|downtime|errors?\b|tickets?\b|spend|expenses?/i.test(label) ? 'down' : 'up');
export const findMetric = (metrics: Metric[], ref: string) => {
  const asked = ref.trim().toLowerCase();
  return metrics.find((metric) => metric.key === asked || metric.label.toLowerCase() === asked) ?? metrics.find((metric) => metric.key === keyOf(ref));
};

// ---------------------------------------------------------------- reading a file

export type Row = { key: string; label: string; at: string; value: number; from: string; unit?: Unit };
export type Parsed = { rows: Row[]; skipped: string[]; shape: 'long' | 'wide' | 'none' };

// Splits CSV text into rows of cells, quotes and all. The delimiter is whichever of comma, semicolon or tab the
// first line uses most, so a spreadsheet saved in a European locale reads the same.
export function splitCsv(text: string): string[][] {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const count = (mark: string) => first.split(mark).length - 1;
  const mark = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (quoted) {
      if (char === '"' && text[at + 1] === '"') { cell += '"'; at++; } else if (char === '"') quoted = false; else cell += char;
    } else if (char === '"' && cell === '') quoted = true;
    else if (char === mark) { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[at + 1] === '\n') at++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const made = (year: number, month: number, day: number) => {
  const at = `${year}-${pad(month)}-${pad(day)}`;
  return isDay(at) ? at : null;
};
// A day the way spreadsheets write one. `dayFirst` settles 03/04/2026, decided once for the whole file.
export function parseDay(raw: string, dayFirst = true): string | null {
  const text = raw.trim();
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(text);
  if (match) return made(+match[1], +match[2], +match[3]);
  match = /^(\d{4})-(\d{1,2})$/.exec(text);
  if (match) return made(+match[1], +match[2], 1);
  match = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(text);
  if (match) return dayFirst ? made(+match[3], +match[2], +match[1]) : made(+match[3], +match[1], +match[2]);
  match = /^(\d{1,2})\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})$/i.exec(text);
  if (match && MONTHS.includes(match[2].toLowerCase())) return made(+match[3], MONTHS.indexOf(match[2].toLowerCase()) + 1, +match[1]);
  match = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/i.exec(text);
  if (match && MONTHS.includes(match[1].toLowerCase())) return made(+match[3], MONTHS.indexOf(match[1].toLowerCase()) + 1, +match[2]);
  return null;
}
// A number the way people type one: "$3,120", "12%", "(40)", "1 200". The unit comes back when it was written.
export function parseNumber(raw: string): { value: number; unit: Unit } | null {
  let text = raw.trim().replace(/[    ]/g, '');
  if (!text) return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1); }
  if (text.startsWith('-') || text.startsWith('−')) { negative = !negative; text = text.slice(1); }
  const unit = (UNITS.find((one) => one && text.includes(one)) ?? '') as Unit;
  text = text.replace(/[$€£%]/g, '');
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.replace(/,/g, '');
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? { value: negative ? -value : value, unit } : null;
}

const DATE_HEAD = /^(date|day|week|month|at|period|time|when)$/i;
const NAME_HEAD = /^(metric|name|key|kpi|series|measure)$/i;
const VALUE_HEAD = /^(value|amount|count|number|total|reading)$/i;
const clip = (text: string) => (text.length > 40 ? `${text.slice(0, 40)}…` : text);

// A table of numbers in either shape people keep them in: long (date, metric, value; one row a reading) or wide
// (date, then one column a metric). Every row it could not use is named, with why, so nothing vanishes quietly.
export function parseTable(table: string[][], name: string): Parsed {
  const lines = table.map((cells, index) => ({ cells: cells.map((cell) => cell.trim()), row: index + 1 })).filter((line) => line.cells.some(Boolean));
  const header = lines.shift();
  if (!header) return { rows: [], skipped: [], shape: 'none' };
  const heads = header.cells;
  const dateAt = Math.max(0, heads.findIndex((head) => DATE_HEAD.test(head)));
  const nameAt = heads.findIndex((head) => NAME_HEAD.test(head));
  const valueAt = heads.findIndex((head) => VALUE_HEAD.test(head));
  // 03/04/2026: day first unless some row of the file could only be month first.
  const slashed = lines.map((line) => /^(\d{1,2})[/.](\d{1,2})[/.]\d{4}$/.exec(line.cells[dateAt] ?? '')).filter((match) => match !== null);
  const dayFirst = !slashed.some((match) => +match[2] > 12) || slashed.some((match) => +match[1] > 12);
  const rows: Row[] = [];
  const skipped: string[] = [];
  const from = (row: number) => `${name}, row ${row}`;
  const add = (label: string, at: string, raw: string, row: number, where = '') => {
    const number = parseNumber(raw);
    if (!number) { skipped.push(`row ${row}${where}: "${clip(raw)}" is not a number`); return; }
    rows.push({ key: keyOf(label), label, at, value: number.value, from: from(row), ...(number.unit ? { unit: number.unit } : {}) });
  };
  const dayOf = (line: { cells: string[]; row: number }) => {
    const raw = line.cells[dateAt] ?? '';
    const at = raw ? parseDay(raw, dayFirst) : null;
    if (!at) skipped.push(`row ${line.row}: ${raw ? `"${clip(raw)}" is not a date` : 'no date'}`);
    return at;
  };
  if (nameAt >= 0 && valueAt >= 0) {
    for (const line of lines) {
      const at = dayOf(line);
      if (!at) continue;
      const label = line.cells[nameAt];
      if (!label) { skipped.push(`row ${line.row}: no metric name`); continue; }
      add(label.slice(0, 60), at, line.cells[valueAt] ?? '', line.row);
    }
    return { rows, skipped, shape: 'long' };
  }
  const columns = heads.map((head, index) => ({ head, index })).filter((one) => one.index !== dateAt);
  if (!columns.length) return { rows, skipped: ['there is only a date column: add one column a metric'], shape: 'none' };
  for (const line of lines) {
    const at = dayOf(line);
    if (!at) continue;
    for (const column of columns) {
      const raw = line.cells[column.index] ?? '';
      if (!raw) continue;
      const label = column.head || `Column ${column.index + 1}`;
      add(label.slice(0, 60), at, raw, line.row, `, ${clip(label)}`);
    }
  }
  return { rows, skipped, shape: 'wide' };
}

// A pasted table or a dropped file. JSON is a list of rows (either shape) or a card's own sidecar sent back.
export function parseImport(text: string, name: string): Parsed {
  const trimmed = text.trim();
  if (!trimmed) return { rows: [], skipped: ['there is nothing to read'], shape: 'none' };
  if (/^[[{]/.test(trimmed)) {
    let data: unknown;
    try { data = JSON.parse(trimmed); } catch { return { rows: [], skipped: ['the JSON does not parse'], shape: 'none' }; }
    if (data && typeof data === 'object' && !Array.isArray(data) && Array.isArray((data as Metrics).metrics)) {
      const rows: Row[] = [];
      for (const metric of (data as Metrics).metrics) for (const point of metric.points ?? []) {
        if (isDay(point.at) && Number.isFinite(point.value)) rows.push({ key: keyOf(metric.label ?? metric.key), label: String(metric.label ?? metric.key).slice(0, 60), at: point.at, value: point.value, from: `${name}`, ...(metric.unit ? { unit: metric.unit } : {}) });
      }
      return { rows, skipped: [], shape: 'long' };
    }
    if (!Array.isArray(data) || !data.every((one) => one && typeof one === 'object')) return { rows: [], skipped: ['the JSON is not a list of rows'], shape: 'none' };
    const heads = [...new Set(data.flatMap((one) => Object.keys(one as object)))];
    const table = [heads, ...data.map((one) => heads.map((head) => { const cell = (one as Record<string, unknown>)[head]; return cell === undefined || cell === null ? '' : String(cell); }))];
    return parseTable(table, name);
  }
  return parseTable(splitCsv(text), name);
}

// Readings folded into a card's metrics: a day already there is replaced, a new label becomes a new metric until the
// card is full, and whatever did not fit is named. The first metric is the north star until the founder picks another.
export function mergeRows(metrics: Metric[], rows: Row[], max = MAX_METRICS): { metrics: Metric[]; added: number; replaced: number; full: string[] } {
  const next = metrics.map((metric) => ({ ...metric, points: [...metric.points] }));
  let added = 0;
  let replaced = 0;
  const full = new Set<string>();
  for (const row of rows) {
    let metric = findMetric(next, row.label) ?? findMetric(next, row.key);
    if (!metric) {
      if (next.length >= max) { full.add(row.label); continue; }
      metric = { key: uniqueKey(next, row.key), label: row.label, better: guessBetter(row.label), points: [], ...(row.unit ? { unit: row.unit } : {}) };
      next.push(metric);
    }
    if (!metric.unit && row.unit) metric.unit = row.unit;
    const same = metric.points.findIndex((point) => point.at === row.at);
    const point = { at: row.at, value: round(row.value), from: row.from };
    if (same >= 0) { metric.points[same] = point; replaced++; } else { metric.points.push(point); added++; }
  }
  for (const metric of next) {
    metric.points.sort((a, b) => a.at.localeCompare(b.at));
    if (metric.points.length > MAX_POINTS) metric.points = metric.points.slice(-MAX_POINTS);
  }
  if (next.length && !next.some((metric) => metric.northStar)) next[0].northStar = true;
  return { metrics: next, added, replaced, full: [...full] };
}
const uniqueKey = (metrics: Metric[], key: string) => {
  let name = key;
  for (let n = 2; metrics.some((metric) => metric.key === name); n++) name = `${key}-${n}`;
  return name;
};
