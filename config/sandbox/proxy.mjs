// cubicle-proxy: allow-list egress proxy that runs as a sidecar container. Sandboxes sit on an *internal*
// Docker network and can only reach this container, so the allow-list is enforced, not advisory.
// Usage: node proxy.mjs --port 3128 --allow registry.npmjs.org,github.com,*.githubusercontent.com
import http from 'node:http';
import net from 'node:net';
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1] || 3128);
const allow = (args[args.indexOf('--allow') + 1] || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const ok = (host) => { const h = String(host).toLowerCase().replace(/:\d+$/, ''); return allow.some((p) => (p.startsWith('*.') ? h === p.slice(2) || h.endsWith(p.slice(1)) : h === p)); };
const log = (m) => process.stdout.write(`${new Date().toISOString()} ${m}\n`);
const server = http.createServer((req, res) => {
  let t; try { t = new URL(req.url); } catch { res.writeHead(400); return res.end('bad request'); }
  if (!ok(t.hostname)) { log(`DENY ${t.hostname}`); res.writeHead(403); return res.end(`egress to ${t.hostname} is not on the allow-list`); }
  const up = http.request({ host: t.hostname, port: t.port || 80, path: t.pathname + t.search, method: req.method, headers: req.headers }, (u) => { res.writeHead(u.statusCode || 502, u.headers); u.pipe(res); });
  up.on('error', () => { res.writeHead(502); res.end('upstream error'); });
  req.pipe(up);
});
server.on('connect', (req, socket, head) => {
  const [host, p] = String(req.url).split(':');
  if (!ok(host)) { log(`DENY ${host}`); socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
  const conn = net.connect(Number(p || 443), host, () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) conn.write(head); socket.pipe(conn); conn.pipe(socket); });
  conn.on('error', () => socket.destroy()); socket.on('error', () => conn.destroy());
});
server.listen(port, '0.0.0.0', () => log(`allowlist proxy on :${port} (${allow.join(', ')})`));
process.on('SIGTERM', () => process.exit(0));
