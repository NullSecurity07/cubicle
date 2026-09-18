import { cpSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vault } from './vault.js';
import { autoCommit } from './git.js';
import { listFilesRecursive, sha256, atomicWriteSync } from './fs.js';
import { placeholderSquare } from './png.js';
import { ENV_EXAMPLE } from './env-example.js';
import { parseNote } from './frontmatter.js';
import { loadCampusMap, migrationLayout, writeLayout, OFFICE_LAYOUT_PATH } from './layout.js';
import { loadOrg } from './org.js';

/** Repo root, resolved from this file (works from src/ via tsx and from dist/). */
export function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..');
}

export function templateDir(): string {
  return path.join(repoRoot(), 'vault-template');
}

export const BRAND_LOGO = 'Brand/logo.png';

/**
 * The placeholder logo a new vault gets: a 64px square in the brand's primary colour with a centred accent
 * square, drawn from `Brand/palette.md` (defaults when it is missing or has no colours). Exported so a vault
 * scaffolded before `Brand/logo.png` existed can be given the very same image later.
 */
export function placeholderLogo(paletteMarkdown: string | null): Buffer {
  const palette = (paletteMarkdown ? parseNote(paletteMarkdown).data : {}) as { primary?: string; accent?: string };
  return placeholderSquare(64, palette.primary ?? '#1f2937', palette.accent ?? '#f59e0b');
}

export interface ScaffoldResult {
  vault: Vault;
  files: string[];
  commit: string | null;
}

/**
 * `cubicle init <path>`: copy the vault template, record every scaffolded file as written by `init`,
 * write .env.example, git init, initial commit. Refuses to overwrite an existing vault.
 */
export async function scaffoldVault(target: string, opts: { force?: boolean; memoryDb?: boolean } = {}): Promise<ScaffoldResult> {
  const abs = path.resolve(target);
  if (Vault.isVault(abs) && !opts.force) throw new Error(`A cubicle vault already exists at ${abs} (use --force to re-scaffold missing files only)`);
  mkdirSync(abs, { recursive: true });
  const tpl = templateDir();
  if (!existsSync(tpl)) throw new Error(`Vault template missing at ${tpl}`);
  const files = await listFilesRecursive(tpl);
  for (const rel of files) {
    const dst = path.join(abs, rel);
    if (existsSync(dst) && opts.force) continue; // never clobber owner files on --force
    mkdirSync(path.dirname(dst), { recursive: true });
    cpSync(path.join(tpl, rel), dst);
  }
  const generated: string[] = [];
  if (!existsSync(path.join(abs, '.env.example'))) {
    atomicWriteSync(path.join(abs, '.env.example'), ENV_EXAMPLE);
    generated.push('.env.example');
  }
  const logo = path.join(abs, BRAND_LOGO);
  if (!existsSync(logo)) {
    const paletteFile = path.join(abs, 'Brand', 'palette.md');
    atomicWriteSync(logo, placeholderLogo(existsSync(paletteFile) ? readFileSync(paletteFile, 'utf8') : null));
    generated.push(BRAND_LOGO);
  }

  const vault = Vault.open(abs, { memory: opts.memoryDb });
  for (const rel of [...files, ...generated]) {
    const p = path.join(abs, rel);
    if (!existsSync(p) || statSync(p).isDirectory()) continue;
    const buf = readFileSync(p);
    const sha = sha256(buf);
    vault.recordWritten(rel, sha, 'init', /\.md$/.test(rel) ? buf.toString('utf8') : undefined);
    vault.events.emit({ type: 'vault.wrote', agent: 'init', payload: { path: rel, sha, by: 'init' } });
  }
  // `Office/campus.md`: the office as shipped. No node overrides — day one looks exactly as the campus was
  // generated — and the wiring the org already implies, so the owner opens the note and sees what they can cut.
  const org = loadOrg(vault);
  writeLayout(vault, migrationLayout(loadCampusMap(), org), 'init', org);
  const commit = await autoCommit(abs, 'cubicle: init vault');
  return { vault, files: [...files, ...generated, OFFICE_LAYOUT_PATH], commit };
}

export { atomicWriteSync };
