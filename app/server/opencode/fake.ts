import type { RawEvent } from './events.ts';
import type { CallOptions, Engine } from './server.ts';

// For journeys and unit tests: an opencode that lives in this process and answers the same paths the real one does.
// One prompt takes a step, edits `src/example.ts`, asks before `bash pnpm test` when the brief mentions a test,
// says what it did, reports a one-file diff and goes idle. A brief that says "both" makes it ask before the edit and
// the command at once, `gap` apart, the way a real model asks when it calls two tools in one step. A model named in
// `down` (its id without the provider) answers the way a Zen model with a dead endpoint does: opencode retries it with
// the provider's message a few times, then gives up with a session error. A brief that mentions python runs it too,
// and the diff then also holds what that leaves behind: bytecode, a binary and a file under build/, which a folder's
// .gitignore usually names. Nothing here reads the network.
type Session = { id: string; directory: string; created: number; busy: boolean; messages: { id: string; role: 'user' | 'assistant'; text: string }[]; run?: AbortController; reverted?: string };
const PATCH = '--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,3 +1,12 @@\n-export const ok = false;\n+export const ok = true;\n';
const LEFT_BEHIND = [
  { file: 'src/__pycache__/example.cpython-312.pyc', patch: '', additions: 9, deletions: 0, status: 'added' },
  { file: 'logo.png', patch: 'Binary files /dev/null and b/logo.png differ\n', additions: 0, deletions: 0, status: 'added' },
  { file: 'build/out.txt', patch: '+built\n', additions: 1, deletions: 0, status: 'added' },
];
const ran = (session: Session) => session.messages.some((one) => one.role === 'user' && /python/i.test(one.text));

export const DOWN_MESSAGE = 'Error from provider (Console): Upstream request failed: Endpoint is unavailable.';
export function fakeEngine({ step = 120, gap = 0, now = Date.now, down = [] }: { step?: number; gap?: number; now?: () => number; down?: string[] } = {}): Engine & { sessions: Map<string, Session>; mcp: Map<string, Map<string, unknown>> } {
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

  async function work(session: Session, text: string, model = '') {
    const run = new AbortController();
    session.run = run;
    session.busy = true;
    const sessionID = session.id;
    if (down.includes(model)) {
      tell('session.status', { sessionID, status: { type: 'busy' } }, session.directory);
      try {
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          await pause(run.signal);
          tell('session.status', { sessionID, status: { type: 'retry', attempt, message: DOWN_MESSAGE, next: now() + step } }, session.directory);
        }
        await pause(run.signal);
        tell('session.error', { sessionID, error: { name: 'APIError', data: { message: DOWN_MESSAGE, statusCode: 400, isRetryable: false } } }, session.directory);
      } catch { /* aborted */ }
      session.busy = false;
      session.run = undefined;
      tell('session.status', { sessionID, status: { type: 'idle' } }, session.directory);
      tell('session.idle', { sessionID }, session.directory);
      return;
    }
    const messageID = id('msg');
    const part = (part: Record<string, unknown>) => tell('message.part.updated', { sessionID, part: { sessionID, messageID, id: id('prt'), ...part } }, session.directory);
    // A part the way the real one says it as it grows: announced, then word by word, then whole with its end time.
    const grown = (partID: string, type: string, pieces: string[]) => {
      const start = now();
      tell('message.part.updated', { sessionID, part: { sessionID, messageID, id: partID, type, text: '', time: { start } } }, session.directory);
      for (const delta of pieces) tell('message.part.delta', { sessionID, messageID, partID, field: 'text', delta }, session.directory);
      tell('message.part.updated', { sessionID, part: { sessionID, messageID, id: partID, type, text: pieces.join(''), time: { start, end: now() } } }, session.directory);
    };
    // A tool as the real one says it: running first (and asked about, when it asks), then finished.
    const tool = (name: string, input: Record<string, unknown>) => {
      const partID = id('prt');
      const start = now();
      const say = (state: Record<string, unknown>) => tell('message.part.updated', { sessionID, part: { sessionID, messageID, id: partID, type: 'tool', tool: name, callID: partID, state: { input, ...state } } }, session.directory);
      say({ status: 'running', time: { start } });
      return {
        done: (extra: Record<string, unknown> = {}) => say({ status: 'completed', time: { start, end: now() }, ...extra }),
        failed: (error: string) => say({ status: 'error', error, time: { start, end: now() } }),
      };
    };
    const usage = (tokens: { input: number; output: number; reasoning: number }) => tell('message.updated', { info: { id: messageID, sessionID, role: 'assistant', tokens: { ...tokens, cache: { read: 0, write: 0 } }, cost: 0, modelID: 'fake-free', providerID: 'opencode', time: { created: now() } } }, session.directory);
    try {
      tell('session.status', { sessionID, status: { type: 'busy' } }, session.directory);
      await pause(run.signal);
      part({ type: 'step-start' });
      usage({ input: 1200, output: 0, reasoning: 0 });
      grown(id('prt'), 'reasoning', ['Looking at the file']);
      await pause(run.signal);
      // One question, answered by the founder; the reply comes back on the stream the way opencode says it.
      const ask = (permission: string, rest: Record<string, unknown>) => new Promise<string>((answer) => {
        waiting.set(permission, { session: sessionID, answer: (reply) => { waiting.delete(permission); tell('permission.replied', { sessionID, requestID: permission, reply }, session.directory); answer(reply); } });
        run.signal.addEventListener('abort', () => answer('reject'), { once: true });
        tell('permission.asked', { id: permission, sessionID, tool: { messageID: 'msg', callID: permission }, ...rest }, session.directory);
      });
      const edit = { permission: 'edit', patterns: ['src/example.ts'], metadata: {}, always: ['*'] };
      const bash = { permission: 'bash', patterns: ['pnpm test'], metadata: { command: 'pnpm test' }, always: ['pnpm *'] };
      const editing = () => tool('edit', { filePath: `${session.directory}/src/example.ts` });
      const testing = () => tool('bash', { command: 'pnpm test' });
      if (/\bboth\b/i.test(text)) {
        const editTool = editing();
        const first = ask(id('per'), edit);
        await new Promise((settle) => setTimeout(settle, gap));
        const bashTool = testing();
        const [edited, ran] = await Promise.all([first, ask(id('per'), bash)]);
        if (run.signal.aborted) throw new Error('aborted');
        if (edited === 'reject') editTool.failed('the founder said no'); else editTool.done({ title: 'src/example.ts' });
        if (ran === 'reject') bashTool.failed('the founder said no'); else bashTool.done({ output: '12 passed' });
      } else editing().done({ title: 'src/example.ts' });
      if (/test/i.test(text) && !/\bboth\b/i.test(text)) {
        const bashTool = testing();
        const reply = await ask(id('per'), bash);
        if (run.signal.aborted) throw new Error('aborted');
        await pause(run.signal);
        if (reply === 'reject') bashTool.failed('the founder said no');
        else bashTool.done({ output: '12 passed' });
      }
      await pause(run.signal);
      const said = `Did: ${text.replace(/\s+/g, ' ').slice(0, 120)}`;
      session.messages.push({ id: messageID, role: 'assistant', text: said });
      const half = Math.ceil(said.length / 2);
      grown(id('prt'), 'text', [said.slice(0, half), said.slice(half)]);
      usage({ input: 1200, output: 80, reasoning: 20 });
      tell('session.diff', { sessionID, diff: [{ file: 'src/example.ts', additions: 12, deletions: 3 }, ...(ran(session) ? LEFT_BEHIND : [])] }, session.directory);
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

  const mcp = new Map<string, Map<string, unknown>>();
  return {
    sessions, mcp,
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
          void work(session, text, String(asked.model?.modelID ?? ''));
          return null;
        }
        if (method === 'POST' && action === 'abort') { session.run?.abort(); return true; }
        // The real one says the folder's diff once more after an undo, a moment later.
        if (method === 'POST' && action === 'revert') { session.reverted = String(asked.messageID); setTimeout(() => tell('session.diff', { sessionID: session.id, diff: [{ file: 'src/example.ts', additions: 12, deletions: 3 }] }, session.directory), 0); return { id: session.id, revert: { messageID: session.reverted } }; }
        if (method === 'GET' && action === 'diff') return session.messages.length && !session.reverted ? [{ file: 'src/example.ts', patch: PATCH, additions: 12, deletions: 3, status: 'modified' }, ...(ran(session) ? LEFT_BEHIND : [])] : [];
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
      if (method === 'POST' && path.startsWith('/instance/dispose')) { mcp.delete(directory); return true; }
      // Tool servers added to one folder's instance, the way the real one keeps them until the instance goes.
      if (method === 'GET' && path.startsWith('/mcp')) return Object.fromEntries([...(mcp.get(directory) ?? new Map())].map(([name]) => [name, { status: 'connected' }]));
      if (method === 'POST' && path.startsWith('/mcp')) {
        const held = mcp.get(directory) ?? new Map<string, unknown>();
        held.set(String(asked.name), asked.config);
        mcp.set(directory, held);
        return { [String(asked.name)]: { status: 'connected' } };
      }
      if (method === 'GET' && path.startsWith('/vcs/diff')) return [];
      if (method === 'GET' && path.startsWith('/config/providers')) {
        return { default: { opencode: 'fake-free' }, providers: [
          { id: 'opencode', name: 'OpenCode Zen', models: { 'fake-free': { id: 'fake-free', name: 'Fake Free', cost: { input: 0, output: 0 } }, 'fake-paid': { id: 'fake-paid', name: 'Fake Paid', cost: { input: 1, output: 2 } }, 'other-free': { id: 'other-free', name: 'Other Free', cost: { input: 0, output: 0 } } } },
          // Keyed models, among them the kinds a coder has no use for: research agents, speech, pictures, guards.
          { id: 'google', name: 'Google', models: Object.fromEntries([['gemini-3-flash', 'Gemini 3 Flash'], ['deep-research-max-preview', 'Deep Research Max Preview'], ['gemini-2.5-flash-preview-tts', 'Gemini TTS'], ['gemini-embedding-001', 'Gemini Embedding'], ['gemini-3-pro-image-preview', 'Nano Banana'], ['veo-3', 'Veo 3'], ['imagen-4', 'Imagen 4']].map(([id, name]) => [id, { id, name }])) },
          { id: 'groq', name: 'Groq', models: Object.fromEntries([['llama-3.3-70b-versatile', 'Llama 3.3 70B'], ['openai/gpt-oss-safeguard-20b', 'Safeguard'], ['meta-llama/llama-guard-4-12b', 'Llama Guard 4'], ['whisper-large-v3', 'Whisper'], ['text-moderation', 'Moderation'], ['playai-audio', 'Audio']].map(([id, name]) => [id, { id, name }])) },
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
