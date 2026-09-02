import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defineTool } from '../registry.js';
import { fileURLToPath } from 'node:url';

export const PROXY_CONTAINER = 'cubicle-proxy';
export const INTERNAL_NETWORK = 'cubicle-internal';
const PROXY_PORT = 3128;

export const SANDBOX_IMAGE = 'cubicle-sandbox';
const SHELL_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT = 60_000;

let dockerAvailable: { at: number; ok: boolean } | null = null;
export function hasDocker(): boolean {
  if (dockerAvailable && Date.now() - dockerAvailable.at < 60_000) return dockerAvailable.ok; // re-check every minute (Docker may start later)
  let ok = false;
  try { execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }); ok = true; } catch { ok = false; }
  dockerAvailable = { at: Date.now(), ok };
  return ok;
}
export function hasSandboxImage(): boolean {
  try { execFileSync('docker', ['image', 'inspect', SANDBOX_IMAGE], { stdio: 'ignore', timeout: 8000 }); return true; } catch { return false; }
}

function docker(args: string[], timeout = 20000): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout }).trim();
}

function proxyScriptPath(): string {
  // packages/tools/src/tools → repo root /config/sandbox/proxy.mjs (same relative depth from dist/)
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'config', 'sandbox', 'proxy.mjs');
}

/**
 * Enforced egress allow-list: sandboxes run on an *internal* network (no gateway, no host, no internet) whose only
 * other member is the proxy sidecar, which is also on the default bridge for real egress. The sidecar is reused
 * across calls and recreated when the allow-list changes.
 */
export function ensureProxySidecar(allow: string[], log: (m: string) => void = () => undefined): { proxyUrl: string } {
  try { docker(['network', 'inspect', INTERNAL_NETWORK]); } catch { docker(['network', 'create', '--internal', INTERNAL_NETWORK]); }
  const wanted = allow.join(',');
  let running = false;
  try {
    const out = docker(['inspect', '--format', '{{.State.Running}} {{index .Config.Labels "cubicle.allow"}}', PROXY_CONTAINER]);
    const [state, label] = out.split(' ', 2);
    running = state === 'true' && label === wanted;
    if (!running) docker(['rm', '-f', PROXY_CONTAINER]);
  } catch { /* not present */ }
  if (!running) {
    docker(['run', '-d', '--name', PROXY_CONTAINER, '--restart', 'unless-stopped', '--label', `cubicle.allow=${wanted}`, '--network', 'bridge',
      '--memory', '128m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--user', '65534:65534', '--tmpfs', '/tmp',
      '--mount', `type=bind,src=${proxyScriptPath()},dst=/proxy.mjs,readonly`, 'node:26-bookworm', 'node', '/proxy.mjs', '--port', String(PROXY_PORT), '--allow', wanted]);
    docker(['network', 'connect', INTERNAL_NETWORK, PROXY_CONTAINER]);
    log(`started ${PROXY_CONTAINER} (${wanted})`);
  }
  return { proxyUrl: `http://${PROXY_CONTAINER}:${PROXY_PORT}` };
}

/** Hosts the proxy refused during a window (from its stdout). */
export function proxyDenials(since = '5m'): string[] {
  try { return [...new Set(docker(['logs', '--since', since, PROXY_CONTAINER]).split('\n').filter((l) => l.includes('DENY ')).map((l) => l.split('DENY ')[1].trim()))]; } catch { return []; }
}

interface RunResult { code: number | null; output: string; timedOut: boolean; mode: 'docker' | 'local' }

async function runProcess(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; onOutput: (chunk: string, stream: 'stdout' | 'stderr') => void }): Promise<{ code: number | null; timedOut: boolean; output: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    const push = (d: Buffer, s: 'stdout' | 'stderr') => { const t = d.toString(); if (output.length < MAX_OUTPUT) output += t; opts.onOutput(t, s); };
    p.stdout.on('data', (d) => push(d, 'stdout'));
    p.stderr.on('data', (d) => push(d, 'stderr'));
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, opts.timeoutMs);
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, timedOut, output: output.slice(0, MAX_OUTPUT) }); });
    p.on('error', (err) => { clearTimeout(timer); resolve({ code: null, timedOut, output: `spawn failed: ${err.message}` }); });
  });
}

export const shellRun = defineTool({
  name: 'shell.run',
  description: 'Run a shell command in the sandbox: Site/ is mounted at /work/Site (cwd), scratch at /work/scratch, a ready Astro template with deps at /opt/templates/minimal (cp -a /opt/templates/minimal/. . && npm run build). No network unless network="allowlist" (npm registry, GitHub, jsDelivr only). 5-minute limit.',
  schema: {
    command: z.string().describe('bash command line'),
    cwd: z.enum(['Site', 'scratch']).default('Site'),
    network: z.enum(['none', 'allowlist']).default('none').describe('"allowlist" lets the command reach npm/GitHub/jsDelivr through the proxy'),
    timeout_s: z.number().int().min(1).max(300).default(300),
  },
  async handler({ command, cwd, network, timeout_s }, ctx) {
    const siteDir = ctx.vault.abs('Site');
    const scratchDir = ctx.vault.abs(`.cubicle/workspace/${ctx.jobId ?? 'shell'}/scratch`);
    mkdirSync(siteDir, { recursive: true }); mkdirSync(scratchDir, { recursive: true });
    const timeoutMs = Math.min(timeout_s * 1000, SHELL_TIMEOUT_MS);
    const sessionId = `${ctx.jobId ?? 'shell'}-${Date.now().toString(36)}`;
    const onOutput = (chunk: string, stream: 'stdout' | 'stderr') => ctx.events.emit({ type: 'shell.output', agent: ctx.roleId, job: ctx.jobId, payload: { session: sessionId, stream, text: chunk.slice(0, 4000) } });
    ctx.events.emit({ type: 'shell.output', agent: ctx.roleId, job: ctx.jobId, payload: { session: sessionId, stream: 'cmd', text: `$ ${command}`, cwd, network } });

    // Owner-edited Site/ files are protected even inside the sandbox: snapshot them, restore after the run (R34, principle 4).
    const protectedFiles = new Map<string, Buffer>();
    for (const rel of ctx.vault.list('Site', { recursive: true })) if (ctx.vault.isOwnerChanged(rel)) { try { protectedFiles.set(rel, readFileSync(ctx.vault.abs(rel))); } catch { /* unreadable */ } }
    let result: RunResult;
    let proxied = false;
    if (hasDocker() && hasSandboxImage()) {
      const cname = `cubicle-${sessionId}`.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 60);
      const args = ['run', '--rm', '--init', '--name', cname,
        '--mount', `type=bind,src=${siteDir},dst=/work/Site`, '--mount', `type=bind,src=${scratchDir},dst=/work/scratch`, '-w', cwd === 'Site' ? '/work/Site' : '/work/scratch',
        '--memory', '2g', '--cpus', '2', '--pids-limit', '512', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:exec',
        '-e', 'HOME=/work/scratch', '-e', 'CI=1', '-e', 'npm_config_update_notifier=false', '-e', 'npm_config_cache=/work/scratch/.npm'];
      // Run as the host user so files written under Site/ stay editable by the owner and the daemon.
      if (typeof process.getuid === 'function' && typeof process.getgid === 'function') args.push('--user', `${process.getuid()}:${process.getgid()}`);
      if (network === 'allowlist') {
        try {
          const { proxyUrl } = ensureProxySidecar(ctx.config.sandbox_allowlist, (m) => ctx.events.emit({ type: 'shell.output', agent: ctx.roleId, job: ctx.jobId, payload: { session: sessionId, stream: 'info', text: m } }));
          proxied = true;
          args.push('--network', INTERNAL_NETWORK, '-e', `HTTP_PROXY=${proxyUrl}`, '-e', `HTTPS_PROXY=${proxyUrl}`, '-e', `http_proxy=${proxyUrl}`, '-e', `https_proxy=${proxyUrl}`, '-e', `npm_config_proxy=${proxyUrl}`, '-e', `npm_config_https_proxy=${proxyUrl}`, '-e', 'NODE_USE_ENV_PROXY=1', '-e', 'GIT_CONFIG_COUNT=1', '-e', 'GIT_CONFIG_KEY_0=http.proxy', '-e', `GIT_CONFIG_VALUE_0=${proxyUrl}`);
        } catch (err) {
          ctx.events.emit({ type: 'daemon.warning', agent: ctx.roleId, job: ctx.jobId, payload: { where: 'shell.run', message: `proxy sidecar unavailable (${(err as Error).message.slice(0, 120)}); running without network` } });
          args.push('--network', 'none');
        }
      } else {
        args.push('--network', 'none');
      }
      // `timeout` inside the container too: a daemon kill -9 must not leave an unbounded process running.
      args.push(SANDBOX_IMAGE, 'timeout', '--signal=KILL', String(Math.ceil(timeoutMs / 1000)), 'bash', '-lc', command);
      const r = await runProcess('docker', args, { timeoutMs: timeoutMs + 5000, onOutput });
      if (r.timedOut || r.code === 137) { try { execFileSync('docker', ['rm', '-f', cname], { stdio: 'ignore' }); } catch { /* gone */ } }
      result = { ...r, timedOut: r.timedOut || r.code === 137, mode: 'docker' };
    } else {
      // No sandbox. The local fallback is opt-in (owner_preferences: shell_local_fallback: true) and jailed with bwrap when available.
      const why = hasDocker() ? `image ${SANDBOX_IMAGE} missing (run: cubicle doctor --build-sandbox)` : 'Docker unavailable';
      if (!ctx.vault.ownerPreferences().shell_local_fallback) {
        ctx.events.emit({ type: 'guardrail.blocked', agent: ctx.roleId, job: ctx.jobId, payload: { tool: 'shell.run', reason: `${why}; local shell fallback is disabled (set shell_local_fallback: true in Memory/owner_preferences.md to allow a bwrap-jailed local shell)` } });
        return { ok: false, text: `blocked: ${why}. The owner can enable a jailed local shell with shell_local_fallback: true in Memory/owner_preferences.md.` };
      }
      ctx.events.emit({ type: 'daemon.warning', agent: ctx.roleId, job: ctx.jobId, payload: { where: 'shell.run', message: `${why}; using the jailed local shell` } });
      const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: '/work/scratch', TMPDIR: '/tmp', CI: '1', LANG: 'C.UTF-8', CUBICLE_SANDBOX: 'local' };
      let hasBwrap = false;
      try { execFileSync('bwrap', ['--version'], { stdio: 'ignore', timeout: 3000 }); hasBwrap = true; } catch { hasBwrap = false; }
      if (!hasBwrap) {
        ctx.events.emit({ type: 'guardrail.blocked', agent: ctx.roleId, job: ctx.jobId, payload: { tool: 'shell.run', reason: 'bwrap (bubblewrap) is not installed; refusing an unjailed local shell' } });
        return { ok: false, text: 'blocked: no Docker sandbox and no bubblewrap (bwrap) to jail a local shell. Install Docker or bubblewrap.' };
      }
      const bw = ['--ro-bind', '/usr', '/usr', '--ro-bind', '/etc', '/etc', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin',
        '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--bind', siteDir, '/work/Site', '--bind', scratchDir, '/work/scratch', '--chdir', cwd === 'Site' ? '/work/Site' : '/work/scratch',
        '--unshare-all', '--die-with-parent', '--new-session', '--clearenv'];
      for (const [k, v] of Object.entries(env)) bw.push('--setenv', k, String(v));
      const r = await runProcess('bwrap', [...bw, 'bash', '-c', command], { timeoutMs, onOutput });
      result = { ...r, mode: 'local' };
    }
    // Restore any owner-edited file the command touched, before the rescan would re-label it as an agent write.
    const clobbered: string[] = [];
    for (const [rel, before] of protectedFiles) {
      const abs = ctx.vault.abs(rel);
      const after = existsSync(abs) ? readFileSync(abs) : null;
      if (!after || !after.equals(before)) { mkdirSync(path.dirname(abs), { recursive: true }); writeFileSync(abs, before); clobbered.push(rel); }
    }
    if (clobbered.length) ctx.events.emit({ type: 'guardrail.blocked', agent: ctx.roleId, job: ctx.jobId, payload: { tool: 'shell.run', reason: `restored ${clobbered.length} owner-edited Site/ file(s) the command changed`, files: clobbered.slice(0, 20) } });
    // Out-of-band writes: record them so owner-edit detection stays exact (R2).
    const changed = ctx.vault.rescan('Site', `${ctx.roleId}/shell`, { job: ctx.jobId, skip: new Set(protectedFiles.keys()) });
    const deniedHosts = proxied ? proxyDenials('2m') : [];
    const denied = deniedHosts.length ? `\n[proxy denied: ${deniedHosts.join(', ')}]` : '';
    const status = result.timedOut ? `TIMED OUT after ${timeoutMs / 1000}s` : `exit ${result.code}`;
    const restored = clobbered.length ? `\n[RESTORED owner-edited files your command changed (they are read-only for you): ${clobbered.join(', ')} — ask the owner via proposal.create kind=message if they must change]` : '';
    return { ok: !result.timedOut && result.code === 0, text: `[${result.mode}] ${status}${denied}\n${result.output || '(no output)'}${changed.length ? `\n[changed under Site/: ${changed.slice(0, 20).join(', ')}${changed.length > 20 ? ` +${changed.length - 20} more` : ''}]` : ''}${restored}`, data: { code: result.code, timedOut: result.timedOut, mode: result.mode, changed, restored: clobbered } };
  },
});
