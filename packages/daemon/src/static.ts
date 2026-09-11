import http from 'node:http';
import { existsSync, readFileSync, statSync, realpathSync } from 'node:fs';
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
  constructor(private opts: { port: number; vaultRoot: string; dist?: string; log?: (m: string) => void; token?: string }) {}

  async start(): Promise<number | null> {
    const dist = this.opts.dist ?? viewerDist();
    const hasDist = existsSync(path.join(dist, 'index.html'));
    const server = http.createServer((req, res) => {
      try {
        // DNS-rebinding guard: only loopback Host headers are served.
        const host = String(req.headers.host ?? '');
        if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) { res.writeHead(421); res.end('misdirected'); return; }
        const url = new URL(req.url ?? '/', 'http://localhost');
        const gated = url.pathname.startsWith('/screens/') || url.pathname.startsWith('/site/');
        if (gated && this.opts.token) {
          const cookie = (req.headers.cookie ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith('cubicle_token='))?.slice('cubicle_token='.length);
          const t = url.searchParams.get('token') ?? cookie ?? '';
          if (t !== this.opts.token) { res.writeHead(403); res.end('token required'); return; }
        }
        let file: string | null = null;
        let base: string;
        if (url.pathname.startsWith('/screens/')) { base = path.join(this.opts.vaultRoot, '.cubicle', 'screens'); file = safeJoin(base, url.pathname.slice('/screens/'.length)); }
        else if (url.pathname.startsWith('/site/')) { base = path.join(this.opts.vaultRoot, 'Site', 'dist'); file = safeJoin(base, url.pathname.slice('/site/'.length) || 'index.html'); }
        else { base = dist; file = hasDist ? safeJoin(dist, url.pathname === '/' ? 'index.html' : url.pathname.slice(1)) : null; }
        if (!file) { res.writeHead(404); res.end(hasDist ? 'not found' : 'viewer not built: pnpm --filter @cubicle/viewer build'); return; }
        if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
        if (!existsSync(file)) { if (hasDist && !gated) file = path.join(dist, 'index.html'); else { res.writeHead(404); res.end('not found'); return; } }
        // Symlink guard: the real file must live under its base (a sandbox could plant a link inside Site/dist).
        const real = realpathSync(file); const realBase = realpathSync(base);
        if (!(real === realBase || real.startsWith(realBase + path.sep))) { res.writeHead(403); res.end('forbidden'); return; }
        const headers: Record<string, string> = { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
        if (url.pathname.startsWith('/site/')) headers['content-security-policy'] = "default-src 'self' 'unsafe-inline' data: blob:; connect-src 'none'; frame-ancestors 'self'";
        if (!gated && url.pathname === '/' && this.opts.token && url.searchParams.get('token') === this.opts.token) headers['set-cookie'] = `cubicle_token=${this.opts.token}; Path=/; SameSite=Strict; HttpOnly`;
        res.writeHead(200, headers);
        res.end(readFileSync(real));
      } catch (err) { res.writeHead(500); res.end(String((err as Error).message)); }
    });
    this.server = server;
    try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.opts.port, '127.0.0.1', () => resolve()); }); }
    catch (err) { this.opts.log?.(`static server failed: ${(err as Error).message}`); this.server = null; return null; }
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : this.opts.port; // port 0 binds an ephemeral port; report the real one
    this.opts.log?.(`viewer at http://127.0.0.1:${port}/${hasDist ? '' : ' (dist missing — run pnpm --filter @cubicle/viewer build)'}`);
    return port;
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
