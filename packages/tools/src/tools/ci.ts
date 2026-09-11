import { z } from 'zod';
import { existsSync, lstatSync, openSync, readSync, fstatSync, closeSync, constants as FS_CONSTANTS } from 'node:fs';
import path from 'node:path';
import { defineTool } from '../registry.js';
import { readCiConfig, writeCiRecord, ciConfigPath, workspacePath, isValidStreamSlug, nowIso, type CiRecord, type CiStepResult } from '@cubicle/core';
import { sandboxExec } from './shell.js';

const MAX_STEP_OUTPUT = 8000;
/**
 * Ceiling on a whole pipeline, independent of `timeout_s` per step: ten steps at the 300 s maximum would
 * otherwise pin a worker for the best part of an hour. A pipeline that cannot finish inside this wants
 * splitting, and the record says so rather than the job silently stalling.
 */
const CI_TOTAL_TIMEOUT_MS = 15 * 60_000;

const SHA_RE = /^[0-9a-f]{40,64}$/;
/** A ref name git itself would accept, and nothing that could walk out of the repo. */
const REF_RE = /^refs\/[A-Za-z0-9._\-/]+$/;

/** A HEAD/ref/packed-refs file is a handful of bytes; nothing legitimate is bigger than this. */
const MAX_GIT_PLUMBING_FILE_BYTES = 8192;

/**
 * Read a small regular file without ever blocking on it: `lstatSync` first — a symlink's own lstat never
 * opens the link target, so a `.git/HEAD` symlinked to `/dev/zero` (or anywhere else) is caught here and
 * never reaches `open()`. Anything that isn't a plain file under the size cap is refused before it's opened.
 *
 * The open itself adds `O_NONBLOCK` and the file is re-checked with `fstatSync` on the open fd: opening a
 * FIFO for read blocks forever waiting for a writer *unless* `O_NONBLOCK` is set (POSIX open(2)), which is
 * the gap `lstatSync` alone can't close — the path could be swapped from a regular file to a FIFO between
 * the `lstatSync` and the `openSync` (TOCTOU). With `O_NONBLOCK` the open returns immediately either way,
 * and the `fstatSync` catches a FIFO that slipped through the race before any read is attempted.
 */
function readSmallRegularFile(p: string): string | null {
  let st;
  try { st = lstatSync(p); } catch { return null; }
  if (!st.isFile() || st.size > MAX_GIT_PLUMBING_FILE_BYTES) return null;
  let fd: number;
  try { fd = openSync(p, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NONBLOCK); } catch { return null; }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(MAX_GIT_PLUMBING_FILE_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8', 0, n);
  } catch { return null; }
  finally { closeSync(fd); }
}

/**
 * HEAD of the stream's own repo when it has one — evidence on the record, not the freshness rule.
 *
 * Read as plumbing files rather than by running git: the sandbox writes this directory, so `.git/config` is
 * attacker-authored, and `core.fsmonitor`, `core.pager`, `alias.*` and friends all make the host's git execute
 * a command of the config's choosing. Reading two files cannot — but `readFileSync` on a path the sandbox
 * fully controls is its own hole: `mkfifo .git/HEAD` (or a symlink to `/dev/zero`) makes an unbounded
 * `readFileSync` hang the daemon synchronously and forever, which the old spawned `git rev-parse` never
 * risked (it ran under a 5 s timeout). `readSmallRegularFile` is the bounded, non-blocking replacement.
 */
export function headOf(absWorkspace: string): string | null {
  const gitDir = path.join(absWorkspace, '.git');
  if (!existsSync(gitDir)) return null;
  try {
    const headRaw = readSmallRegularFile(path.join(gitDir, 'HEAD'));
    if (headRaw === null) return null;                                    // a .git *file* (worktree/submodule), FIFO, symlink, or oversized file
    const head = headRaw.trim();
    const m = head.match(/^ref:\s*(\S+)$/);
    if (!m) return SHA_RE.test(head) ? head : null;                        // detached HEAD
    const ref = m[1];
    if (!REF_RE.test(ref) || ref.split('/').includes('..')) return null;
    const loose = path.join(gitDir, ref);
    if (existsSync(loose)) {
      const shaRaw = readSmallRegularFile(loose);
      if (shaRaw === null) return null;
      const sha = shaRaw.trim();
      return SHA_RE.test(sha) ? sha : null;
    }
    const packed = path.join(gitDir, 'packed-refs');
    const packedText = readSmallRegularFile(packed);
    if (packedText === null) return null;                                 // an unborn branch has no commit yet (or packed-refs is unreadable/unsafe)
    for (const line of packedText.split('\n')) {
      const p = line.match(/^([0-9a-f]{40,64})\s+(\S+)$/);
      if (p && p[2] === ref) return p[1];
    }
    return null;
  } catch { return null; }
}

export const ciRun = defineTool({
  name: 'ci.run',
  description: 'Run a stream\'s pipeline from Workspace/<stream>/cubicle-ci.yaml inside the sandbox (build, lint, test, security-scan — whatever the file lists), and write the result to Workspace/<stream>/.cubicle-ci/<ts>.json. An engineer.ship job cannot finish without a green record newer than every source file, and qa.review reads the same record. Use `only` to re-run named steps while you iterate.',
  schema: {
    stream: z.string().describe('the Streams/<slug> whose Workspace/<slug> to run'),
    only: z.array(z.string()).default([]).describe('step names to run; empty runs them all in order'),
  },
  async handler({ stream, only }, ctx) {
    // Before the slug becomes a path or a Docker `--mount` CSV field. A model picks this argument, and
    // `Workspace/x,src=/etc` is a directory an agent can create with vault.write.
    if (!isValidStreamSlug(stream)) {
      return { ok: false, text: `"${stream}" is not a stream slug. Use the slug from the Streams/<slug>.md note: lower-case letters, digits and hyphens only, starting with a letter or digit, at most 48 characters. Call vault.list({ dir: "Streams" }) to see them.` };
    }
    const cfg = readCiConfig(ctx.vault, stream);
    if (!cfg.ok) return { ok: false, text: cfg.error };

    let steps = cfg.config.steps;
    if (only.length) {
      const known = new Set(steps.map((s) => s.name));
      const unknown = only.filter((n) => !known.has(n));
      if (unknown.length) return { ok: false, text: `unknown step(s): ${unknown.join(', ')}. ${ciConfigPath(stream)} defines: ${steps.map((s) => s.name).join(', ')}` };
      steps = steps.filter((s) => only.includes(s.name));
    }

    const abs = ctx.vault.abs(workspacePath(stream));
    const started = nowIso();
    const session = `ci-${stream}-${Date.now().toString(36)}`;
    ctx.events.emit({ type: 'shell.output', agent: ctx.roleId, job: ctx.jobId, payload: { session, stream: 'cmd', text: `$ ci.run ${stream} (${steps.map((s) => s.name).join(' → ')})` } });

    const results: CiStepResult[] = [];
    let green = true;
    const deadline = Date.now() + CI_TOTAL_TIMEOUT_MS;
    for (const step of steps) {
      const t0 = Date.now();
      const remaining = deadline - t0;
      if (remaining <= 0) {
        results.push({ name: step.name, code: null, ok: false, duration_ms: 0, output: `the pipeline hit its ${CI_TOTAL_TIMEOUT_MS / 60_000}-minute total budget before this step ran. Split the pipeline, lower timeout_s, or re-run the rest with only: ["${step.name}", …].` });
        green = false;
        break;
      }
      const exec = await sandboxExec(ctx, {
        command: step.run,
        mounts: [{ src: abs, dst: '/work/stream' }, { src: ctx.vault.abs(`.cubicle/workspace/${ctx.jobId ?? 'ci'}/scratch`), dst: '/work/scratch' }],
        workdir: '/work/stream',
        network: cfg.config.network,
        timeoutMs: Math.min(cfg.config.timeout_s * 1000, remaining),
        session,
        where: 'ci.run',
      });
      if ('refused' in exec) return { ok: false, text: `${exec.refused} (CI step "${step.name}" never ran)` };
      const ok = !exec.timedOut && exec.code === 0;
      const limitS = Math.round(Math.min(cfg.config.timeout_s * 1000, remaining) / 1000);
      results.push({ name: step.name, code: exec.code, ok, duration_ms: Date.now() - t0, output: (exec.timedOut ? `TIMED OUT after ${limitS}s\n` : '') + exec.output.slice(-MAX_STEP_OUTPUT) });
      if (!ok && !step.allow_failure) { green = false; break; }   // §17: stop at the first blocking failure, the rest tells you nothing new
    }

    const record: CiRecord = { stream, started, finished: nowIso(), green, commit: headOf(abs), steps: results };
    const recPath = writeCiRecord(ctx.vault, stream, record, ctx.roleId);
    ctx.events.emit({ type: 'ci.completed', agent: ctx.roleId, job: ctx.jobId, payload: { stream, green, record: recPath, steps: results.map((s) => ({ name: s.name, ok: s.ok, code: s.code })) } });

    const lines = results.map((s) => `${s.ok ? 'PASS' : 'FAIL'} ${s.name} (exit ${s.code}, ${s.duration_ms} ms)${s.ok ? '' : `\n${s.output.slice(-1500)}`}`);
    const advisory = results.filter((s) => !s.ok && green).map((s) => s.name);
    const tail = advisory.length ? `\n[advisory only — allow_failure: ${advisory.join(', ')}]` : '';
    return {
      ok: green,
      text: `${green ? 'GREEN' : 'RED'} — ${recPath}\n${lines.join('\n')}${tail}`,
      data: { green, record: recPath, steps: results.map((s) => ({ name: s.name, ok: s.ok, code: s.code })) },
    };
  },
});
