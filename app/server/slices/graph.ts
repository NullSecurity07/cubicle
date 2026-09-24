import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { coderChannel, type CoderEvent, type GraphMark, type GraphView } from '../../shared/coder.ts';
import type { Stage } from '../../shared/model.ts';
import { timeOrDay } from '../clock.ts';
import { hub } from '../events.ts';
import { projectDir } from '../folder.ts';
import type { Deps, Slice } from '../install.ts';
import { nameOf, projects, refOf as refCard, wiredProject, type CardRef, type Project } from '../opencode/cards.ts';
import { cardLog, findTool, graphJson, mapDir, NO_MAP, NOT_HERE, PIN } from '../opencode/graph-kit.ts';
import { childEnv } from '../safety/env.ts';
import { patchStageVia } from '../slice-kit.ts';
import type { Tool, ToolContext } from '../tools/registry.ts';

// The map of a code folder, made by Graphify: every file, function and class, what calls and imports what, and the
// groups they fall into. It is read from the code alone with tree-sitter, on this machine: no model is ever asked,
// not even to name the groups. A person wired to a coder card maps its folder once, then asks the map questions
// instead of reading file after file; the coder itself reads the same map through Graphify's own tools.

export { cardLog, findTool, GRAPH_HINT, graphJson, hasMcpPart, INSTALL, mapDir, mcpCommand, NO_MAP, NOT_HERE, PIN, type CardRef } from '../opencode/graph-kit.ts';

const MAP_LIMIT = 10 * 60_000;
const ASK_LIMIT = 60_000;
const LINES = 40;

// One Graphify command, its lines as they come. The runner is swapped for a made-up one in fake mode and in tests.
export type Ran = { code: number | null; out: string };
export type Runner = (args: string[], options: { env: NodeJS.ProcessEnv; cwd?: string; signal?: AbortSignal; limit: number; onLine?: (line: string) => void }) => Promise<Ran>;

export function spawnRunner(bin: () => string | null): Runner {
  return (args, { env, cwd, signal, limit, onLine }) => new Promise((settle, fail) => {
    const program = bin();
    if (!program) { fail(new Error(NOT_HERE)); return; }
    if (signal?.aborted) { fail(new Error('stopped')); return; }
    const child = spawn(program, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let partial = '';
    const heard = (chunk: Buffer) => {
      const text = chunk.toString();
      if (out.length < 200_000) out += text;
      partial += text;
      const lines = partial.split(/\r?\n|\r/);
      partial = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) onLine?.(line.trim());
    };
    child.stdout.on('data', heard);
    child.stderr.on('data', heard);
    let why = '';
    const kill = (reason: string) => { why = reason; if (child.exitCode === null) child.kill('SIGKILL'); };
    const timer = setTimeout(() => kill(`it took longer than ${Math.round(limit / 60_000) || 1} minutes`), limit);
    const aborted = () => kill('stopped');
    signal?.addEventListener('abort', aborted, { once: true });
    child.once('error', (error) => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); fail(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      if (partial.trim()) onLine?.(partial.trim());
      if (why) fail(new Error(why)); else settle({ code, out });
    });
  });
}

// The made-up Graphify of fake mode: a map of five pieces of code from the fixtures, and answers about them.
export const FIXTURES = resolve(import.meta.dirname, 'graph.fixtures');
export const fakeRunner: Runner = async (args, { env, onLine }) => {
  if (args[0] === 'update') {
    const out = String(env.GRAPHIFY_OUT);
    onLine?.('Re-extracting code files (no LLM needed)...');
    await mkdir(out, { recursive: true });
    for (const file of ['graph.json', 'GRAPH_REPORT.md', 'graph.html']) await copyFile(join(FIXTURES, file), join(out, file));
    onLine?.('[graphify watch] Rebuilt: 5 nodes, 7 edges, 2 communities');
    return { code: 0, out: '' };
  }
  if (args[0] === 'query') return { code: 0, out: 'Traversal: BFS depth=2 | Start: [\'a()\'] | 3 nodes found\n\nNODE a() [src=src/x.ts loc=L1 community=0]\nNODE b() [src=src/x.ts loc=L2 community=1]\nEDGE a() --calls [EXTRACTED]--> b()' };
  if (args[0] === 'affected') return { code: 0, out: `Affected nodes for ${args[1]}\nDepth: 2\n- a() [calls] src/x.ts:L1\n- main() [calls] src/y.ts:L2` };
  if (args[0] === 'god-nodes') return { code: 0, out: JSON.stringify([{ id: 'src_x_a', label: 'a()', degree: 4 }, { id: 'src_y_main', label: 'main()', degree: 2 }, { id: 'src_x_b', label: 'b()', degree: 2 }]) };
  if (args[0] === '--version') return { code: 0, out: `graphify ${PIN}` };
  return { code: 1, out: 'unknown command' };
};

// What a child Graphify is started with: none of the founder's keys (it must never reach a model, and with no key it
// cannot), its map where the app keeps maps, and no record of the questions asked.
export const graphEnv = (env: NodeJS.ProcessEnv, out: string): NodeJS.ProcessEnv => ({
  ...childEnv(env), GRAPHIFY_OUT: out, GRAPHIFY_QUERY_LOG_DISABLE: '1', GRAPHIFY_NO_TIPS: '1', PYTHONUNBUFFERED: '1',
});

type Node = { id: string; label?: string; source_file?: string; community?: number };
type Link = { source: string; target: string };
export type MapSummary = GraphMark & { gods: string[]; lead: string; html: string };

// A file is a node too; the most connected pieces of code are the functions and classes, the way Graphify counts them.
const isFile = (node: Node) => !!node.source_file && node.label === basename(node.source_file);

// The map as it is on disk: its counts, its five most connected pieces of code and the start of its report. Null when
// there is no map.
export async function readMap(out: string): Promise<MapSummary | null> {
  const file = join(out, 'graph.json');
  const made = await stat(file).catch(() => null);
  if (!made) return null;
  const data = JSON.parse(await readFile(file, 'utf8')) as { nodes?: Node[]; links?: Link[]; edges?: Link[] };
  const nodes = data.nodes ?? [];
  const links = data.links ?? data.edges ?? [];
  const degree = new Map<string, number>();
  for (const link of links) for (const end of [link.source, link.target]) degree.set(end, (degree.get(end) ?? 0) + 1);
  const gods = nodes.filter((node) => !isFile(node)).map((node) => ({ label: node.label ?? node.id, degree: degree.get(node.id) ?? 0 }))
    .filter((one) => one.degree > 0).sort((one, other) => other.degree - one.degree).slice(0, 5).map((one) => one.label);
  const report = await readFile(join(out, 'GRAPH_REPORT.md'), 'utf8').catch(() => '');
  return {
    at: made.mtimeMs, nodes: nodes.length, edges: links.length,
    communities: new Set(nodes.map((node) => node.community).filter((one) => one !== undefined)).size,
    gods, lead: leadOf(report), html: join(out, 'graph.html'),
  };
}
// The report's summary: what was read and what came of it, without the heading.
export function leadOf(report: string, max = 600): string {
  const body = report.replace(/^# .*\n+/, '').trim();
  const summary = /## Summary\n([\s\S]*?)(?:\n## |$)/.exec(body)?.[1]?.trim();
  const first = summary || body.split(/\n\s*\n/)[0] || '';
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

// Maps one folder: Graphify re-reads its code and draws the map again, its progress lines passed on as they come.
// `--force` because a map made again after code was deleted is meant to be smaller. Never any labelling step.
export async function mapFolder(path: string, report: (line: string) => void, { out, run, env = process.env, signal }: { out: string; run: Runner; env?: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<MapSummary> {
  await mkdir(out, { recursive: true });
  let lines = 0;
  const said: string[] = [];
  const onLine = (line: string) => {
    const clean = line.replace(/^\[graphify[^\]]*\]\s*/, '').replace(/\s+/g, ' ').slice(0, 200);
    said.push(clean);
    if (!/^(For doc|Code graph updated)/.test(clean) && lines++ < LINES) report(clean);
  };
  const ran = await run(['update', path, '--force'], { env: graphEnv(env, out), cwd: path, signal, limit: MAP_LIMIT, onLine });
  const summary = await readMap(out);
  if (ran.code !== 0 || !summary) throw new Error(`Graphify could not map ${basename(path)}: ${said.slice(-2).join(' ') || `it ended with code ${ran.code}`}`);
  // Graphify's own count of the most connected code leaves out files, imports and concepts better than a plain count
  // can; the plain count stands in when it will not answer.
  const gods = await run(['god-nodes', '--top', '5', '--json', '--graph', join(out, 'graph.json')], { env: graphEnv(env, out), cwd: dirname(out), limit: ASK_LIMIT })
    .then((said) => (said.code === 0 ? (JSON.parse(said.out) as { label?: string; id: string }[]).map((one) => one.label ?? one.id) : null), () => null)
    .catch(() => null);
  return gods?.length ? { ...summary, gods } : summary;
}

const count = (value: number) => value.toLocaleString('en-GB');
export const markOf = (summary: MapSummary): GraphMark => ({ at: summary.at, nodes: summary.nodes, edges: summary.edges, communities: summary.communities });
const dated = (name: string, at: number, now: number) => `Map of ${name}, made ${timeOrDay(at, now)}${now - at > 86_400_000 ? ` (${Math.floor((now - at) / 86_400_000)} days ago)` : ''}.`;

const NO_CARD = 'no coder card is connected to your room. Ask the founder to wire one to you.';

type Options = { workspace: string; forbidden: string[]; run: Runner; ready: () => string | null; env?: NodeJS.ProcessEnv; now?: () => number;
  // Writes the map's counts onto the card in the saved stage.
  keep?: (cardId: string, mark: GraphMark) => Promise<void> };

// Mapping, one folder at a time, and the three things a wired person may do with it.
export function createMaps({ workspace, forbidden, run, ready, env = process.env, now = Date.now, keep }: Options) {
  const running = new Map<string, Promise<MapSummary>>();
  const refOf = (card: Project): CardRef => refCard(card, forbidden);
  const tell = (cardId: string, event: CoderEvent) => hub.say(coderChannel(cardId), event);

  function map(card: Project, signal?: AbortSignal): Promise<MapSummary> {
    const ref = refOf(card);
    const going = running.get(ref.dir);
    if (going) return going;
    const job = (async () => {
      const started = now();
      tell(card.id, { mapping: true });
      cardLog.add(ref, { kind: 'tool', text: `map ${ref.name}` });
      try {
        const summary = await mapFolder(ref.dir, (line) => cardLog.add(ref, { kind: 'tool', text: `map ${line}` }), { out: mapDir(workspace, ref.dir), run, env, signal });
        const mark = markOf(summary);
        await keep?.(card.id, mark).catch(() => {});
        tell(card.id, { graph: mark });
        cardLog.add(ref, { kind: 'note', text: `mapped · ${count(mark.nodes)} nodes · ${count(mark.edges)} links · ${count(mark.communities)} groups · ${Math.round((now() - started) / 1000)} s` });
        return summary;
      } catch (error) {
        cardLog.add(ref, { kind: 'error', text: `the map failed: ${(error as Error).message}` });
        throw error;
      } finally {
        running.delete(ref.dir);
        tell(card.id, { mapping: false });
      }
    })();
    running.set(ref.dir, job);
    return job;
  }

  async function view(card: Project, page: string): Promise<GraphView> {
    const dir = (() => { try { return projectDir(card.path, forbidden); } catch { return null; } })();
    const mapping = !!dir && running.has(dir);
    const summary = dir ? await readMap(mapDir(workspace, dir)).catch(() => null) : null;
    if (!summary) return { mapped: false, mapping };
    const report = await readFile(join(dirname(summary.html), 'GRAPH_REPORT.md'), 'utf8').catch(() => '');
    return { mapped: true, mapping, ...markOf(summary), report: report.slice(0, 600), html: summary.html, page };
  }

  // A Graphify question about the folder's map, answered in its own words, cut to size.
  async function ask(dir: string, args: string[], max: number) {
    const out = mapDir(workspace, dir);
    const ran = await run([...args, '--graph', join(out, 'graph.json')], { env: graphEnv(env, out), cwd: dirname(out), limit: ASK_LIMIT });
    const said = ran.out.trim();
    if (ran.code !== 0) throw new Error(`Graphify could not answer: ${said.split('\n').slice(-2).join(' ').slice(0, 300) || `it ended with code ${ran.code}`}`);
    return said.length > max ? `${said.slice(0, max)}\n… (cut here)` : said || 'Graphify found nothing for that.';
  }

  function tools(): Tool[] {
    const cardFor = (context: ToolContext) => wiredProject(context.stage, context.roomId);
    const need = (context: ToolContext) => { const card = cardFor(context); if (!card) throw new Error(NO_CARD); return card; };
    // The folder with its map, for the two tools that read one. No map is a sentence, not an error.
    const mapped = async (context: ToolContext) => {
      const card = need(context);
      const ref = refOf(card);
      const summary = await readMap(mapDir(workspace, ref.dir)).catch(() => null);
      return { ref, summary };
    };
    return [
      {
        name: 'map_folder', perTurn: 1,
        description: 'Map the code in the folder of the coder wired to you: files, functions, what calls and imports what. Takes seconds to minutes, uses no AI. Do it once before ask_graph or affected_by, and again after big changes.',
        parameters: { type: 'object', properties: {} },
        ready,
        // Asked the first time only: once a folder has a map, making it again changes nothing the founder has not seen.
        approval: async (_args, context) => {
          const card = cardFor(context);
          if (!card) return null;
          const dir = (() => { try { return projectDir(card.path, forbidden); } catch { return null; } })();
          if (dir && existsSync(graphJson(workspace, dir))) return null;
          return `Map ${card.path} with Graphify? It reads the code on this machine, with no AI, and keeps the map in the app's own folder.`;
        },
        async run(_args, context) {
          const card = need(context);
          const summary = await map(card, context.signal);
          return { text: `${dated(nameOf(card), summary.at, now())} ${count(summary.nodes)} nodes, ${count(summary.edges)} links, ${count(summary.communities)} groups.\nMost connected: ${summary.gods.join(', ') || 'none'}.\n${summary.lead}\nNext: ask_graph with a question, or affected_by with a name.` };
        },
      },
      {
        name: 'ask_graph', perTurn: 3,
        description: 'Ask the map of the wired coder\'s folder a question about the code, e.g. "how are tools registered". Answers with the files, functions and links that matter. Read only the files it names.',
        parameters: { type: 'object', properties: { question: { type: 'string', description: 'The question' }, budget: { type: 'number', description: 'Answer size in tokens, 1500 if left out, at most 3000' } }, required: ['question'] },
        ready,
        async run(args, context) {
          const question = String(args.question ?? '').trim().replace(/^-+/, '').slice(0, 300);
          if (!question) throw new Error('say what to ask the map');
          const { ref, summary } = await mapped(context);
          if (!summary) return { text: NO_MAP };
          const budget = Math.min(3000, Math.max(200, Math.round(Number(args.budget) || 1500)));
          return { text: `${dated(ref.name, summary.at, now())}\n${await ask(ref.dir, ['query', question, '--budget', String(budget)], budget * 4)}` };
        },
      },
      {
        name: 'affected_by', perTurn: 3,
        description: 'What in the wired coder\'s folder depends on one function, class or file, two steps out. Use it before a change, to see what it touches.',
        parameters: { type: 'object', properties: { name: { type: 'string', description: 'A function, class or file name, e.g. "createStore" or "store.ts"' } }, required: ['name'] },
        ready,
        async run(args, context) {
          const name = String(args.name ?? '').trim().replace(/^-+/, '').slice(0, 200);
          if (!name) throw new Error('name the function, class or file');
          const { ref, summary } = await mapped(context);
          if (!summary) return { text: NO_MAP };
          return { text: `${dated(ref.name, summary.at, now())}\n${await ask(ref.dir, ['affected', name, '--depth', '2'], 6000)}` };
        },
      },
    ];
  }
  return { map, view, tools, busy: (dir: string) => running.has(dir) };
}

// The version Graphify says it is, or null when it is not here or will not run.
export async function graphifyVersion(env: NodeJS.ProcessEnv = process.env, run?: Runner): Promise<string | null> {
  const bin = findTool('graphify', env);
  if (!run && !bin) return null;
  const ran = await (run ?? spawnRunner(() => bin))(['--version'], { env: childEnv(env), limit: 15_000 }).catch(() => null);
  return ran?.code === 0 ? /(\d+\.\d+\.\d+)/.exec(ran.out)?.[1] ?? null : null;
}

// The graph page Graphify draws is a page of its own, scripts and all: it opens sandboxed, on no origin of this app,
// allowed only its own inline script and the one drawing library it fetches.
const PAGE_POLICY = "default-src 'none'; script-src 'unsafe-inline' https://unpkg.com; style-src 'unsafe-inline'; img-src data:; sandbox allow-scripts";

export default {
  name: 'graph',
  install(deps: Deps) {
    const forbidden = [deps.workspace, deps.root];
    const run = deps.fake ? fakeRunner : spawnRunner(() => findTool('graphify'));
    const ready = () => (deps.fake || findTool('graphify') ? null : NOT_HERE);
    // The map's counts go onto the card, the way the coder's session does, so they are there after a restart.
    // Through the one stage queue, so a coder session saved at the same moment does not save a copy without this.
    async function keep(cardId: string, mark: GraphMark) {
      await patchStageVia(deps.store, (stage) => {
        stage.cards = (stage.cards ?? []).map((one) => (one.id === cardId && one.kind === 'project' ? { ...one, graph: mark } : one));
      });
    }
    const maps = createMaps({ workspace: deps.workspace, forbidden, run, ready, keep });
    const cardOf = async (cardId: string) => projects(await deps.store.loadStage()).find((one) => one.id === cardId);

    return {
      tools: maps.tools(),
      // Offered only to a person with a coder card wired to them: the map is of that card's folder.
      offer(tools: Tool[], stage: Stage, roomId: string) {
        if (wiredProject(stage, roomId)) return tools;
        return tools.filter((tool) => !['map_folder', 'ask_graph', 'affected_by'].includes(tool.name));
      },
      async route(req, res, path) {
        const asked = /^\/api\/coder\/([\w-]{1,80})\/(map|graph|graph\.html)$/.exec(path);
        if (!asked) return false;
        const [, cardId, what] = asked;
        const card = await cardOf(cardId);
        if (!card) { deps.json(res, 404, { error: 'there is no coder card by that name' }); return true; }
        try {
          if (what === 'map' && req.method === 'POST') {
            const problem = ready();
            if (problem) { deps.json(res, 409, { error: problem }); return true; }
            // The folder as the window has it now: the stage is saved a moment after a change.
            const sent = await deps.body(req).catch(() => ({}));
            const now = typeof sent?.path === 'string' && sent.path.trim() ? { ...card, path: sent.path } : card;
            projectDir(now.path, forbidden);
            void maps.map(now).catch(() => { /* said on the card */ });
            deps.json(res, 202, { started: true });
            return true;
          }
          if (what === 'graph' && req.method === 'GET') { deps.json(res, 200, await maps.view(card, `/api/coder/${cardId}/graph.html`)); return true; }
          if (what === 'graph.html' && req.method === 'GET') {
            const page = await readFile(join(mapDir(deps.workspace, projectDir(card.path, forbidden)), 'graph.html')).catch(() => null);
            if (!page) { deps.json(res, 404, { error: 'this folder has no map yet' }); return true; }
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PAGE_POLICY, 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache', 'content-length': String(page.length) });
            res.end(page);
            return true;
          }
        } catch (error) { deps.json(res, 409, { error: (error as Error).message }); return true; }
        return false;
      },
    };
  },
} satisfies Slice;
