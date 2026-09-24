import { diffLine, type CoderAsk, type CoderLine } from '../../shared/coder.ts';

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
};

// A path as the founder would say it inside their own folder.
const short = (value: string, dir: string) => (dir && value.startsWith(`${dir}/`) ? value.slice(dir.length + 1) : value);
const flat = (value: unknown, max: number) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
// A provider's error in the founder's words: its account numbers, tiers and links are nobody's business on the card.
export const plainError = (text: string) => text
  .replace(/\s+in organization `[^`]*`/gi, '').replace(/\s+service tier `[^`]*`/gi, '')
  .replace(/[^.?!]*https?:\/\/\S+[^.?!]*[.?!]?/g, '').replace(/\s*Need more tokens\?/gi, '').replace(/\s+/g, ' ').trim();

// A finished step in the words the old project log used: the tool, then the command, the title, the file or the pattern.
function toolLine(part: Record<string, any>, dir: string): CoderLine | undefined {
  const state = part.state ?? {};
  const input = state.input ?? {};
  const file = typeof input.filePath === 'string' ? short(input.filePath, dir) : undefined;
  const what = flat(short(String(input.command ?? file ?? state.title ?? input.pattern ?? ''), dir), 120);
  const text = `${part.tool} ${what}`.trim();
  if (state.status === 'completed') return { kind: 'tool', text, at: Date.now(), ...(file ? { file } : {}) };
  if (state.status === 'error') return { kind: 'error', text: `${text} failed: ${flat(state.error, 160)}`, at: Date.now() };
  return undefined;
}

export function translate(event: RawEvent, dir = ''): Heard | null {
  const { type, properties: said = {} } = event;
  const session: string | undefined = said.sessionID ?? said.part?.sessionID ?? said.info?.sessionID;
  if (!session) return null;
  if (type === 'message.part.delta') return { session, progress: true };
  if (type === 'message.part.updated') {
    const part = said.part ?? {};
    if (part.type === 'tool') { const line = toolLine(part, dir); return { session, progress: true, ...(line ? { line } : {}) }; }
    if (part.type === 'text' && part.time?.end && String(part.text ?? '').trim()) return { session, progress: true, line: { kind: 'reply', text: String(part.text).trim().slice(0, 4000), at: Date.now() } };
    if (part.type === 'patch') return { session, progress: true, changed: true };
    return { session, progress: true };
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
