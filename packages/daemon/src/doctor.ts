import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { repoRoot, loadOrg, officeRole, OFFICES, Vault, divisionTeams, type Org, DEFAULT_OFFICES } from '@cubicle/core';
import { loadProvidersConfig, apiKeyFor, hasPrices } from '@cubicle/router';
import { hasDocker, hasSandboxImage, SANDBOX_IMAGE } from '@cubicle/tools';

export interface DoctorRow { area: string; item: string; ok: boolean | null; detail: string; fix?: string }

/**
 * One row per office: the mapping is what gates, escalation and planning resolve through, so an office pointing
 * at a role that was fired or deactivated is a silent company-wide failure — everything lands on the CEO instead.
 */
export function officeRows(org: Org): DoctorRow[] {
  const rows: DoctorRow[] = OFFICES.map((office) => {
    const named = org.offices?.[office] ?? DEFAULT_OFFICES[office];
    const ok = officeRole(org, office) !== null;
    return {
      area: 'org', item: `office ${office}`, ok,
      detail: ok ? named : `${named} is missing or inactive — this office falls back to the team lead`,
      fix: `set a live role for \`${office}\` under \`offices:\` in Memory/constitution.md, or re-activate Roles/${named}.md`,
    };
  });
  // A key the OFFICES enum does not know is merged into the map (org.ts) and then never looked up, so a typo
  // — `securty:`, `chief_exec:` — is silently inert: the office it was meant to re-staff keeps its old holder
  // and nothing anywhere says so. Spec item 5 asks doctor for office *mapping gaps*, and this is the one gap
  // the per-office rows above cannot see (final review M2).
  const unknown = Object.keys(org.offices ?? {}).filter((k) => !(OFFICES as readonly string[]).includes(k));
  rows.push({
    area: 'org', item: 'offices: keys', ok: unknown.length === 0,
    detail: unknown.length ? `${unknown.join(', ')} ${unknown.length === 1 ? 'is not an office' : 'are not offices'} and ${unknown.length === 1 ? 'is' : 'are'} ignored` : `all ${OFFICES.length} keys are known offices`,
    fix: `the offices are: ${OFFICES.join(', ')} — fix or remove the extra key(s) under \`offices:\` in Memory/constitution.md`,
  });
  // A division is a top-level team with at least one room under it, and only divisions hold a planning round.
  // Strip a `parent:` (or make the chain cyclic) in an owner edit and `divisionTeams` goes empty: the heartbeat
  // then fans out zero division plans for ever, with nothing but `daemon.warning`s to show for it.
  const divisions = divisionTeams(org);
  rows.push({
    area: 'org', item: 'planning rounds', ok: divisions.length > 0,
    detail: divisions.length ? divisions.map((t) => `${t.id} (lead ${t.lead})`).join(', ') : 'no team holds a planning round — every heartbeat will fan out zero division plans',
    fix: 'a division is a team with no `parent:` and at least one team whose `parent:` names it; check the `parent:` lines in Teams/*.md',
  });
  return rows;
}


async function get(url: string, headers: Record<string, string> = {}, timeoutMs = 8000): Promise<{ status: number; text: string }> {
  try { const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) }); return { status: r.status, text: (await r.text()).slice(0, 300) }; }
  catch (err) { return { status: 0, text: (err as Error).message }; }
}

export async function runDoctor(env: NodeJS.ProcessEnv, opts: { live?: boolean; buildSandbox?: boolean; providersPath?: string; vaultPath?: string } = {}): Promise<DoctorRow[]> {
  const rows: DoctorRow[] = [];
  const setup = 'see SETUP.md';
  const cfg = loadProvidersConfig(opts.providersPath ?? path.join(repoRoot(), 'config', 'providers.yaml'));
  // Required local models come from config/providers.yaml (no model ids in source): every enabled ollama chat model + the embeddings model.
  const ollamaCfg = cfg.providers.find((p) => p.id === 'ollama' && p.enabled);
  // The floor needs one local chat model (the first enabled one) and the embeddings model; other local models are optional.
  const firstLocal = ollamaCfg?.models.find((m) => m.enabled)?.id;
  const REQUIRED_OLLAMA = [...(firstLocal ? [firstLocal] : []), ...(ollamaCfg?.embeddings ? [ollamaCfg.embeddings.id] : [])];

  const priced = hasPrices(cfg);
  rows.push({
    area: 'money', item: 'model prices', ok: null,
    detail: priced ? 'at least one model carries a price; Ledger/runway.md can say what a paid tier costs' : 'no model carries a price, so the shadow cost in Ledger/runway.md is 0 — which is correct while everything is free',
    fix: 'add `price: { input_per_mtok, output_per_mtok }` (cents per million tokens) to a paid model in config/providers.yaml',
  });

  // Ollama
  const tags = await get('http://localhost:11434/api/tags');
  if (tags.status === 200) {
    rows.push({ area: 'local', item: 'ollama', ok: true, detail: 'reachable at localhost:11434' });
    const full = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(8000) }).then((r) => r.json() as Promise<{ models?: { name: string }[] }>).catch(() => ({ models: [] }));
    const have = (full.models ?? []).map((m) => m.name);
    for (const m of REQUIRED_OLLAMA) { const ok = have.some((h) => h === m || h.startsWith(m + ':')); rows.push({ area: 'local', item: `ollama model ${m}`, ok, detail: ok ? 'pulled' : 'missing', fix: `ollama pull ${m}` }); }
  } else rows.push({ area: 'local', item: 'ollama', ok: false, detail: `not reachable (${tags.text.slice(0, 60)})`, fix: `install and start Ollama; ollama pull ${REQUIRED_OLLAMA.join(' ')}` });

  // Docker + sandbox
  rows.push({ area: 'local', item: 'docker', ok: hasDocker(), detail: hasDocker() ? 'daemon reachable' : 'not reachable', fix: 'start Docker (without it shell.run is refused unless shell_local_fallback: true and bubblewrap are present)' });
  if (hasDocker()) {
    if (opts.buildSandbox && !hasSandboxImage()) {
      const r = spawnSync('docker', ['build', '-t', SANDBOX_IMAGE, path.join(repoRoot(), 'config', 'sandbox')], { stdio: 'inherit' });
      rows.push({ area: 'local', item: 'sandbox image build', ok: r.status === 0, detail: r.status === 0 ? 'built' : `exit ${r.status}` });
    }
    rows.push({ area: 'local', item: `image ${SANDBOX_IMAGE}`, ok: hasSandboxImage(), detail: hasSandboxImage() ? 'present' : 'missing', fix: 'pnpm cubicle doctor --build-sandbox' });
  }

  // Playwright
  try {
    const { chromium } = await import('playwright');
    const exe = chromium.executablePath();
    if (!existsSync(exe)) throw new Error(`chromium binary missing at ${exe}`);
    if (opts.live) { const b = await chromium.launch({ headless: true }); await b.close(); }
    rows.push({ area: 'local', item: 'playwright chromium', ok: true, detail: opts.live ? 'launches' : 'binary present (run with --live to launch)' });
  } catch (err) { rows.push({ area: 'local', item: 'playwright chromium', ok: false, detail: String((err as Error).message).split('\n')[0].slice(0, 80), fix: 'pnpm --filter @cubicle/tools exec playwright install chromium' }); }

  // git identity
  try { const n = execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8' }).trim(); rows.push({ area: 'local', item: 'git identity', ok: true, detail: n }); }
  catch { rows.push({ area: 'local', item: 'git identity', ok: null, detail: 'none globally (the vault repo gets a local "cubicle" identity)' }); }

  // Tray shell (Tauri): both are required to build packages/app.
  const pk = spawnSync('pkg-config', ['--exists', 'webkit2gtk-4.1']);
  rows.push({ area: 'local', item: 'webkit2gtk-4.1 (tray shell)', ok: pk.status === 0, detail: pk.status === 0 ? 'installed' : 'missing — the Tauri tray cannot build', fix: 'sudo pacman -S --needed webkit2gtk-4.1 libappindicator-gtk3 librsvg base-devel' });
  const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
  rows.push({ area: 'local', item: 'cargo (tray shell)', ok: cargo.status === 0, detail: cargo.status === 0 ? String(cargo.stdout).trim() : 'missing — the Tauri tray cannot build', fix: 'https://rustup.rs' });

  // Providers
  for (const p of cfg.providers) {
    if (!p.enabled) continue;
    if (!p.api_key_env) continue;
    const key = apiKeyFor(p, env);
    if (!key) { rows.push({ area: 'providers', item: p.id, ok: false, detail: `${p.api_key_env} not set`, fix: setup }); continue; }
    if (opts.live) {
      const r = await get(`${p.base_url.replace(/\/$/, '')}/models`, { authorization: `Bearer ${key}` });
      rows.push({ area: 'providers', item: p.id, ok: r.status === 200, detail: r.status === 200 ? 'key valid (models list ok)' : `HTTP ${r.status}`, fix: setup });
    } else rows.push({ area: 'providers', item: p.id, ok: true, detail: `${p.api_key_env} set (run with --live to verify)` });
  }
  if (env.GEMINI_API_KEY) rows.push({ area: 'providers', item: 'gemini limits', ok: null, detail: 'copy your real free-tier RPM/RPD from https://aistudio.google.com/rate-limit into config/providers.yaml' });

  // Services
  const svc: { item: string; vars: string[]; live?: () => Promise<{ status: number; text: string }> }[] = [
    { item: 'brevo (email out)', vars: ['BREVO_API_KEY', 'BREVO_SENDER_EMAIL'], live: () => get('https://api.brevo.com/v3/account', { 'api-key': env.BREVO_API_KEY! }) },
    { item: 'imap (email in)', vars: ['IMAP_HOST', 'IMAP_USER', 'IMAP_PASS'] },
    { item: 'cloudflare pages (deploy)', vars: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'], live: () => get(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/pages/projects`, { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }) },
    { item: 'stripe (payment links)', vars: ['STRIPE_SECRET_KEY'], live: () => get('https://api.stripe.com/v1/balance', { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }) },
    { item: 'goatcounter (analytics)', vars: ['GOATCOUNTER_CODE', 'GOATCOUNTER_API_TOKEN'], live: () => get(`https://${env.GOATCOUNTER_CODE}.goatcounter.com/api/v0/me`, { authorization: `Bearer ${env.GOATCOUNTER_API_TOKEN}` }) },
  ];
  for (const s of svc) {
    const missing = s.vars.filter((v) => !env[v]);
    if (missing.length) { rows.push({ area: 'services', item: s.item, ok: false, detail: `missing ${missing.join(', ')} → mock mode`, fix: setup }); continue; }
    if (opts.live && s.live) { const r = await s.live(); rows.push({ area: 'services', item: s.item, ok: r.status === 200, detail: r.status === 200 ? 'key valid' : `HTTP ${r.status}: ${r.text.slice(0, 80)}`, fix: setup }); }
    else rows.push({ area: 'services', item: s.item, ok: true, detail: 'keys set (run with --live to verify)' });
  }
  if (!existsSync(path.join(repoRoot(), '.env'))) rows.push({ area: 'services', item: '.env', ok: null, detail: 'no .env at the repo root; keys come from the environment only', fix: 'cp .env.example .env' });

  // Org: only when a vault was given — `cubicle doctor` is also run before any vault exists.
  if (opts.vaultPath) {
    try {
      const vault = Vault.open(opts.vaultPath);
      try { rows.push(...officeRows(loadOrg(vault))); } finally { vault.close(); }
    } catch (err) {
      rows.push({ area: 'org', item: 'offices', ok: null, detail: `could not read ${opts.vaultPath}: ${String((err as Error).message).slice(0, 80)}` });
    }
  } else rows.push({ area: 'org', item: 'offices', ok: null, detail: 'no vault given (pass --vault <path> or set CUBICLE_VAULT to check the office map)' });
  return rows;
}

export function formatDoctor(rows: DoctorRow[]): string {
  const w = (s: string, n: number) => s.padEnd(n).slice(0, n);
  const lines = rows.map((r) => `${r.ok === true ? '✔' : r.ok === false ? '✘' : '·'} ${w(r.area, 10)}${w(r.item, 32)}${r.detail}${r.ok === false && r.fix ? `\n      fix: ${r.fix}` : ''}`);
  const bad = rows.filter((r) => r.ok === false).length;
  const blocking = rows.filter((r) => r.ok === false && r.area === 'local' && /^ollama/.test(r.item)).length;
  lines.push('', bad ? `${bad} item(s) need attention${blocking ? ` — ${blocking} of them block the local floor (Ollama)` : ' — none block the daemon; missing services run in mock mode.'}` : 'all checks passed');
  return lines.join('\n');
}

/** Exit status for the CLI: 1 only when the always-available floor (Ollama + its models) is missing. */
export function doctorExitCode(rows: DoctorRow[]): number {
  return rows.some((r) => r.ok === false && r.area === 'local' && /^ollama/.test(r.item)) ? 1 : 0;
}
