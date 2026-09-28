import { diffLine, type CoderAsk, type CoderLine, type CoderLiveTool } from '../../shared/coder.ts';

// What OpenCode says on its event stream, as the few things the card cares about. Everything else it says (sync
// records, plugin news, heartbeats) is left where it is.
export type RawEvent = { directory?: string; type: string; properties: Record<string, any> };
export type Heard = {
  session: string;
  // Any sign of life: a part moved, a token arrived. The watchdog counts from the last one.
  progress?: true; busy?: true; idle?: true;
  // The folder changed under this step (opencode's patch part), whichever tool changed it.
  changed?: true;
  line?: CoderLine; permission?: CoderAsk; replied?: string; reply?: string; error?: string;
  // What the card shows live. A part of the reply or of the thinking is announced (`opened`), grows (`delta`) and ends
  // (`closed`); opencode sends a delta with only the part's id, so whoever listens remembers which kind each part is.
  opened?: { id: string; kind: 'reasoning' | 'text'; text?: string };
  delta?: { id: string; text: string };
  closed?: { id: string; kind: 'reasoning' | 'text' };
  // A step still running (`running`), or the id of one that just finished (`finished`, alongside its `line`).
  running?: CoderLiveTool; finished?: string;
  // A new step of the model's own (it read what the last tools said and goes again).
  step?: true;
  // What one answer of the model's has cost so far. Said several times per answer: the latest one counts.
  usage?: { message: string; tokens: { input: number; output: number; reasoning: number; cache: number }; cost: number };
};

// A path as the founder would say it inside their own folder.
const short = (value: string, dir: string) => (dir && value.startsWith(`${dir}/`) ? value.slice(dir.length + 1) : value);
const flat = (value: unknown, max: number) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
// A provider that answers with a JSON body is read for its message; the rest of the body is nobody's business.
const unwrap = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return text;
  try { const said = JSON.parse(trimmed); return String(said?.error?.message ?? said?.message ?? text); } catch { return text; }
};
// A provider's error in the founder's words: its account numbers, tiers and links are nobody's business on the card.
export const plainError = (text: string) => unwrap(text)
  .replace(/\s+in organization `[^`]*`/gi, '').replace(/\s+service tier `[^`]*`/gi, '')
  .replace(/[^.?!]*https?:\/\/\S+[^.?!]*[.?!]?/g, '').replace(/\s*Need more tokens\?/gi, '').replace(/\s+/g, ' ').trim();

// The end of what a command printed: the last lines are where a test run says how it went.
const tail = (value: unknown, max: number) => { const text = String(value ?? '').replace(/\s+$/, ''); return text.length > max ? text.slice(-max) : text; };
const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

// A step as the founder reads it: the tool, then the command, the title, the file or the pattern.
function toolWhat(part: Record<string, any>, dir: string) {
  const state = part.state ?? {};
  const input = state.input ?? {};
  const file = typeof input.filePath === 'string' ? short(input.filePath, dir) : undefined;
  const what = flat(short(String(input.command ?? file ?? state.title ?? input.pattern ?? ''), dir), 120);
  return { tool: String(part.tool ?? 'step'), what, file };
}

// A finished step in the words the old project log used, with the end of what it printed and how long it ran.
function toolLine(part: Record<string, any>, dir: string): CoderLine | undefined {
  const state = part.state ?? {};
  const { tool, what, file } = toolWhat(part, dir);
  const text = `${tool} ${what}`.trim();
  const took = typeof state.time?.start === 'number' && typeof state.time?.end === 'number' ? Math.max(0, state.time.end - state.time.start) : undefined;
  const timed = took === undefined ? {} : { took };
  if (state.status === 'completed') {
    const detail = tool === 'bash' ? tail(state.output ?? state.metadata?.output, 1500) : '';
    return { kind: 'tool', text, at: Date.now(), ...(file ? { file } : {}), ...(detail ? { detail } : {}), ...timed };
  }
  if (state.status === 'error') {
    const detail = tail(state.error, 1500);
    return { kind: 'error', text: `${text} failed: ${flat(state.error, 160)}`, at: Date.now(), ...(detail ? { detail } : {}), ...timed };
  }
  return undefined;
}

// A step still running, as the live view shows it; a command's output so far comes with it.
function toolRunning(part: Record<string, any>, dir: string): CoderLiveTool {
  const state = part.state ?? {};
  const { tool, what, file } = toolWhat(part, dir);
  const output = tool === 'bash' ? tail(state.metadata?.output, 600) : '';
  return { id: String(part.id ?? part.callID ?? ''), tool, what, ...(file ? { file } : {}), since: typeof state.time?.start === 'number' ? state.time.start : Date.now(), ...(output ? { output } : {}) };
}

export function translate(event: RawEvent, dir = ''): Heard | null {
  const { type, properties: said = {} } = event;
  const session: string | undefined = said.sessionID ?? said.part?.sessionID ?? said.info?.sessionID;
  if (!session) return null;
  if (type === 'message.part.delta') {
    const grew = said.partID && (said.field ?? 'text') === 'text' && typeof said.delta === 'string' ? { delta: { id: String(said.partID), text: said.delta } } : {};
    return { session, progress: true, ...grew };
  }
  if (type === 'message.part.updated') {
    const part = said.part ?? {};
    const id = part.id ? String(part.id) : '';
    if (part.type === 'tool') {
      const status = part.state?.status;
      if (status === 'pending' || status === 'running') return { session, progress: true, ...(id ? { running: toolRunning(part, dir) } : {}) };
      const line = toolLine(part, dir);
      return { session, progress: true, ...(line ? { line } : {}), ...(line && id ? { finished: id } : {}) };
    }
    if (part.type === 'text' || part.type === 'reasoning') {
      const kind: 'text' | 'reasoning' = part.type;
      const ended = !!part.time?.end;
      const marks = !id ? {} : ended ? { closed: { id, kind } } : { opened: { id, kind, ...(part.text ? { text: String(part.text) } : {}) } };
      const line: CoderLine | undefined = kind === 'text' && ended && String(part.text ?? '').trim() ? { kind: 'reply', text: String(part.text).trim().slice(0, 4000), at: Date.now() } : undefined;
      return { session, progress: true, ...marks, ...(line ? { line } : {}) };
    }
    if (part.type === 'step-start') return { session, progress: true, step: true };
    if (part.type === 'patch') return { session, progress: true, changed: true };
    return { session, progress: true };
  }
  if (type === 'message.updated') {
    const info = said.info ?? {};
    if (info.role !== 'assistant' || !info.id) return null;
    const tokens = info.tokens ?? {};
    return { session, progress: true, usage: { message: String(info.id), tokens: { input: number(tokens.input), output: number(tokens.output), reasoning: number(tokens.reasoning), cache: number(tokens.cache?.read) + number(tokens.cache?.write) }, cost: number(info.cost) } };
  }
  if (type === 'session.diff') return Array.isArray(said.diff) && said.diff.length ? { session, line: { kind: 'diff', text: diffLine(said.diff), at: Date.now() } } : null;
  if (type === 'permission.asked') {
    const what = flat(said.metadata?.command ?? short(String((said.patterns ?? [])[0] ?? ''), dir), 400);
    return { session, permission: { id: String(said.id), tool: String(said.permission ?? 'step'), what, always: Array.isArray(said.always) ? said.always.map(String) : [], at: Date.now() } };
  }
  if (type === 'permission.replied') return { session, replied: String(said.requestID ?? said.permissionID ?? ''), ...(said.reply ? { reply: String(said.reply) } : {}) };
  if (type === 'session.idle') return { session, idle: true };
  if (type === 'session.status') return said.status?.type === 'idle' ? { session, idle: true } : said.status?.type === 'busy' ? { session, busy: true } : null;
  if (type === 'session.error') {
    // Stopping the coder is said by whoever stopped it; opencode's own word for it is not news.
    if (said.error?.name === 'MessageAbortedError') return { session };
    const error = plainError(flat(said.error?.data?.message ?? said.error?.message ?? said.error?.name ?? 'the coder stopped with an error', 400)).slice(0, 300);
    return { session, error, line: { kind: 'error', text: error, at: Date.now() } };
  }
  return null;
}

// Server-sent events arrive in chunks that split lines anywhere. Each whole `data:` line is one event; the global
// stream wraps each in `{ directory, payload }`, which is unwrapped here so the rest never knows.
export function readStream(hear: (event: RawEvent) => void) {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      let parsed: any;
      try { parsed = JSON.parse(line.slice(5).trim()); } catch { continue; }
      const payload = parsed?.payload ?? parsed;
      if (typeof payload?.type !== 'string') continue;
      hear({ directory: parsed?.payload ? parsed.directory : undefined, type: payload.type, properties: payload.properties ?? {} });
    }
  };
}
