import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { childEnv } from '../safety/env.ts';
import { findTool } from '../opencode/graph-kit.ts';
import type { LeadInput } from './store.ts';

// OpenOutreach, a lead finder the founder runs on this machine through uvx. It is GPL and stays a separate program:
// the app only starts it and reads what it prints. Of its verbs the app knows exactly two, `status` (never blocks,
// never spends) and `find`. The ones that put mail in strangers' inboxes are not in this file and never will be:
// sending stays with the founder, in the mail card.
const VERBS = ['status', 'find'] as const;
type Verb = (typeof VERBS)[number];

// What finding needs, as OpenOutreach names it. Only these are handed to it, and only because it needs them.
export const FIND_VARS = [
  'OPENOUTFIND_PRODUCT_DOCS', 'OPENOUTFIND_CAMPAIGN_TARGET', 'OPENOUTFIND_AI_MODEL', 'OPENOUTFIND_LLM_API_KEY',
  'OPENOUTFIND_BETTERCONTACT_API_KEY', 'OPENOUTFIND_OPERATOR_EMAIL', 'OPENOUTFIND_OPERATOR_COUNTRY', 'OPENOUTFIND_ACCEPT_LEGAL_NOTICE',
];
export const NO_UVX = 'uvx is not on this machine. Install uv (docs.astral.sh/uv) to find leads with OpenOutreach.';
export const FIND_LIMIT = 5 * 60_000;
const STATUS_LIMIT = 60_000;

export type Said = { code: number | null; out: string; err: string };
export type Runner = (args: string[], options: { env: NodeJS.ProcessEnv; limit: number; signal?: AbortSignal }) => Promise<Said>;

// The environment the child gets: none of the founder's other keys, and every OPENOUTFIND_ value from the app's own
// environment and from the repository's .env as it is now, so a key put there works without restarting the app.
export function outreachEnv(env: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
  let file: NodeJS.Dict<string> = {};
  try { file = parseEnv(readFileSync(resolve(root, '.env'), 'utf8')); } catch { /* no .env: the environment alone */ }
  const ours = Object.fromEntries(Object.entries({ ...env, ...file }).filter(([name, value]) => (name.startsWith('OPENOUTFIND_') || name === 'OPENOUTREACH_DB') && value));
  return { ...childEnv(env), ...ours, PYTHONUNBUFFERED: '1', NO_COLOR: '1' };
}

// `uvx openoutreach <verb> ...`, stdout and stderr kept apart: stdout is the result, stderr is everything else.
export function uvxRunner(bin: () => string | null = () => findTool('uvx')): Runner {
  return (args, { env, limit, signal }) => new Promise((settle, fail) => {
    if (!(VERBS as readonly string[]).includes(args[0])) { fail(new Error(`the app does not run "openoutreach ${args[0]}"`)); return; }
    const program = bin();
    if (!program) { fail(new Error(NO_UVX)); return; }
    const child = spawn(program, ['openoutreach', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => { if (out.length < 2_000_000) out += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { err = (err + chunk.toString()).slice(-20_000); });
    let why = '';
    const kill = (reason: string) => { why = reason; if (child.exitCode === null) child.kill('SIGTERM'); };
    const timer = setTimeout(() => kill(`OpenOutreach took longer than ${Math.round(limit / 60_000) || 1} minutes`), limit);
    const stop = () => kill('stopped');
    signal?.addEventListener('abort', stop, { once: true });
    child.once('error', (error) => { clearTimeout(timer); fail(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      // A run cut short still printed the leads it had: they are kept, and the reason goes with them.
      settle({ code, out, err: why ? `error: timeout: ${why}` : err });
    });
  });
}

// The last JSON object a stream carried, or null.
function lastJson(text: string): Record<string, any> | null {
  const whole = text.trim();
  try { return JSON.parse(whole); } catch { /* one per line, or none */ }
  for (const line of whole.split('\n').reverse()) { try { return JSON.parse(line); } catch { /* keep looking */ } }
  return null;
}

// Why finding cannot work yet, in one sentence, or null when it can. Read from `status --json`.
export function statusProblem(said: Said, env: NodeJS.ProcessEnv): string | null {
  const doc = lastJson(said.out) ?? lastJson(said.err);
  if (!doc) return `OpenOutreach did not answer: ${(said.err || said.out).trim().split('\n').pop()?.slice(0, 200) || `it ended with code ${said.code}`}.`;
  let missing: string[] = [];
  // A machine that never ran it has no database yet; `find` makes one, so only the settings are missing.
  if (doc.error?.type === 'not_initialized') missing = FIND_VARS.filter((name) => !env[name]);
  else if (doc.error) return `OpenOutreach says ${doc.error.type}: ${String(doc.error.message ?? '').slice(0, 200)}.`;
  else if (doc.config?.complete === false) missing = doc.next_action?.variables ?? Object.values(doc.config.missing ?? {}).flat();
  missing = [...new Set(missing.map(String).filter((name) => name.startsWith('OPENOUTFIND_')))].sort();
  return missing.length ? `OpenOutreach is not set up: put ${missing.join(', ')} in .env at the repository root.` : null;
}

// RFC 4180: quoted fields may hold commas, quotes (doubled) and line breaks. OpenOutreach's `reason` holds all three.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (quoted) {
      if (char === '"' && text[at + 1] === '"') { field += '"'; at++; } else if (char === '"') quoted = false; else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[at + 1] === '\n') at++;
      row.push(field); field = '';
      if (row.some((one) => one !== '')) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field);
  if (row.some((one) => one !== '')) rows.push(row);
  return rows;
}

// Each row as a lead. Its `reason` is OpenOutreach's written case for this person and becomes their first note; it
// has no score column on purpose, so none is made up here: score_lead gives the score, with icp-fit.
export function csvLeads(text: string): LeadInput[] {
  const [head, ...rows] = parseCsv(text);
  if (!head) return [];
  const at = (name: string) => head.findIndex((one) => one.trim().toLowerCase() === name);
  const read = (row: string[], name: string) => (at(name) >= 0 ? (row[at(name)] ?? '').trim() : '');
  return rows.flatMap((row) => {
    const name = [read(row, 'first_name'), read(row, 'last_name')].filter(Boolean).join(' ');
    const company = read(row, 'company');
    if (!name || !company) return [];
    const reason = read(row, 'reason');
    return [{
      name, company, title: read(row, 'title') || undefined, site: read(row, 'website') || undefined,
      linkedin: read(row, 'linkedin_url') || undefined, email: read(row, 'email') || undefined, source: 'openoutreach' as const,
      ...(reason ? { note: { by: 'OpenOutreach', text: `Why it picked them: ${reason}` } } : {}),
    }];
  });
}

// The one line OpenOutreach leaves on stderr when a run ends short of its goal: "error: <type>: <message>".
export function shortfall(said: Said): string | null {
  if (said.code === 0) return null;
  const line = said.err.trim().split('\n').reverse().find((one) => /^error:/.test(one.trim()));
  return line ? line.trim().replace(/^error:\s*/, '').slice(0, 300) : `it ended with code ${said.code}`;
}

export function createOutreach(options: { run: Runner; env: () => NodeJS.ProcessEnv; now?: () => number }) {
  const now = options.now ?? Date.now;
  let problem: string | null = 'OpenOutreach is being checked. Try again in a moment.';
  let checkedAt = 0;
  let checking: Promise<string | null> | null = null;
  const ask = (verb: Verb, rest: string[], limit: number, signal?: AbortSignal) => options.run([verb, ...rest], { env: options.env(), limit, signal });

  async function check(): Promise<string | null> {
    checking ??= ask('status', ['--json'], STATUS_LIMIT)
      .then((said) => statusProblem(said, options.env()), (error: Error) => error.message)
      .then((found) => { problem = found; checkedAt = now(); return found; })
      .finally(() => { checking = null; });
    return checking;
  }

  return {
    check,
    // What the loop asks before every call, so it cannot wait: the last answer, and a fresh look when that is old.
    ready(): string | null {
      if (now() - checkedAt > 60_000) void check();
      return problem;
    },
    async find(count: number, emails: boolean, signal?: AbortSignal): Promise<{ leads: LeadInput[]; short: string | null }> {
      const said = await ask('find', [String(count), '--new', ...(emails ? ['emails'] : [])], FIND_LIMIT, signal);
      return { leads: csvLeads(said.out), short: shortfall(said) };
    },
  };
}

// The OpenOutreach of fake mode and the tests: set up, and three leads found.
export const FIXTURE = resolve(import.meta.dirname, 'fixtures/find.csv');
export const fakeRunner: Runner = async (args) => {
  if (args[0] === 'status') return { code: 0, out: JSON.stringify({ config: { complete: true, done: [], missing: {} }, blocked: [] }), err: '' };
  if (args[0] === 'find') return { code: 0, out: readFileSync(FIXTURE, 'utf8'), err: '' };
  return { code: 1, out: '', err: 'error: bad_config: unknown verb' };
};
