import http from 'node:http';
import net from 'node:net';
import { URL } from 'node:url';

/** Glob-ish host match: "*.githubusercontent.com" matches any subdomain; exact otherwise. */
export function hostAllowed(host: string, allow: string[]): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  return allow.some((p) => {
    const q = p.toLowerCase();
    if (q.startsWith('*.')) return h === q.slice(2) || h.endsWith(q.slice(1));
    return h === q;
  });
}

/**
 * Tiny egress allow-list proxy for the sandbox: HTTP forwarding + CONNECT tunnelling, refusing any host not
 * on the list. Advisory by design (a process can ignore proxy env vars); the default sandbox mode is no network.
 */
export class AllowlistProxy {
  private server: http.Server | null = null;
  readonly denied: string[] = [];

  constructor(private allow: string[], private log: (m: string) => void = () => undefined) {}

  async start(host = '127.0.0.1', port = 0): Promise<{ host: string; port: number }> {
    const server = http.createServer((req, res) => {
      let target: URL;
      try { target = new URL(req.url ?? ''); } catch { res.writeHead(400); res.end('bad request'); return; }
      if (!hostAllowed(target.hostname, this.allow) || (target.port && target.port !== '80')) { this.denied.push(target.hostname); res.writeHead(403); res.end(`egress to ${target.hostname}:${target.port || 80} is not allowed`); return; }
      const upstream = http.request({ host: target.hostname, port: target.port || 80, path: target.pathname + target.search, method: req.method, headers: req.headers }, (up) => { res.writeHead(up.statusCode ?? 502, up.headers); up.pipe(res); });
      upstream.on('error', () => { res.writeHead(502); res.end('upstream error'); });
      req.pipe(upstream);
    });
    server.on('connect', (req, socket, head) => {
      const [hostname, portStr] = (req.url ?? '').split(':');
      const port = Number(portStr || 443);
      if (!hostAllowed(hostname, this.allow) || port !== 443) { this.denied.push(hostname); socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
      const conn = net.connect(port, hostname, () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) conn.write(head); socket.pipe(conn); conn.pipe(socket); });
      conn.on('error', () => socket.destroy());
      socket.on('error', () => conn.destroy());
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve()); });
    const addr = server.address() as net.AddressInfo;
    this.log(`allowlist proxy on ${addr.address}:${addr.port} (${this.allow.join(', ')})`);
    return { host: addr.address, port: addr.port };
  }

  async stop(): Promise<void> {
    const s = this.server; this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }
}
