import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { interviewChannel, interviewName, length, stamp, totalSeconds, type Interview, type InterviewEvent } from '../../shared/interviews.ts';
import type { Card, Stage } from '../../shared/model.ts';
import { localDay } from '../clock.ts';
import { hub } from '../events.ts';
import { UPLOAD_LIMIT } from '../http.ts';
import type { Slice } from '../install.ts';
import { fakeConvert, fakeEar, localEars, toWav } from '../interviews/hear.ts';
import { createInterviews, interviewCardIds, type Interviews } from '../interviews/store.ts';
import { wired, wiredCards } from '../prompt.ts';
import { withSystem, type Handler } from '../seams.ts';
import { offerWhenWired } from '../slice-kit.ts';
import { rangeOf } from '../static.ts';
import type { Tool, ToolContext } from '../tools/registry.ts';

// The Interview card: a customer conversation recorded and written down on this machine. The founder ticks that the
// other person agreed, records the call (or drops a recording made elsewhere), and the transcript fills in with
// times. Nothing leaves the machine until a person wired to the card is asked about it: then the transcript goes to
// that person's model, like any wired doc.

export const INTERVIEW_TOOLS = ['read_interview'];
export const NO_CARD = 'no Interview card is connected to your room. The founder adds one from the dock and draws a wire to it.';
// Enough for a long call to be read whole by a model with room for it, and cut with a plain word when it is longer.
export const READ_LIMIT = 24_000;

type InterviewOf = Extract<Card, { kind: 'interview' }>;
const interviewCards = (stage: Stage) => (stage.cards ?? []).filter((card): card is InterviewOf => card.kind === 'interview');

// The day the interview was, as the founder set it, else the day its first recording was made.
const dayOf = (card: InterviewOf, data: Interview) => card.on?.trim() || (data.recordings[0] ? localDay(data.recordings[0].at) : '');

// One line a wired interview, for the system prompt: who, when, how long, and whether it can be read yet.
export function seamLine(card: InterviewOf, data: Interview, named: boolean): string {
  const who = `${card.who?.trim() || 'someone'}${card.company?.trim() ? ` (${card.company.trim()})` : ''}`;
  const day = dayOf(card, data);
  const seconds = totalSeconds(data.recordings);
  const state = !data.recordings.length ? 'not recorded yet'
    : data.state === 'transcribing' ? `${length(seconds)}, being written down`
      : data.transcript.length ? `${length(seconds)}, transcribed. Read it with read_interview${named ? ` (cardId "${card.id}")` : ''}`
        : `${length(seconds)}, not written down yet`;
  const insights = data.insights ? ` Insights go in the doc "${data.insights.title}".` : '';
  return `- An interview with ${who}${day ? ` on ${day}` : ''}: ${state}.${insights}`;
}

// The transcript as a person reads it: a header with the facts, then one line a moment, "[m:ss] words".
export function transcriptText(card: InterviewOf, data: Interview, query = '', limit = READ_LIMIT): string {
  const seconds = totalSeconds(data.recordings);
  const head = `Interview with ${interviewName(card)}${data.recordings.length ? `: ${length(seconds)}` : ''}, recorded with their consent and written down on this machine${data.engine ? ` by ${data.engine}` : ''}.`;
  if (!data.recordings.length) return `${head}\nNothing is recorded yet.`;
  if (!data.transcript.length) return `${head}\n${data.state === 'transcribing' ? 'It is being written down now. Ask again in a minute.' : 'It is not written down yet.'}`;
  const words = query.toLowerCase().split(/\W+/).filter((word) => word.length > 2);
  const all = data.transcript.map((line) => `[${stamp(line.at)}] ${line.text}`);
  // Asked about one thing: the lines that mention it, each with the line either side for what led up to it.
  const keep = words.length ? new Set(data.transcript.flatMap((line, index) => (words.some((word) => line.text.toLowerCase().includes(word)) ? [index - 1, index, index + 1] : []))) : null;
  const shown = keep ? all.filter((_, index) => keep.has(index)) : all;
  if (keep && !shown.length) return `${head}\nNothing in it mentions "${query}". Read it without a query for the whole of it.`;
  let text = '';
  let count = 0;
  for (const line of shown) { if (text.length + line.length > limit) break; text += `${line}\n`; count += 1; }
  const more = shown.length - count;
  return `${head}\n${keep ? `The lines about "${query}":\n` : ''}${text}${more ? `(${more} more lines after this; ask with a query to find a part)\n` : ''}`.trimEnd();
}

export function interviewTools(interviews: Interviews): Tool[] {
  return [{
    name: 'read_interview', perTurn: 3,
    description: 'Read the transcript of an interview wired to you, one line a moment with its time (m:ss). Give a query to read only the lines about one thing.',
    parameters: { type: 'object', properties: { cardId: { type: 'string', description: 'Which interview, when more than one is wired to you' }, query: { type: 'string', description: 'Words to look for, e.g. "pricing"' } } },
    async run(args, context: ToolContext) {
      const cards = wiredCards(context.stage, context.roomId, 'interview') as InterviewOf[];
      if (!cards.length) throw new Error(NO_CARD);
      const asked = typeof args.cardId === 'string' ? args.cardId.trim() : '';
      const card = asked ? cards.find((one) => one.id === asked) : cards[0];
      if (!card) throw new Error(`no interview "${asked}" is wired to you. These are: ${cards.map((one) => `${one.id} (${interviewName(one)})`).join(', ')}`);
      const text = transcriptText(card, await interviews.list(card.id), typeof args.query === 'string' ? args.query.slice(0, 120) : '');
      const others = cards.filter((one) => one !== card);
      return { text: others.length && !asked ? `${text}\n\nAlso wired to you: ${others.map((one) => `${one.id} (${interviewName(one)})`).join(', ')}. Name one with cardId.` : text };
    },
  }];
}

export default {
  name: 'interviews',
  install(deps) {
    const say = (cardId: string, event: InterviewEvent) => hub.say(interviewChannel(cardId), event);
    const interviews = createInterviews(deps.workspace, { ear: deps.fake ? fakeEar : localEars(deps.root), convert: deps.fake ? fakeConvert : toWav, tell: say });
    const onStage = async () => interviewCardIds(await deps.store.loadStage());
    const unopen = hub.open(async () => Promise.all((await onStage()).map(async (id) => ({ channel: interviewChannel(id), data: await interviews.read(id) }))));

    // A person wired to an interview reads one line about it each turn; the transcript only when they ask for it.
    const before: Handler<'turn:before'> = async (payload, next) => {
      if (payload.messages[0]?.role !== 'system') return next(payload);
      const stage = await deps.store.loadStage().catch(() => null);
      const cards = stage ? interviewCards(stage).filter((card) => wired(stage, payload.roomId, [card.id]).length) : [];
      if (!cards.length) return next(payload);
      const lines = await Promise.all(cards.map(async (card) => seamLine(card, await interviews.list(card.id), cards.length > 1)));
      return next(withSystem(payload, lines.join('\n')));
    };
    const off = deps.seams ? [deps.seams.on('turn:before', before)] : [];

    return {
      tools: interviewTools(interviews),
      offer: offerWhenWired('interview', INTERVIEW_TOOLS),
      async route(req, res, path) {
        const asked = /^\/api\/interviews\/([a-z0-9][a-z0-9-]{0,63})(?:\/(consent|recordings|retry|insights)(?:\/(\d{1,3}))?)?$/.exec(path);
        if (!asked) return false;
        const [, cardId, part, index] = asked;
        if (!(await onStage()).includes(cardId)) { deps.json(res, 404, { error: 'there is no Interview card by that name' }); return true; }
        const method = req.method ?? 'GET';
        try {
          if (!part && method === 'GET') { deps.json(res, 200, await interviews.read(cardId)); return true; }
          if (part === 'consent' && method === 'POST') { deps.json(res, 200, await interviews.consent(cardId, (await deps.body(req))?.yes === true)); return true; }
          if (part === 'recordings' && !index && method === 'POST') {
            const name = new URL(req.url ?? '/', 'http://here').searchParams.get('name') ?? 'recording.webm';
            deps.json(res, 200, await interviews.add(cardId, name, req, UPLOAD_LIMIT));
            return true;
          }
          if (part === 'recordings' && index && method === 'DELETE') { await interviews.remove(cardId, Number(index)); deps.json(res, 200, { ok: true }); return true; }
          if (part === 'recordings' && index && method === 'GET') {
            const sound = await interviews.sound(cardId, Number(index));
            if (!sound) { deps.json(res, 404, { error: 'no such recording' }); return true; }
            const ext = sound.file.split('.').pop() ?? '';
            const headers = { 'content-type': TYPES[ext] ?? 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' };
            // A player asks for a piece at a time and will not seek in a sound that answers with the lot.
            const piece = rangeOf(Array.isArray(req.headers.range) ? req.headers.range[0] : req.headers.range, sound.size);
            if (piece === 'bad') { res.writeHead(416, { ...headers, 'content-range': `bytes */${sound.size}` }); res.end(); return true; }
            if (piece) res.writeHead(206, { ...headers, 'content-range': `bytes ${piece.from}-${piece.to}/${sound.size}`, 'content-length': String(piece.to - piece.from + 1) });
            else res.writeHead(200, { ...headers, 'content-length': String(sound.size) });
            await pipeline(createReadStream(sound.file, piece ? { start: piece.from, end: piece.to } : {}), res).catch(() => { if (!res.destroyed) res.destroy(); });
            return true;
          }
          if (part === 'retry' && method === 'POST') { void interviews.transcribe(cardId); deps.json(res, 200, { ok: true }); return true; }
          if (part === 'insights' && method === 'POST') {
            const sent = await deps.body(req);
            const stage = await deps.store.loadStage();
            const room = stage.rooms.find((one) => one.id === sent?.roomId);
            const doc = stage.docs.find((one) => one.id === sent?.docId);
            if (!room || !doc) { deps.json(res, 400, { error: 'say which person writes, and into which doc on the stage' }); return true; }
            deps.json(res, 200, await interviews.insights(cardId, { docId: doc.id, title: doc.title, roomId: room.id, by: room.name, at: Date.now() }));
            return true;
          }
        } catch (error) { deps.json(res, 400, { error: (error as Error).message }); return true; }
        return false;
      },
      async close() {
        for (const stop of off) stop();
        unopen();
        interviews.close();
        await interviews.settled();
      },
    };
  },
} satisfies Slice;

const TYPES: Record<string, string> = {
  wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm',
  flac: 'audio/flac', aac: 'audio/aac', mp4: 'video/mp4', mov: 'video/quicktime',
};
