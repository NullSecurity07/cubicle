import { describe, expect, it } from 'vitest';
import { modelDown, plainError, readStream, translate } from './events.ts';

const DIR = '/home/me/code/shop';
const part = (part: Record<string, unknown>) => ({ type: 'message.part.updated', properties: { sessionID: 'ses_1', part: { sessionID: 'ses_1', ...part } } });
const tool = (name: string, status: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) => part({ type: 'tool', tool: name, state: { status, input, ...extra } });

describe('what the coder does, as lines a founder reads', () => {
  it('says a finished step in the same words the old project log used, with paths made short', () => {
    expect(translate(tool('bash', 'completed', { command: 'pnpm   test\n --run' }), DIR)).toMatchObject({ session: 'ses_1', progress: true, line: { kind: 'tool', text: 'bash pnpm test --run' } });
    expect(translate(tool('edit', 'completed', { filePath: `${DIR}/src/x.ts` }, { title: `${DIR}/src/x.ts` }), DIR)).toMatchObject({ line: { kind: 'tool', text: 'edit src/x.ts', file: 'src/x.ts' } });
    expect(translate(tool('write', 'completed', { filePath: `${DIR}/README.md` }), DIR)?.line).toMatchObject({ text: 'write README.md', file: 'README.md' });
    expect(translate(tool('glob', 'completed', { pattern: '**/*.md' }), DIR)?.line?.text).toBe('glob **/*.md');
    // Still running: the coder is alive, the live view shows the step, and the log says nothing yet.
    const running = translate(part({ id: 'prt_1', type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'ls' }, time: { start: 5 } } }), DIR);
    expect(running).toMatchObject({ progress: true, running: { id: 'prt_1', tool: 'bash', what: 'ls', since: 5 } });
    expect(running?.line).toBeUndefined();
    expect(translate(tool('bash', 'error', { command: 'pnpm test' }, { error: 'exit 1' }), DIR)?.line).toMatchObject({ kind: 'error', text: 'bash pnpm test failed: exit 1' });
  });

  it('says a reply once it is finished, and nothing for thinking or for a reply still being written', () => {
    expect(translate(part({ type: 'text', text: '', time: { start: 1 } }), DIR)?.line).toBeUndefined();
    expect(translate(part({ type: 'text', text: 'Done. README has world.', time: { start: 1, end: 2 } }), DIR)?.line).toMatchObject({ kind: 'reply', text: 'Done. README has world.' });
    expect(translate(part({ type: 'reasoning', text: 'hmm' }), DIR)).toEqual({ session: 'ses_1', progress: true });
    // A patch part is opencode saying the folder changed under this step, whichever tool did it.
    expect(translate(part({ type: 'patch', files: [`${DIR}/README.md`] }), DIR)).toEqual({ session: 'ses_1', progress: true, changed: true });
    expect(translate({ type: 'message.part.delta', properties: { sessionID: 'ses_1', delta: 'x' } }, DIR)).toEqual({ session: 'ses_1', progress: true });
  });

  it('turns a diff into one line, and an empty one into nothing', () => {
    expect(translate({ type: 'session.diff', properties: { sessionID: 'ses_1', diff: [{ file: 'a.ts', additions: 10, deletions: 3 }, { file: 'b.ts', additions: 2, deletions: 0 }] } }, DIR)?.line).toMatchObject({ kind: 'diff', text: '+12 −3 in 2 files' });
    expect(translate({ type: 'session.diff', properties: { sessionID: 'ses_1', diff: [] } }, DIR)).toBeNull();
  });

  it('carries a question, its answer, the end of the work and an error', () => {
    const asked = translate({ type: 'permission.asked', properties: { id: 'per_1', sessionID: 'ses_1', permission: 'bash', patterns: ['ls -la'], metadata: { command: 'ls -la' }, always: ['ls *'] } }, DIR);
    expect(asked?.permission).toMatchObject({ id: 'per_1', tool: 'bash', what: 'ls -la', always: ['ls *'] });
    const edit = translate({ type: 'permission.asked', properties: { id: 'per_2', sessionID: 'ses_1', permission: 'edit', patterns: [`${DIR}/src/x.ts`], metadata: {}, always: ['*'] } }, DIR);
    expect(edit?.permission?.what).toBe('src/x.ts');
    expect(translate({ type: 'permission.replied', properties: { sessionID: 'ses_1', requestID: 'per_1', reply: 'once' } }, DIR)).toEqual({ session: 'ses_1', replied: 'per_1', reply: 'once' });
    expect(translate({ type: 'session.idle', properties: { sessionID: 'ses_1' } }, DIR)).toEqual({ session: 'ses_1', idle: true });
    expect(translate({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } }, DIR)).toEqual({ session: 'ses_1', idle: true });
    expect(translate({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } }, DIR)).toEqual({ session: 'ses_1', busy: true });
    expect(translate({ type: 'session.error', properties: { sessionID: 'ses_1', error: { name: 'APIError', data: { message: 'Rate limited' } } } }, DIR)).toMatchObject({ session: 'ses_1', error: 'Rate limited', line: { kind: 'error', text: 'Rate limited' } });
    expect(translate({ type: 'session.error', properties: { sessionID: 'ses_1', error: { name: 'MessageAbortedError', data: {} } } }, DIR)).toEqual({ session: 'ses_1' });
    expect(translate({ type: 'server.heartbeat', properties: {} }, DIR)).toBeNull();
    const groq = 'Request too large for model `openai/gpt-oss-120b` in organization `org_01m24v86` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 9500, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing';
    expect(translate({ type: 'session.error', properties: { sessionID: 'ses_1', error: { name: 'APIError', data: { message: groq } } } }, DIR)?.error)
      .toBe('Request too large for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Requested 9500, please reduce your message size and try again.');
    // A provider that answers with a JSON body: only its message is news.
    const json = '{"message":"Tool call validation failed: attempted to call tool \'search\' which was not in request.tools","type":"invalid_request_error"}';
    expect(translate({ type: 'session.error', properties: { sessionID: 'ses_1', error: { name: 'APIError', data: { message: json } } } }, DIR)?.error)
      .toBe("Tool call validation failed: attempted to call tool 'search' which was not in request.tools");
  });
});

describe('what the coder is doing right now', () => {
  const delta = (partID: string, text: string) => ({ type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_1', partID, field: 'text', delta: text } });

  it('announces a part of the thinking or the reply, grows it by deltas and closes it', () => {
    expect(translate(part({ id: 'prt_r', type: 'reasoning', text: '', time: { start: 1 } }), DIR)).toEqual({ session: 'ses_1', progress: true, opened: { id: 'prt_r', kind: 'reasoning' } });
    expect(translate(delta('prt_r', 'Looking'), DIR)).toEqual({ session: 'ses_1', progress: true, delta: { id: 'prt_r', text: 'Looking' } });
    expect(translate(part({ id: 'prt_r', type: 'reasoning', text: 'Looking', time: { start: 1, end: 2 } }), DIR)).toEqual({ session: 'ses_1', progress: true, closed: { id: 'prt_r', kind: 'reasoning' } });
    expect(translate(part({ id: 'prt_t', type: 'text', text: '', time: { start: 1 } }), DIR)).toEqual({ session: 'ses_1', progress: true, opened: { id: 'prt_t', kind: 'text' } });
    expect(translate(delta('prt_t', 'Done.'), DIR)?.delta).toEqual({ id: 'prt_t', text: 'Done.' });
    expect(translate(part({ id: 'prt_t', type: 'text', text: 'Done.', time: { start: 1, end: 2 } }), DIR)).toMatchObject({ closed: { id: 'prt_t', kind: 'text' }, line: { kind: 'reply', text: 'Done.' } });
    // A delta for some other field of a part is not text to show.
    expect(translate({ type: 'message.part.delta', properties: { sessionID: 'ses_1', partID: 'prt_t', field: 'metadata', delta: 'x' } }, DIR)).toEqual({ session: 'ses_1', progress: true });
  });

  it('shows a running command with the end of its output so far, and a finished one with its output and time', () => {
    const long = Array.from({ length: 400 }, (_, at) => `line ${at}`).join('\n');
    const running = translate(part({ id: 'prt_b', type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'pnpm test' }, metadata: { output: long }, time: { start: 10 } } }), DIR);
    expect(running?.running?.output).toHaveLength(600);
    expect(running?.running?.output?.endsWith('line 399')).toBe(true);
    // A tool announced before it has its input still shows, as itself.
    expect(translate(part({ id: 'prt_p', type: 'tool', tool: 'edit', state: { status: 'pending', input: {} } }), DIR)?.running).toMatchObject({ id: 'prt_p', tool: 'edit', what: '' });
    const done = translate(part({ id: 'prt_b', type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'pnpm test' }, output: `${long}\n`, time: { start: 10, end: 3210 } } }), DIR);
    expect(done).toMatchObject({ finished: 'prt_b', line: { kind: 'tool', text: 'bash pnpm test', took: 3200 } });
    expect(done?.line?.detail).toHaveLength(1500);
    expect(done?.line?.detail?.endsWith('line 399')).toBe(true);
    // An edit keeps its line as it was: no output to show.
    expect(translate(part({ id: 'prt_e', type: 'tool', tool: 'edit', state: { status: 'completed', input: { filePath: `${DIR}/a.ts` } } }), DIR)?.line).toEqual({ kind: 'tool', text: 'edit a.ts', file: 'a.ts', at: expect.any(Number) });
    const failed = translate(part({ id: 'prt_f', type: 'tool', tool: 'bash', state: { status: 'error', input: { command: 'make' }, error: 'exit 2: no rule', time: { start: 1, end: 401 } } }), DIR);
    expect(failed).toMatchObject({ finished: 'prt_f', line: { kind: 'error', text: 'bash make failed: exit 2: no rule', detail: 'exit 2: no rule', took: 400 } });
  });

  it('counts a new step, and reads what an answer cost from the assistant\'s message only', () => {
    expect(translate(part({ id: 'prt_s', type: 'step-start' }), DIR)).toEqual({ session: 'ses_1', progress: true, step: true });
    const info = (role: string) => ({ type: 'message.updated', properties: { info: { id: 'msg_2', sessionID: 'ses_1', role, tokens: { input: 1200, output: 80, reasoning: 20, cache: { read: 300, write: 5 } }, cost: 0.012, modelID: 'm', providerID: 'p', time: { created: 1 } } } });
    expect(translate(info('assistant'), DIR)).toEqual({ session: 'ses_1', progress: true, usage: { message: 'msg_2', tokens: { input: 1200, output: 80, reasoning: 20, cache: 305 }, cost: 0.012 } });
    expect(translate(info('user'), DIR)).toBeNull();
  });
});

describe('the event stream', () => {
  it('reads whole lines out of chunks, unwraps the global envelope and skips what is not news', () => {
    const heard: unknown[] = [];
    const read = readStream((event) => heard.push(event));
    read('data: {"directory":"/a","payload":{"type":"session.idle","prop');
    read('erties":{"sessionID":"ses_1"}}}\n\n: comment\n');
    read('data: not json\n\ndata: {"payload":{"type":"server.connected","properties":{}}}\n\n');
    expect(heard).toEqual([{ directory: '/a', type: 'session.idle', properties: { sessionID: 'ses_1' } }, { directory: undefined, type: 'server.connected', properties: {} }]);
  });

  it('hears opencode retrying a refused request, in the provider\'s reason without its wrapping', () => {
    const said = 'Error from provider (Console): Upstream request failed: Endpoint is unavailable.';
    expect(translate({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'retry', attempt: 1, message: said, next: 1 } } })).toEqual({ session: 'ses_1', retry: 'Endpoint is unavailable.' });
    expect(translate({ type: 'session.error', properties: { sessionID: 'ses_1', error: { name: 'APIError', data: { message: said } } } })?.error).toBe('Endpoint is unavailable.');
    expect(plainError(said)).not.toMatch(/Error from provider|Upstream/);
  });

  it('tells a model that is down from a key or a quota the founder has to see to', () => {
    for (const down of ['Endpoint is unavailable.', 'The model is overloaded. Try again later.', 'No endpoints found for nvidia/x.', '503 Service Unavailable']) expect(modelDown(down)).toBe(true);
    for (const theirs of ['Invalid API key', 'Rate limit reached for model', 'You exceeded your current quota', '429 Too Many Requests: service unavailable', 'Insufficient credits']) expect(modelDown(theirs)).toBe(false);
  });
});
