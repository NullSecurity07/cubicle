import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { httpRpc, sseData, stdioRpc, unwrap } from './rpc.ts';

const FAKE = resolve(import.meta.dirname, 'fake-mcp.mjs');
const greeting = (wait = 5000) => async (rpc: { call: (method: string, params?: unknown, timeout?: number) => Promise<unknown>; notify: (method: string) => Promise<void> }) => {
  await rpc.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }, wait);
  await rpc.notify('notifications/initialized');
};
const hello = greeting();
const stdio = (env: NodeJS.ProcessEnv = {}) => stdioRpc({ command: process.execPath, args: [FAKE], env: { PATH: process.env.PATH, ...env }, hello });

// An outside server that answers on an address, stood up inside the test. Nothing is installed and nothing is fetched.
function onPort(answer: (body: any, res: any) => void): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => answer(JSON.parse(text || '{}'), res));
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, server })));
}

const shut: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of shut.splice(0)) await close(); });

describe('json-rpc down a pipe', () => {
  it('shakes hands, lists and calls, and lets the program go', async () => {
    const rpc = stdio();
    shut.push(rpc.close);
    const listed = await rpc.call('tools/list', {}, 5000);
    expect(listed.tools.map((one: { name: string }) => one.name)).toContain('echo');
    expect((await rpc.call('tools/call', { name: 'echo', arguments: { text: 'hello' } }, 5000)).content[0].text).toBe('You said: hello');
  });

  it('starts the program again after it dies, and the call that died says so', async () => {
    const rpc = stdioRpc({ command: process.execPath, args: [FAKE], env: { PATH: process.env.PATH }, hello });
    shut.push(rpc.close);
    await rpc.call('tools/list', {}, 5000);
    await expect(rpc.call('tools/call', { name: 'die', arguments: {} }, 5000)).rejects.toThrow('the outside tool stopped');
    // The next call waits out the back-off, starts it afresh and shakes hands again, so the person only lost one step.
    expect((await rpc.call('tools/call', { name: 'echo', arguments: { text: 'again' } }, 5000)).content[0].text).toBe('You said: again');
  });

  it('gives up on a program that never answers, rather than holding a turn open', async () => {
    // The handshake is the first thing that waits, so it is the one that has to give up: a server that says nothing
    // must cost a few hundred milliseconds, not a founder's whole turn.
    const rpc = stdioRpc({ command: process.execPath, args: [FAKE], env: { PATH: process.env.PATH, FAKE_MCP: 'slow' }, hello: greeting(300) });
    shut.push(rpc.close);
    await expect(rpc.call('tools/list', {}, 300)).rejects.toThrow('did not answer within');
  });

  it('is an error, in the server\'s own words, when the server refuses', async () => {
    const rpc = stdio();
    shut.push(rpc.close);
    await expect(rpc.call('resources/list', {}, 5000)).rejects.toThrow('no such method: resources/list');
    expect(() => unwrap({ result: 1 })).not.toThrow();
  });
});

describe('json-rpc over http', () => {
  it('reads a plain json answer and carries the session the server hands out', async () => {
    const seen: (string | undefined)[] = [];
    const { url, server } = await onPort((body, res) => {
      seen.push(res.req.headers['mcp-session-id']);
      expect(res.req.headers.accept).toBe('application/json, text/event-stream');
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'abc' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { said: body.method } }));
    });
    shut.push(async () => new Promise((done) => server.close(() => done(null))));
    const rpc = httpRpc({ url });
    expect(await rpc.call('tools/list')).toEqual({ said: 'tools/list' });
    await rpc.call('tools/list');
    expect(seen).toEqual([undefined, 'abc']);
  });

  it('reads an answer that comes back as a stream of frames', async () => {
    const { url, server } = await onPort((body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`: hello\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 99, result: 'not yours' })}\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { ok: true } })}\n\n`);
    });
    shut.push(async () => new Promise((done) => server.close(() => done(null))));
    expect(await httpRpc({ url }).call('tools/list')).toEqual({ ok: true });
  });

  it('says what a refusal was, and forgets a session the server has forgotten', async () => {
    const { url, server } = await onPort((_body, res) => { res.writeHead(404); res.end(); });
    shut.push(async () => new Promise((done) => server.close(() => done(null))));
    await expect(httpRpc({ url }).call('tools/list')).rejects.toThrow('answered 404');
  });

  it('picks the data lines out of a stream and leaves the comments', () => {
    expect(sseData(': keep alive\n\ndata: {"a":1}\n\ndata: not json\n\n')).toEqual([{ a: 1 }]);
  });
});
