import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from '@cubicle/core';

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.map': 'application/json', '.woff2': 'font/woff2' };

export function viewerDist(): string {
  return path.join(repoRoot(), 'packages', 'viewer', 'dist');
}

/**
 * Serves the built viewer (packages/viewer/dist) and, under /screens/, the vault's screencast frames and site preview
 * (`/site/` → Site/dist). Localhost only; the WS token still gates data.
 */
export class StaticServer {
  private server: http.Server | null = null;
  constructor(private opts: { port: number; vaultRoot: string; dist?: string; log?: (m: string) => void }) {}

  async start(): Promise<number | null> {
    const dist = this.opts.dist ?? viewerDist();
    const hasDist = existsSync(path.join(dist, 'index.html'));
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        let file: string | null = null;
        if (url.pathname.startsWith('/screens/')) file = safeJoin(path.join(this.opts.vaultRoot, '.cubicle', 'screens'), url.pathname.slice('/screens/'.length));
        else if (url.pathname.startsWith('/site/')) file = safeJoin(path.join(this.opts.vaultRoot, 'Site', 'dist'), url.pathname.slice('/site/'.length) || 'index.html');
        else if (hasDist) file = safeJoin(dist, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
        if (!file) { res.writeHead(404); res.end(hasDist ? 'not found' : 'viewer not built: pnpm --filter @cubicle/viewer build'); return; }
        if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
        if (!existsSync(file)) { if (hasDist && !url.pathname.startsWith('/screens/') && !url.pathname.startsWith('/site/')) file = path.join(dist, 'index.html'); else { res.writeHead(404); res.end('not found'); return; } }
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end(readFileSync(file));
      } catch (err) { res.writeHead(500); res.end(String((err as Error).message)); }
    });
    this.server = server;
    try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.opts.port, '127.0.0.1', () => resolve()); }); }
    catch (err) { this.opts.log?.(`static server failed: ${(err as Error).message}`); this.server = null; return null; }
    this.opts.log?.(`viewer at http://127.0.0.1:${this.opts.port}/${hasDist ? '' : ' (dist missing — run pnpm --filter @cubicle/viewer build)'}`);
    return this.opts.port;
  }

  async stop(): Promise<void> {
    const s = this.server; this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }
}

function safeJoin(base: string, rel: string): string | null {
  const p = path.resolve(base, rel.replace(/^\/+/, ''));
  return p.startsWith(base + path.sep) || p === base ? p : null;
}
