import type { RawEvent } from './events.ts';
import type { CallOptions, Engine } from './server.ts';

// For journeys and unit tests: an opencode that lives in this process and answers the same paths the real one does.
// One prompt takes a step, edits `src/example.ts`, asks before `bash pnpm test` when the brief mentions a test,
// says what it did, reports a one-file diff and goes idle. Nothing here reads the network.
type Session = { id: string; directory: string; created: number; busy: boolean; messages: { id: string; role: 'user' | 'assistant'; text: string }[]; run?: AbortController; reverted?: string };
const PATCH = '--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,3 +1,12 @@\n-export const ok = false;\n+export const ok = true;\n';

export function fakeEngine({ step = 120, now = Date.now }: { step?: number; now?: () => number } = {}): Engine & { sessions: Map<string, Session> } {
  const hearers = new Set<(event: RawEvent) => void>();
  const sessions = new Map<string, Session>();
  const waiting = new Map<string, { session: string; answer: (reply: string) => void }>();
  const counts = new Map<string, number>();
  const id = (prefix: string) => { counts.set(prefix, (counts.get(prefix) ?? 0) + 1); return `${prefix}_fake${counts.get(prefix)!.toString().padStart(4, '0')}`; };
  const tell = (type: string, properties: Record<string, unknown>, directory?: string) => { for (const hear of [...hearers]) hear({ directory, type, properties }); };
  const pause = (signal: AbortSignal) => new Promise<void>((done, fail) => {
    const timer = setTimeout(done, step);
    signal.addEventListener('abort', () => { clearTimeout(timer); fail(new Error('aborted')); }, { once: true });
  });

  async function work(session: Session, text: string) {
    const run = new AbortController();
    session.run = run;
    session.busy = true;
    const sessionID = session.id;
    const part = (part: Record<string, unknown>) => tell('message.part.updated', { sessionID, part: { sessionID, id: id('prt'), ...part } }, session.directory);
    try {
      tell('session.status', { sessionID, status: { type: 'busy' } }, session.directory);
      await pause(run.signal);
      part({ type: 'step-start' });
      await pause(run.signal);
      part({ type: 'tool', tool: 'edit', state: { status: 'completed', input: { filePath: `${session.directory}/src/example.ts` }, title: 'src/example.ts' } });
      if (/test/i.test(text)) {
        const permission = id('per');
        const reply = await new Promise<string>((answer) => {
          waiting.set(permission, { session: sessionID, answer });
          run.signal.addEventListener('abort', () => answer('reject'), { once: true });
          tell('permission.asked', { id: permission, sessionID, permission: 'bash', patterns: ['pnpm test'], metadata: { command: 'pnpm test' }, always: ['pnpm *'], tool: { messageID: 'msg', callID: 'call' } }, session.directory);
        });
        waiting.delete(permission);
        tell('permission.replied', { sessionID, requestID: permission, reply }, session.directory);
        if (run.signal.aborted) throw new Error('aborted');
        await pause(run.signal);
        if (reply === 'reject') part({ type: 'tool', tool: 'bash', state: { status: 'error', input: { command: 'pnpm test' }, error: 'the founder said no' } });
        else part({ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'pnpm test' }, output: '12 passed' } });
      }
      await pause(run.signal);
      const said = `Did: ${text.replace(/\s+/g, ' ').slice(0, 120)}`;
      session.messages.push({ id: id('msg'), role: 'assistant', text: said });
      part({ type: 'text', text: said, time: { start: now(), end: now() } });
      tell('session.diff', { sessionID, diff: [{ file: 'src/example.ts', additions: 12, deletions: 3 }] }, session.directory);
    } catch { /* aborted: the abort below says idle */ }
    session.busy = false;
    session.run = undefined;
    tell('session.status', { sessionID, status: { type: 'idle' } }, session.directory);
    tell('session.idle', { sessionID }, session.directory);
  }

  const known = (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) throw new Error('opencode answered 404: no such session');
    return session;
  };

  return {
    sessions,
    async call(method: string, path: string, { directory = '', body }: CallOptions = {}): Promise<any> {
      const [, first, sessionId, action] = /^\/(\w+)(?:\/([\w-]+))?(?:\/([\w_-]+))?/.exec(path.split('?')[0]) ?? [];
      const asked = (body ?? {}) as Record<string, any>;
      if (method === 'POST' && path.startsWith('/session') && !sessionId) {
        const session: Session = { id: id('ses'), directory, created: now(), busy: false, messages: [] };
        sessions.set(session.id, session);
        return { id: session.id, directory, time: { created: session.created, updated: session.created } };
      }
      if (method === 'GET' && path.startsWith('/session/status')) return Object.fromEntries([...sessions.values()].filter((one) => one.busy && (!directory || one.directory === directory)).map((one) => [one.id, { type: 'busy' }]));
      if (method === 'GET' && path.startsWith('/experimental/session')) return [...sessions.values()].map((one) => ({ id: one.id, directory: one.directory, time: { created: one.created, updated: one.created } }));
      if (first === 'session' && sessionId) {
        const session = known(sessionId);
        if (method === 'POST' && action === 'prompt_async') {
          const text = String(asked.parts?.[0]?.text ?? '');
          if (session.reverted) { session.messages = session.messages.slice(0, session.messages.findIndex((one) => one.id === session.reverted)); session.reverted = undefined; }
          session.messages.push({ id: id('msg'), role: 'user', text });
          void work(session, text);
          return null;
        }
        if (method === 'POST' && action === 'abort') { session.run?.abort(); return true; }
        if (method === 'POST' && action === 'revert') { session.reverted = String(asked.messageID); return { id: session.id, revert: { messageID: session.reverted } }; }
        if (method === 'GET' && action === 'diff') return session.messages.length && !session.reverted ? [{ file: 'src/example.ts', patch: PATCH, additions: 12, deletions: 3, status: 'modified' }] : [];
        if (method === 'GET' && action === 'message') return session.messages.map((one) => ({ info: { id: one.id, role: one.role }, parts: [{ type: 'text', text: one.text }] }));
        if (method === 'GET' && !action) return { id: session.id, directory: session.directory, time: { created: session.created }, ...(session.reverted ? { revert: { messageID: session.reverted } } : {}) };
        if (method === 'DELETE' && !action) { sessions.delete(sessionId); return true; }
      }
      if (method === 'POST' && first === 'permission' && action === 'reply') {
        const held = waiting.get(sessionId);
        if (!held) throw new Error('opencode answered 404: no such permission');
        held.answer(String(asked.reply));
        return true;
      }
      if (method === 'GET' && path.startsWith('/permission')) return [];
      if (method === 'POST' && path.startsWith('/instance/dispose')) return true;
      if (method === 'GET' && path.startsWith('/vcs/diff')) return [];
      if (method === 'GET' && path.startsWith('/config/providers')) {
        return { default: { opencode: 'fake-free' }, providers: [
          { id: 'opencode', name: 'OpenCode Zen', models: { 'fake-free': { id: 'fake-free', name: 'Fake Free', cost: { input: 0, output: 0 } }, 'fake-paid': { id: 'fake-paid', name: 'Fake Paid', cost: { input: 1, output: 2 } }, 'other-free': { id: 'other-free', name: 'Other Free', cost: { input: 0, output: 0 } } } },
          { id: 'ollama', name: 'Ollama', models: { 'qwen2.5-coder:7b': { id: 'qwen2.5-coder:7b', name: 'qwen2.5-coder:7b' }, whisper: { id: 'whisper', name: 'Whisper', capabilities: { toolcall: false } } } },
        ] };
      }
      throw new Error(`opencode answered 404: the fake has no ${method} ${path}`);
    },
    listen(hear) { hearers.add(hear); return () => { hearers.delete(hear); }; },
    health: () => ({ running: true, pid: process.pid, port: 0 }),
    async restart() {},
    async stop() { for (const session of sessions.values()) session.run?.abort(); },
  };
}
