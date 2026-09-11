import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineTool } from '../registry.js';
import { readCiConfig, writeCiRecord, ciConfigPath, workspacePath, nowIso, type CiRecord, type CiStepResult } from '@cubicle/core';
import { sandboxExec } from './shell.js';

const MAX_STEP_OUTPUT = 8000;

/** HEAD of the stream's own repo when it has one — evidence on the record, not the freshness rule. */
function headOf(absWorkspace: string): string | null {
  if (!existsSync(path.join(absWorkspace, '.git'))) return null;
  try { return execFileSync('git', ['-C', absWorkspace, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

export const ciRun = defineTool({
  name: 'ci.run',
  description: 'Run a stream\'s pipeline from Workspace/<stream>/cubicle-ci.yaml inside the sandbox (build, lint, test, security-scan — whatever the file lists), and write the result to Workspace/<stream>/.cubicle-ci/<ts>.json. An engineer.ship job cannot finish without a green record newer than every source file, and qa.review reads the same record. Use `only` to re-run named steps while you iterate.',
  schema: {
    stream: z.string().describe('the Streams/<slug> whose Workspace/<slug> to run'),
    only: z.array(z.string()).default([]).describe('step names to run; empty runs them all in order'),
  },
  async handler({ stream, only }, ctx) {
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
    for (const step of steps) {
      const t0 = Date.now();
      const exec = await sandboxExec(ctx, {
        command: step.run,
        mounts: [{ src: abs, dst: '/work/stream' }, { src: ctx.vault.abs(`.cubicle/workspace/${ctx.jobId ?? 'ci'}/scratch`), dst: '/work/scratch' }],
        workdir: '/work/stream',
        network: cfg.config.network,
        timeoutMs: cfg.config.timeout_s * 1000,
        session,
        where: 'ci.run',
      });
      if ('refused' in exec) return { ok: false, text: `${exec.refused} (CI step "${step.name}" never ran)` };
      const ok = !exec.timedOut && exec.code === 0;
      results.push({ name: step.name, code: exec.code, ok, duration_ms: Date.now() - t0, output: (exec.timedOut ? `TIMED OUT after ${cfg.config.timeout_s}s\n` : '') + exec.output.slice(-MAX_STEP_OUTPUT) });
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
