import { cpSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vault } from './vault.js';
import { autoCommit } from './git.js';
import { listFilesRecursive, sha256, atomicWriteSync } from './fs.js';
import { placeholderSquare } from './png.js';
import { parseNote } from './frontmatter.js';

/** Repo root, resolved from this file (works from src/ via tsx and from dist/). */
export function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..');
}

export function templateDir(): string {
  return path.join(repoRoot(), 'vault-template');
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
  const envExample = path.join(repoRoot(), '.env.example');
  if (existsSync(envExample) && !existsSync(path.join(abs, '.env.example'))) cpSync(envExample, path.join(abs, '.env.example'));
  const generated: string[] = [];
  const logo = path.join(abs, 'Brand', 'logo.png');
  if (!existsSync(logo)) {
    const paletteFile = path.join(abs, 'Brand', 'palette.md');
    const palette = (existsSync(paletteFile) ? parseNote(readFileSync(paletteFile, 'utf8')).data : {}) as { primary?: string; accent?: string };
    atomicWriteSync(logo, placeholderSquare(64, palette.primary ?? '#1f2937', palette.accent ?? '#f59e0b'));
    generated.push('Brand/logo.png');
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
  const commit = await autoCommit(abs, 'cubicle: init vault');
  return { vault, files: [...files, ...generated], commit };
}

export { atomicWriteSync };
