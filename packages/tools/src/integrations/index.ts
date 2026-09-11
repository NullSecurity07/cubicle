import { readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import {
  type Vault, createJob, listJobs, nowIso, repoRoot, workspacePath, ciConfigPath, readProcess, loadOrg, incidentResponder,
  readStream, listStreams,
} from '@cubicle/core';

/**
 * The nine capabilities a company's toolchain has to cover (toolchain document §3, §57: one primary tool per
 * job). Each is served today by a vault-native adapter; `config/integrations.yaml` records which, and names the
 * self-hosted tool that would replace it. The interfaces below are deliberately the *smallest* surface the
 * company actually uses, so a real Forgejo or Plane adapter is a day's work rather than a rewrite.
 */
export const CAPABILITIES = ['work', 'docs', 'git', 'ci', 'chat', 'secrets', 'metrics', 'errors', 'automation'] as const;

/** Metrics sheets another writer owns end to end, and who owns them. `metrics.record` refuses these. */
const GENERATED_METRICS_SHEETS: Record<string, string> = {
  engineering: 'the weekly review (computeDora)',
  quota: 'the model router',
};

/** The column names of a markdown table's header row, or null when the text has no table yet. */
function headerColumns(text: string): string[] | null {
  const row = text.split('\n').find((l) => l.trim().startsWith('|'));
  if (!row) return null;
  return row.split('|').slice(1, -1).map((c) => c.trim()).filter(Boolean);
}
export type Capability = (typeof CAPABILITIES)[number];

const IntegrationEntry = z.object({ adapter: z.string(), note: z.string(), candidate: z.string() });
export type IntegrationEntry = z.infer<typeof IntegrationEntry>;

const Integrations = z.object(Object.fromEntries(CAPABILITIES.map((c) => [c, IntegrationEntry])) as Record<Capability, typeof IntegrationEntry>);
export const IntegrationsConfig = z.object({ integrations: Integrations });
export type IntegrationsConfig = z.infer<typeof IntegrationsConfig>;

export function parseIntegrations(text: string): IntegrationsConfig {
  return IntegrationsConfig.parse(YAML.parse(text));
}

export function loadIntegrations(file = path.join(repoRoot(), 'config', 'integrations.yaml')): IntegrationsConfig {
  return parseIntegrations(readFileSync(file, 'utf8'));
}

// ---------- capability interfaces ----------

export interface WorkItem { id: string; title: string; status: string; assigned: string; stream?: string }
export interface WorkAdapter {
  create(item: { title: string; type: string; assigned: string; goal: string; risk?: 'low' | 'medium' | 'high'; stream?: string; team?: string; owner_role?: string }): Promise<string>;
  listOpen(): Promise<WorkItem[]>;
}

export interface DocsAdapter {
  write(slug: string, markdown: string): Promise<string>;
  read(slug: string): Promise<string | null>;
}

export interface GitAdapter {
  /** Where a stream's repository lives, as a vault-relative path. */
  repoRoot(stream: string): string;
}

export interface CiAdapter {
  configPath(stream: string): string;
  /** The tool name an agent calls to run the pipeline. */
  toolName: string;
}

export interface ChatAdapter {
  post(toRole: string, text: string): Promise<void>;
}

export interface SecretsAdapter {
  get(name: string): Promise<string | null>;
  has(name: string): Promise<boolean>;
}

export interface MetricsAdapter {
  record(sheet: string, row: Record<string, number | string>): Promise<void>;
}

export interface ErrorsAdapter {
  /** Open an incident. Returns the job id. */
  report(e: { stream: string; title: string; detail: string }): Promise<string>;
}

export interface AutomationAdapter {
  list(): Promise<string[]>;
  has(name: string): Promise<boolean>;
}

export interface Adapters {
  work: WorkAdapter; docs: DocsAdapter; git: GitAdapter; ci: CiAdapter; chat: ChatAdapter;
  secrets: SecretsAdapter; metrics: MetricsAdapter; errors: ErrorsAdapter; automation: AutomationAdapter;
}

export interface AdapterDeps { vault: Vault; env: NodeJS.ProcessEnv }

const PROCESS_NAMES = ['feature', 'launch', 'new_product', 'opportunity', 'pricing', 'weekly_review'];

/** The defaults: everything the company needs, served by the vault it already has. */
export function vaultNativeAdapters({ vault, env }: AdapterDeps): Adapters {
  return {
    work: {
      async create(item) {
        return createJob(vault, { type: item.type, title: item.title, assigned: item.assigned, goal: item.goal, risk: item.risk, stream: item.stream, team: item.team, owner_role: item.owner_role }, 'daemon');
      },
      async listOpen() {
        return listJobs(vault, { status: ['queued', 'running', 'blocked', 'in_review'] }).map((j) => ({ id: j.id, title: j.title, status: j.status, assigned: j.assigned, stream: j.stream }));
      },
    },
    docs: {
      async write(slug, markdown) { const rel = `Docs/${slug}.md`; vault.writeText(rel, markdown, 'daemon'); return rel; },
      async read(slug) { return vault.readTextOrNull(`Docs/${slug}.md`); },
    },
    git: { repoRoot: (stream) => workspacePath(stream) },
    ci: { configPath: (stream) => ciConfigPath(stream), toolName: 'ci.run' },
    chat: {
      async post(toRole, text) {
        if (!loadOrg(vault).roles[toRole]) throw new Error(`no active role "${toRole}" to message`);
        vault.appendText(`Messages/${toRole}.md`, `\n## ${nowIso()} from daemon (note)\n\n${text}\n`, 'daemon');
      },
    },
    secrets: {
      async get(name) { const v = env[name]; return v && v.trim() ? v : null; },
      async has(name) { return !!(env[name] && env[name]!.trim()); },
    },
    metrics: {
      async record(sheet, row) {
        // A sheet someone else writes whole: the weekly review regenerates Metrics/engineering.md from the
        // event log and the router regenerates Metrics/quota.md on every quota update. A row appended to
        // either lands under a header it does not share — and is erased by the next regeneration anyway.
        const owner = GENERATED_METRICS_SHEETS[sheet];
        if (owner) throw new Error(`Metrics/${sheet}.md is written whole by ${owner}, not appended to: a row added here would be misaligned and erased by the next regeneration. Record this on a sheet of your own.`);
        const rel = `Metrics/${sheet}.md`;
        const keys = Object.keys(row);
        if (!keys.length) throw new Error(`metrics.record on "${sheet}" needs at least one column`);
        const existing = vault.readTextOrNull(rel);
        // The general form of the same bug: this appends a row keyed on *its* fields to whatever header the
        // file already has, so the first caller fixes the columns and every later caller with different fields
        // writes into the wrong ones. Say so instead of silently misaligning.
        const have = existing === null ? null : headerColumns(existing);
        const want = ['date', ...keys];
        if (have && have.join('|') !== want.join('|')) {
          throw new Error(`Metrics/${sheet}.md has the columns ${have.join(', ')}; this row has ${want.join(', ')}. A row appended under a different header lands in the wrong columns — pass the same fields, or use a new sheet.`);
        }
        const header = `| date | ${keys.join(' | ')} |\n|---|${keys.map(() => '---|').join('')}\n`;
        const line = `| ${nowIso().slice(0, 10)} | ${keys.map((k) => String(row[k])).join(' | ')} |\n`;
        vault.writeText(rel, (existing ?? `# ${sheet}\n\n${header}`).replace(/\n*$/, '\n') + line, 'daemon', { generated: true });
      },
    },
    errors: {
      async report({ stream, title, detail }) {
        // An incident against a stream that does not exist is an incident nobody can work: the SRE's first
        // instruction is to read the stream, and `Workspace/<stream>` is where the evidence lives.
        if (!readStream(vault, stream)) {
          const known = listStreams(vault).map((s) => s.slug);
          throw new Error(`no stream "${stream}" to report an error against. ${known.length ? `Known streams: ${known.join(', ')}.` : 'No streams exist yet.'}`);
        }
        // Who answers, and under which room and lead, comes from the org — the same lookup the daemon's own
        // incident trigger uses, so the two cannot drift and neither names a person (M6).
        const responder = incidentResponder(loadOrg(vault));
        return createJob(vault, {
          type: 'incident', title, assigned: responder.role, priority: 1, team: responder.team, owner_role: responder.lead, stream, risk: 'high',
          goal: `Something broke in production for stream "${stream}".\n\n${detail}\n\nDetect → triage → mitigate → recover → root cause → corrective actions → learning (operating model §33). Roll back first with deploy.site({ rollback: true }) if a deploy is implicated, then write the blameless postmortem to Docs/postmortems/ using Docs/postmortems/_template.md and finish with that path in artifacts.`,
          done_when: 'The stream is serving again and Docs/postmortems/<date>-<slug>.md has a timeline, an impact in hours, a root cause and at least one corrective action.',
        }, 'daemon');
      },
    },
    automation: {
      async list() { return PROCESS_NAMES.filter((n) => readProcess(vault, n) !== null); },
      async has(name) { return readProcess(vault, name) !== null; },
    },
  };
}

/**
 * The adapter serving a capability. Only the vault-native defaults exist today; a config that names anything
 * else throws rather than falling back, so a half-finished migration is loud instead of silently vault-backed.
 */
export function adapterFor<C extends Capability>(cfg: IntegrationsConfig, capability: C, deps: AdapterDeps): Adapters[C] {
  const want = cfg.integrations[capability].adapter;
  const native: Record<Capability, string> = { work: 'vault', docs: 'vault', git: 'local', ci: 'cubicle', chat: 'vault', secrets: 'env', metrics: 'vault', errors: 'cubicle', automation: 'vault' };
  if (want !== native[capability]) {
    throw new Error(`config/integrations.yaml sets ${capability}.adapter to "${want}", but only the vault-native "${native[capability]}" adapter is implemented. Build packages/tools/src/integrations/${want}.ts first (candidate: ${cfg.integrations[capability].candidate}).`);
  }
  return vaultNativeAdapters(deps)[capability];
}
