import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DASHBOARD_CHANNEL, type DashCheck, type DashMedia, type Dashboard, type DashDay, type DashSkills, type DashTeam, type DashTokens } from '../../shared/dashboard.ts';
import { counted, type Run } from '../../shared/evals.ts';
import { LEAD_STAGES, type Lead, type LeadStage } from '../../shared/leads.ts';
import { KEPT_MARK, type Card, type ChatMessage, type Media, type Stage } from '../../shared/model.ts';
import { hub } from '../events.ts';
import { FRAMEWORK_ID, type Framework } from '../../shared/frameworks.ts';
import type { Deps, Slice } from '../install.ts';
import { leadsCardIds } from '../leads/store.ts';
import { backupDirOf, canWrite, listBackups, sameDisk } from '../openends/backup.ts';
import { backupRow, checkAll, outsideHealth } from '../openends/health.ts';
import { coderHealth } from '../opencode/server.ts';
import { providerOf } from '../providers.ts';
import type { TraceLine } from '../trace.ts';
import type { Watch } from './crawl.ts';

// The founder's dashboard: one read of what the app already keeps, on one page. It owns nothing. Every number here is
// read from where it lives (the needs-you list, the boards, the leads, the watches, the trace of every turn, the
// frameworks and their runs, the playbook, the people's memories, the studios' results), and every row carries the id
// the window needs to open the place it came from.
//
// It has to answer at once, so it answers from a copy. The copy is made again when something under it changes, and
// the files it reads are held by the time they were last written, so a copy made again reads only what moved.

const DAY = 86_400_000;
const HEALTH_FOR = 60_000;
// A copy that nothing has invalidated is still made again after this, for what no watcher sees (a turn's usage, a
// skill used, a memory kept).
const FRESH_FOR = 20_000;
const QUIET = 2_000;
// The folders whose files the dashboard reads. A change in any of them makes the copy stale and tells the window.
const WATCHED = ['boards', 'leads', 'watch', 'decisions', 'media', join('.index', 'trace'), 'rooms', 'frameworks'];

export const localDay = (at: number) => { const day = new Date(at); return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`; };
const endOfDay = (at: number) => { const day = new Date(at); day.setHours(23, 59, 59, 999); return day.getTime(); };
const clip = (text: string, most: number) => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > most ? `${flat.slice(0, most - 1).trimEnd()}…` : flat; };

// A file read once for as long as it has not been written again. The dashboard reads the same few dozen files on
// every refresh, and almost none of them have changed since the last one.
export function fileCache() {
  const held = new Map<string, { stamp: string; value: unknown }>();
  return async function read<T>(path: string, fallback: T, parse: (text: string) => T = (text) => JSON.parse(text) as T): Promise<T> {
    const info = await stat(path).catch(() => null);
    if (!info) { held.delete(path); return fallback; }
    const stamp = `${info.mtimeMs}:${info.size}`;
    const known = held.get(path);
    if (known?.stamp === stamp) return known.value as T;
    try {
      const value = parse(await readFile(path, 'utf8'));
      held.set(path, { stamp, value });
      return value;
    } catch { return fallback; }
  };
}
type Read = ReturnType<typeof fileCache>;
const jsonIn = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith('.json') && !name.endsWith('.tmp'));

// ---------------------------------------------------------------- today

export async function readDay(deps: Pick<Deps, 'workspace' | 'attention' | 'boards' | 'decisions' | 'store'>, stage: Stage, read: Read, now: number): Promise<DashDay> {
  const nameOf = (roomId?: string) => stage.rooms.find((room) => room.id === roomId)?.name;
  const cards = stage.cards ?? [];

  const needsYou = (await deps.attention.list().catch(() => [])).map((one) => ({
    id: one.id, kind: one.kind, title: one.title, at: one.at,
    ...(one.who ? { who: one.who } : {}), ...(one.roomId ? { roomId: one.roomId } : {}), ...(one.cardId ? { cardId: one.cardId } : {}),
    ...(one.taskId ? { taskId: one.taskId } : {}), ...(one.decisionId ? { decisionId: one.decisionId } : {}),
  }));

  // Repeats that fall due before the day is out, and the ones that were missed; and whatever is running right now.
  const tasksDue: DashDay['tasksDue'] = [];
  const tasksRunning: DashDay['tasksRunning'] = [];
  const close = endOfDay(now);
  for (const card of cards.filter((one) => one.kind === 'board')) {
    for (const task of await deps.boards.list(card.id).catch(() => [])) {
      const who = nameOf(task.assignee);
      const base = { id: task.id, title: task.title, cardId: card.id, ...(who ? { who, roomId: task.assignee } : {}) };
      const state = task.run?.state;
      if (state === 'running' || state === 'waiting') tasksRunning.push({ ...base, at: task.run!.startedAt, state });
      else if (task.missed) tasksDue.push({ ...base, at: task.nextRun ?? task.createdAt, missed: true });
      else if (task.repeat && task.nextRun && task.nextRun <= close) tasksDue.push({ ...base, at: task.nextRun });
    }
  }
  tasksDue.sort((a, b) => a.at - b.at);
  tasksRunning.sort((a, b) => b.at - a.at);

  // Pages that changed in the last fortnight: the same window the needs-you list shows them for.
  const watchesChanged: DashDay['watchesChanged'] = [];
  const watchDir = join(deps.workspace, 'watch');
  for (const file of await jsonIn(watchDir)) {
    for (const one of await read<Watch[]>(join(watchDir, file), [])) {
      if (!one.changedAt || now - one.changedAt > 14 * DAY) continue;
      const who = nameOf(one.roomId);
      watchesChanged.push({ id: one.id, title: one.title, url: one.url, roomId: one.roomId, at: one.changedAt, ...(who ? { who } : {}), ...(one.diff ? { diff: clip(one.diff.split('\n')[0] ?? '', 140) } : {}) });
    }
  }
  watchesChanged.sort((a, b) => b.at - a.at);

  // Only the leads cards that are on the stage: a card taken away took its list to the trash.
  const leadsByStage = Object.fromEntries(LEAD_STAGES.map((one) => [one, 0])) as Record<LeadStage, number>;
  let leadsChangedToday = 0;
  const leadsCards = leadsCardIds(stage);
  const today = localDay(now);
  for (const id of leadsCards) {
    for (const lead of await read<Lead[]>(join(deps.workspace, 'leads', `${id}.json`), [])) {
      if (lead.stage in leadsByStage) leadsByStage[lead.stage] += 1;
      if (localDay(lead.updatedAt) === today) leadsChangedToday += 1;
    }
  }

  const decisionsPending = (await deps.decisions.list().catch(() => []))
    .filter((one) => one.status === 'proposed')
    .map((one) => ({ id: one.id, title: one.title, at: one.at, ...(one.proposedBy ? { who: one.proposedBy } : {}) }));

  // A conversation whose newest line is a person's reply that came in today, with nothing from the founder after it.
  const replies: DashDay['replies'] = [];
  for (const room of stage.rooms) {
    const chat = await read<ChatMessage[]>(join(deps.workspace, 'rooms', `${room.id}.json`), []);
    const last = chat.at(-1);
    if (last?.role === 'assistant' && localDay(last.at) === today && !last.text.startsWith('/tool')) replies.push({ roomId: room.id, name: room.name, at: last.at });
  }
  replies.sort((a, b) => b.at - a.at);

  return {
    needsYou, tasksDue, tasksRunning, watchesChanged, leadsByStage, leadsChangedToday,
    ...(leadsCards[0] ? { leadsCardId: leadsCards[0] } : {}),
    decisionsPending, unreadMessages: replies.length, replies,
  };
}

// ---------------------------------------------------------------- tokens

// Everything the trace wrote down for the last fortnight: one line a turn, one file a day. A turn's tokens are shared
// evenly between the tools it called, so a tool's number is what the turns that used it came to, never counted twice.
export async function readTokens(deps: Pick<Deps, 'workspace' | 'usage' | 'clients'>, stage: Stage, read: Read, now: number): Promise<DashTokens> {
  const folder = join(deps.workspace, '.index', 'trace');
  const days = Array.from({ length: 14 }, (_, back) => localDay(now - (13 - back) * DAY));
  const week = new Set(days.slice(-7));
  const byDay = new Map(days.map((day) => [day, 0]));
  const people = new Map<string, { tokens: number; turns: number }>();
  const tools = new Map<string, { calls: number; tokens: number }>();
  for (const day of days) {
    const lines = await read<TraceLine[]>(join(folder, `${day}.jsonl`), [], (text) => text.split('\n').flatMap((line) => { try { return line ? [JSON.parse(line) as TraceLine] : []; } catch { return []; } }));
    for (const line of lines) {
      const tokens = (line.usage?.input ?? 0) + (line.usage?.output ?? 0);
      byDay.set(day, (byDay.get(day) ?? 0) + tokens);
      if (!week.has(day)) continue;
      const person = people.get(line.roomId) ?? { tokens: 0, turns: 0 };
      people.set(line.roomId, { tokens: person.tokens + tokens, turns: person.turns + 1 });
      const called = line.tools ?? [];
      for (const tool of called) {
        const one = tools.get(tool.name) ?? { calls: 0, tokens: 0 };
        tools.set(tool.name, { calls: one.calls + 1, tokens: one.tokens + tokens / called.length });
      }
    }
  }

  // Several keys for one provider are one provider to the founder, the way the quota rings already say it.
  const limits = new Map<string, { rpd?: number; tpd?: number }>();
  for (const client of deps.clients) {
    const name = providerOf(client.name);
    const was = limits.get(name) ?? {};
    limits.set(name, {
      ...(client.limits.rpd ? { rpd: (was.rpd ?? 0) + client.limits.rpd } : {}),
      ...(client.limits.tpd ? { tpd: (was.tpd ?? 0) + client.limits.tpd } : {}),
    });
  }
  const byProvider = deps.usage.info(deps.clients).map((info) => {
    const limit = limits.get(info.name) ?? {};
    const capped = limit.rpd || limit.tpd;
    return {
      name: info.name, model: info.model, usedToday: { requests: info.requests, tokens: info.tokens }, limits: limit,
      leftPct: Math.round(info.left * 100),
      // The usage book starts each provider's day on the UTC date, whatever the founder's clock says.
      window: capped ? 'resets at midnight UTC' : 'no daily limit',
    };
  });

  const nameOf = (id: string) => stage.rooms.find((room) => room.id === id)?.name;
  return {
    byProvider,
    byPerson: [...people].map(([id, one]) => ({ name: nameOf(id) ?? (id || 'Somebody'), ...(nameOf(id) ? { roomId: id } : {}), tokens7d: one.tokens, turns7d: one.turns }))
      .sort((a, b) => b.tokens7d - a.tokens7d).slice(0, 8),
    byTool: [...tools].map(([name, one]) => ({ name, calls7d: one.calls, tokens7d: Math.round(one.tokens) }))
      .sort((a, b) => b.calls7d - a.calls7d || b.tokens7d - a.tokens7d).slice(0, 8),
    byDay: days.map((day) => ({ day, tokens: byDay.get(day) ?? 0 })),
  };
}

// ---------------------------------------------------------------- teams, skills, media

// Read through the dashboard's file cache: a framework or a run that has not been written since the last refresh is not
// read again. Only the newest run of each is opened; its file name is its moment, so the names sort the way time does.
export async function readTeams(workspace: string, root: string, stage: Stage, read: Read = fileCache()): Promise<DashTeam[]> {
  const folder = join(workspace, 'frameworks');
  const shipped = new Set(await readdir(resolve(root, 'app/frameworks')).catch(() => [] as string[]));
  const teams: DashTeam[] = [];
  for (const one of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    if (!one.isDirectory() || !FRAMEWORK_ID.test(one.name)) continue;
    const framework = await read<Pick<Framework, 'name' | 'scorecard'> | null>(join(folder, one.name, 'framework.json'), null);
    if (!framework?.name) continue;
    const id = one.name;
    const runs = join(folder, id, 'runs');
    let last: Run | undefined;
    for (const file of (await jsonIn(runs)).sort().reverse()) {
      const run = await read<Run | null>(join(runs, file), null);
      if (run && typeof run.at === 'number' && Array.isArray(run.cases)) { last = run; break; }
    }
    const placedRoom = stage.rooms.find((room) => room.framework?.id === id);
    const lastEval = last
      ? { mean: last.mean, at: last.at, judged: last.cases.filter(counted).length, of: last.cases.length }
      : framework.scorecard ? { mean: framework.scorecard.mean, at: framework.scorecard.at, judged: framework.scorecard.cases, of: framework.scorecard.cases } : null;
    teams.push({ id, name: framework.name, builtIn: shipped.has(id), placed: !!placedRoom, ...(placedRoom ? { placedRoomId: placedRoom.id } : {}), lastEval });
  }
  // What is on the stage first, then the founder's own, then the ones that came with the app.
  return teams.sort((a, b) => Number(b.placed) - Number(a.placed) || Number(a.builtIn) - Number(b.builtIn) || a.name.localeCompare(b.name));
}

export async function readSkills(deps: Pick<Deps, 'skills' | 'workspace'>, stage: Stage, read: Read, now: number): Promise<DashSkills> {
  const skills = await deps.skills.list().catch(() => []);
  const usedThisWeek = skills.filter((one) => (one.usedAt ?? 0) >= now - 7 * DAY)
    .map((one) => ({ id: one.id, name: one.name, uses: one.uses })).sort((a, b) => b.uses - a.uses).slice(0, 8);
  const keptBy: DashSkills['keptBy'] = [];
  for (const room of stage.rooms) {
    const memory = await read<{ notes?: string }>(join(deps.workspace, 'rooms', `${room.id}.memory.json`), {});
    const count = (memory.notes ?? '').split('\n').filter((line) => line.includes(KEPT_MARK)).length;
    if (count) keptBy.push({ roomId: room.id, name: room.name, count });
  }
  keptBy.sort((a, b) => b.count - a.count);
  return { count: skills.filter((one) => one.state === 'active').length, usedThisWeek, keptOnItsOwn: keptBy.reduce((sum, one) => sum + one.count, 0), keptBy };
}

const KIND: Partial<Record<Card['kind'], DashMedia['kind']>> = { imagegen: 'picture', voicegen: 'voice', videogen: 'film' };
export async function readMedia(workspace: string, stage: Stage, read: Read, now: number): Promise<DashMedia[]> {
  const made: DashMedia[] = [];
  for (const card of stage.cards ?? []) {
    const kind = KIND[card.kind];
    if (!kind) continue;
    const media = await read<Partial<Media>>(join(workspace, 'media', `${card.id}.json`), {});
    for (const one of media.results ?? []) {
      if (!one.path || now - one.at > 7 * DAY) continue;
      const credits = one.music ? `Music: ${one.music.title} by ${one.music.by} (${one.music.licence})` : undefined;
      made.push({
        kind, title: clip(one.prompt || 'Untitled', 90), file: one.path, at: one.at, cardId: card.id,
        ...(one.poster ? { poster: one.poster } : {}), ...(credits ? { credits } : {}), ...(one.credits ? { creditsFile: one.credits } : {}),
        ...(one.noncommercial ? { nonCommercial: true } : {}),
      });
    }
  }
  return made.sort((a, b) => b.at - a.at).slice(0, 30);
}

// ---------------------------------------------------------------- the slice

export default {
  name: 'dashboard',
  order: 130,
  install(deps) {
    const read = fileCache();
    // `from`: the health rows the copy was made from, so a new health answer makes it stale.
    let copy: { at: number; body: Dashboard; from: DashCheck[] } | null = null;
    let making: Promise<Dashboard> | null = null;
    let dirty = true;

    // Health asks programs on the PATH for their versions, which can take seconds, so it is never waited for: the
    // last answer is served and a new one is asked for in the background once it is a minute old.
    let health: { at: number; checks: DashCheck[] } = { at: 0, checks: [] };
    let checking: Promise<void> | null = null;
    // Asked each time: the founder may point backups somewhere else while the app runs.
    const dirOf = () => backupDirOf(deps);
    // Set when the rows are asked for again while a check is already out: that check read the world as it was, so
    // one more follows it as soon as it is done.
    let again = false;
    // The backups folder and its newest backup as the last check saw them: its Backup row is about exactly that.
    let sawBackup: { dir: string; at: number | null } | null = null;
    function checkHealth(fresh = false) {
      if (fresh) { health = { ...health, at: 0 }; if (checking) again = true; }
      if (checking || Date.now() - health.at < HEALTH_FOR) return;
      const dir = dirOf();
      void listBackups(dir).then((held) => { sawBackup = { dir, at: held[0]?.at ?? null }; });
      checking = checkAll({ workspace: deps.workspace, root: deps.root, backupDir: dir, backups: () => listBackups(dir), outside: () => outsideHealth.now(), coder: () => coderHealth.now() })
        .then((checks) => {
          const fresh = checks.map(({ name, ok, detail }) => ({ name, ok, detail }));
          const moved = JSON.stringify(fresh) !== JSON.stringify(health.checks);
          health = { at: Date.now(), checks: fresh };
          if (moved) changed();
        })
        .catch(() => { health = { ...health, at: Date.now() }; })
        .finally(() => { checking = null; if (again) { again = false; checkHealth(true); } });
    }

    async function make(): Promise<Dashboard> {
      const now = Date.now();
      const stage = await deps.store.loadStage();
      const [day, tokens, teams, skills, media] = await Promise.all([
        readDay(deps, stage, read, now), readTokens(deps, stage, read, now), readTeams(deps.workspace, deps.root, stage, read),
        readSkills(deps, stage, read, now), readMedia(deps.workspace, stage, read, now),
      ]);
      // One reading of the backups folder for the line and for the Backup row, which the last health check may have
      // read a while ago: both say what is there now.
      const dir = dirOf();
      const state = { dir, backups: await listBackups(dir), writable: await canWrite(dir), sameDisk: await sameDisk(deps.workspace, dir) };
      const backup = { at: state.backups[0]?.at ?? null, dir, writable: state.writable };
      const { fix: _fix, ...row } = backupRow(state, now);
      const rows = health.checks.some((one) => one.name === 'Backup') ? health.checks.map((one) => (one.name === 'Backup' ? row : one)) : health.checks;
      return { at: now, day, tokens, health: rows, teams, skills, media, backup };
    }
    async function current(): Promise<Dashboard> {
      // The backups folder may be anywhere (a USB drive), so it is not watched: a copy that names another newest
      // backup, or another folder, than the one there now is stale, and so is its Backup health row. Five files at
      // most, so this is cheap.
      const dir = dirOf();
      const newest = (await listBackups(dir))[0]?.at ?? null;
      if (copy && (copy.body.backup?.dir !== dir || copy.body.backup?.at !== newest)) dirty = true;
      checkHealth(!!sawBackup && (sawBackup.dir !== dir || sawBackup.at !== newest));
      if (copy && !dirty && Date.now() - copy.at < FRESH_FOR && copy.from === health.checks) return copy.body;
      making ??= (async () => {
        dirty = false;
        const from = health.checks;
        try { const body = await make(); copy = { at: Date.now(), body, from }; return body; } finally { making = null; }
      })();
      return making;
    }

    // Something under the dashboard moved: the copy is stale, and the window is told once things have settled.
    let soon: ReturnType<typeof setTimeout> | undefined;
    function changed() {
      dirty = true;
      clearTimeout(soon);
      soon = setTimeout(() => hub.say(DASHBOARD_CHANNEL, { dashboard: true }), QUIET);
      soon.unref?.();
    }
    const stops: (() => void)[] = [deps.attention.watch(changed), deps.boards.onChange(changed), deps.decisions.onChange(changed)];
    const watchers: FSWatcher[] = [];
    void (async () => {
      for (const folder of WATCHED) {
        const path = join(deps.workspace, folder);
        await mkdir(path, { recursive: true }).catch(() => {});
        try { const one = watch(path, { persistent: false }, (_event, name) => { if (!name || !String(name).endsWith('.tmp')) changed(); }); one.on('error', () => {}); watchers.push(one); } catch { /* a folder that cannot be watched is read fresh every twenty seconds instead */ }
      }
    })();
    checkHealth();

    return {
      async route(req, res, path) {
        if (path !== '/api/dashboard' || req.method !== 'GET') return false;
        deps.json(res, 200, await current());
        return true;
      },
      async close() {
        clearTimeout(soon);
        for (const stop of stops) stop();
        for (const one of watchers) one.close();
      },
    };
  },
} satisfies Slice;
