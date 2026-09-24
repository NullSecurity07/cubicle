import { describe, expect, it } from 'vitest';
import { readStream, translate } from './events.ts';

const DIR = '/home/me/code/shop';
const part = (part: Record<string, unknown>) => ({ type: 'message.part.updated', properties: { sessionID: 'ses_1', part: { sessionID: 'ses_1', ...part } } });
const tool = (name: string, status: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) => part({ type: 'tool', tool: name, state: { status, input, ...extra } });

describe('what the coder does, as lines a founder reads', () => {
  it('says a finished step in the same words the old project log used, with paths made short', () => {
    expect(translate(tool('bash', 'completed', { command: 'pnpm   test\n --run' }), DIR)).toMatchObject({ session: 'ses_1', progress: true, line: { kind: 'tool', text: 'bash pnpm test --run' } });
    expect(translate(tool('edit', 'completed', { filePath: `${DIR}/src/x.ts` }, { title: `${DIR}/src/x.ts` }), DIR)).toMatchObject({ line: { kind: 'tool', text: 'edit src/x.ts', file: 'src/x.ts' } });
    expect(translate(tool('write', 'completed', { filePath: `${DIR}/README.md` }), DIR)?.line).toMatchObject({ text: 'write README.md', file: 'README.md' });
    expect(translate(tool('glob', 'completed', { pattern: '**/*.md' }), DIR)?.line?.text).toBe('glob **/*.md');
    // Still running: the coder is alive, and nothing is said yet.
    const running = translate(tool('bash', 'running', { command: 'ls' }), DIR);
    expect(running).toMatchObject({ progress: true });
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

describe('the event stream', () => {
  it('reads whole lines out of chunks, unwraps the global envelope and skips what is not news', () => {
    const heard: unknown[] = [];
    const read = readStream((event) => heard.push(event));
    read('data: {"directory":"/a","payload":{"type":"session.idle","prop');
    read('erties":{"sessionID":"ses_1"}}}\n\n: comment\n');
    read('data: not json\n\ndata: {"payload":{"type":"server.connected","properties":{}}}\n\n');
    expect(heard).toEqual([{ directory: '/a', type: 'session.idle', properties: { sessionID: 'ses_1' } }, { directory: undefined, type: 'server.connected', properties: {} }]);
  });
});
