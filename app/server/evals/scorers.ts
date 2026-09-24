import type OpenAI from 'openai';
import type { Case } from '../../shared/frameworks.ts';
import { todayBlock } from '../prompt.ts';
import { providerOf, retryAfter, type ModelClient } from '../providers.ts';
import { FLOOR } from '../router.ts';
import type { UsageBook } from '../usage.ts';
import { RUBRIC_READING, type Ask, type Judge } from './score.ts';

// The judge behind `scoreCase`, made of Braintrust's `autoevals` scorers rather than one prompt of our own. Three of
// them ask a model and one does not:
//
//   Factuality  — when the founder's notes state an answer, how close the answer given is to it;
//   rubric      — when the notes state criteria instead, how fully the answer meets them: `ClosedQA`'s question, asked
//                 with the criteria before the answer and told how to read "asks for X first";
//   faithful    — our own classifier: does the answer work through the notes' steps, or answer from somewhere else;
//   format      — local, free, and the only one that is always there.
//
// Why a library rather than our own prompt: these two scorers are argued over, published and used against the same
// datasets by people who do nothing else, and a framework the founder is asked to trust should not be scored by a
// prompt this repository invented on a Tuesday. `autoevals` is imported only here, and only when a real key is
// configured — in fake mode nothing in this file is loaded at all.

// An answer longer than this is not an answer any more: the founder asked one person one question, and a person who
// cannot say it inside a doc's worth of words has not done the work. The same cap a tool result is held to.
export const MOST_OUTPUT_CHARS = 6000;

// The shape of the choice the faithful classifier is given, and what each of its answers is worth. `n/a` is the judge
// saying the passages found do not speak to this question at all; it is no score, not a nought, and comes back as one
// the library can carry (a number no real score can be) to be taken out again below.
const NOT_RELEVANT = -1;
export const FAITHFUL_CHOICES: Record<string, number> = { yes: 1, partly: 0.5, no: 0, 'n/a': NOT_RELEVANT };
export const RUBRIC_CHOICES: Record<string, number> = { yes: 1, partly: 0.5, no: 0 };
// Answers are graded, not written, so the judge is asked for one choice and a short reason, and nothing longer.
const JUDGE_TOKENS = 512;

// A word the brief promises the answer will be. The founder's notes end steps in a shape — "STRONG, WEAK or PIVOT
// REQUIRED", "Answer in ONE word" — and a person who writes four paragraphs without ever saying one of those words
// has not answered the question, whatever a judge thinks of the paragraphs. Only words the brief really sets off
// count: shouted in quotes, or used as the label of a choice with a colon after it. An upper-case word merely used
// for emphasis in a sentence ("does this apply to MY idea?") promises nothing and is left alone.
const SHAPE = /[“"'‘]([A-Z][A-Z ]{2,28}[A-Z])[”"'’]|\b([A-Z][A-Z ]{2,28}[A-Z]):/g;
const MOST_SHAPES = 6;

export function verdictWords(brief: string): string[] {
  const found = [...brief.matchAll(SHAPE)].map((match) => (match[1] ?? match[2]).replace(/\s+/g, ' ').trim());
  return [...new Set(found)].slice(0, MOST_SHAPES);
}

// The one check that needs no model and costs nothing. Two halves, and the second only when the brief promised a
// shape: an answer that is the right length but never says the word it was told to say is half an answer, and the
// score says so rather than passing it.
export function formatScore(output: string, brief = ''): number {
  const size = output.trim() && output.length < MOST_OUTPUT_CHARS ? 1 : 0;
  const shapes = verdictWords(brief);
  if (!shapes.length) return size;
  const said = shapes.some((word) => output.toUpperCase().includes(word)) ? 1 : 0;
  return (size + said) / 2;
}

// Mustache is what `autoevals` renders a template with, so two braces in a passage of the founder's notes would be
// read as a hole to fill rather than as the founder's own words. They come out.
const plain = (text: string) => text.replace(/\{\{|\}\}/g, '');

// What the faithful classifier is asked. The founder's own passages and the brief are in it, the question and the
// answer are left as the two holes `autoevals` fills, and it ends by saying what day it is — every prompt in this
// app does, because a model with no clock answers from the year it was trained in.
export function faithfulPrompt(asked: { brief: string; chunks: string[]; now?: number }): string {
  return [
    'You are the judge of one answer, and nothing else. You do not improve the answer, you do not answer the question yourself, '
      + 'and you do not argue with the founder\'s method.',
    'Decide one thing only: is the answer faithful to the founder\'s notes? Faithful means it works through the steps those notes lay down, '
      + 'in the notes\' own vocabulary, and leaves none of them out. Following a rule of the brief is faithful too: when the brief says to ask for '
      + 'the facts first, or to refuse, an answer that does so has followed the method.',
    'Draw only on the passages of the founder\'s notes quoted below and the brief the person was working to. What you remember about this subject '
      + 'from anywhere else is not the standard here: an answer that is excellent by the internet\'s lights and skips the notes\' steps is not faithful.',
    `The brief the person was working to:\n${plain(asked.brief.trim()) || '(none)'}`,
    asked.chunks.length ? `From the founder's notes:\n${plain(asked.chunks.join('\n\n'))}` : 'No passage of the founder\'s notes was found for this question. Judge against the brief alone.',
    'What was asked:\n{{input}}',
    'The answer given:\n{{output}}',
    'Choose one:\n'
      + '(yes) It works through the notes\' own steps and vocabulary, and leaves none of them out.\n'
      + '(partly) It uses some of the notes\' steps or words, and skips or replaces others.\n'
      + '(no) It answers from somewhere else entirely, or ignores the notes\' method.\n'
      + '(n/a) The passages above say nothing about what was asked, so they cannot be followed or ignored.',
    todayBlock(asked.now ?? Date.now()),
  ].join('\n\n');
}

// What the rubric classifier is asked: `ClosedQA`'s one question, with the criteria put before the answer so the judge
// reads the answer knowing what to look for, and the one sentence on how a criterion about asking first is met.
export function rubricPrompt(asked: { rubric: string; now?: number }): string {
  return [
    'You are judging whether one answer meets the founder\'s criteria. You do not improve the answer or answer the question yourself.',
    `The criteria:\n${plain(asked.rubric.trim())}`,
    RUBRIC_READING,
    'What was asked:\n{{input}}',
    'The answer given:\n{{output}}',
    'Does the answer meet the criteria? Choose one:\n'
      + '(yes) It meets all of them.\n'
      + '(partly) It meets some and misses others.\n'
      + '(no) It meets none of them, or does the opposite.',
    todayBlock(asked.now ?? Date.now()),
  ].join('\n\n');
}

// Which of the app's own providers does the scoring. The design says Groq first, then Gemini's OpenAI endpoint, and
// the reason is cost and speed rather than taste: both are free, both speak the OpenAI API that `autoevals` expects,
// and both are already set up here with a key the founder has given once. Anything else OpenAI-compatible that is
// configured will do at a pinch — a workspace with only Cerebras should still be able to score — but no second key
// is ever asked for, and a client that cannot call tools is no use, because a classifier answers through one.
const PREFERRED = ['groq', 'gemini'];
export type JudgeClient = { api: OpenAI; model: string; name: string };

// Whether a provider has anything left to spend today, in the same terms a turn is routed by. Handed in rather than
// read here, so the choice of judge can be checked without a usage book.
export const readyEnough = (usage: UsageBook) => (client: ModelClient) => usage.left(client) > FLOOR && !usage.hot(client, 0);

export function judgeClientOf(clients: ModelClient[], ready: (client: ModelClient) => boolean = () => true): JudgeClient | null {
  return judgeClientsOf(clients, ready)[0] ?? null;
}

// Every provider that could judge, best first. The first is asked; a scorer it refuses (a rate limit, a 400 for a
// tool call it did not make, arguments it wrote badly) goes to the next, the way a person's turn does.
export function judgeClientsOf(clients: ModelClient[], ready: (client: ModelClient) => boolean = () => true): JudgeClient[] {
  const able = clients.filter((client) => client.openai && client.tools);
  // Ready first, and then the preference: a Groq key that is spent for the day is not a reason to score nothing, and
  // a Gemini that can answer now beats a Groq that cannot.
  const rank = (client: ModelClient): [number, number] => {
    const at = PREFERRED.indexOf(providerOf(client.name));
    return [ready(client) ? 0 : 1, at < 0 ? PREFERRED.length : at];
  };
  return [...able].sort((one, other) => {
    const [oneReady, onePref] = rank(one);
    const [otherReady, otherPref] = rank(other);
    return oneReady - otherReady || onePref - otherPref;
  }).map((chosen) => ({ api: chosen.openai!, model: chosen.model, name: chosen.name }));
}

// One scorer's answer, whatever went wrong. A scorer that threw takes its own score out of the case rather than the
// whole case out of the run: an answer scored on two of three scorers is still a score, and a judge that would not
// answer at all is what `scoreCase` already knows how to report.
type Scored = { score?: number; reason?: string; failed?: string };
// What every `autoevals` scorer gives back, said structurally: the library ships its own copy of the OpenAI client,
// and naming its types here would tie this file to which copy pnpm laid out today.
type ScoreLike = { score: number | null; metadata?: Record<string, unknown> };

const reasonOf = (metadata: unknown): string => {
  const held = (metadata as { rationale?: unknown } | undefined)?.rationale;
  return typeof held === 'string' ? held.replace(/\s+/g, ' ').trim() : '';
};

// A per-minute limit that clears in a few seconds is worth waiting out once, the same bound a person's turn uses;
// anything longer goes to the next provider.
const MAX_WAIT = 8000;
const pause = (milliseconds: number) => new Promise<void>((done) => { setTimeout(done, milliseconds); });

// The judge the app really uses. It gives back the same json `scoreCase` has always read, so everything outside this
// file — the forge, the reruns, the fake path — is unchanged by which library is doing the scoring.
//
// Each scorer goes to the first provider that will answer it, in the order given: a 429, a 400 for a tool call the
// model did not make, or arguments it wrote badly move that scorer on to the next, and move the provider that failed
// to the back for the scorers still to come. `onLimited` hears every 429, so the app can let that provider cool.
export function autoevalsJudge(asked: {
  client?: JudgeClient; clients?: JudgeClient[]; onCall?: () => void; now?: () => number;
  onLimited?: (name: string, milliseconds?: number) => void; wait?: (milliseconds: number) => Promise<void>;
}): Judge {
  const order = [...(asked.clients ?? (asked.client ? [asked.client] : []))];
  const wait = asked.wait ?? pause;
  return async ({ kase, output = '', brief = '', chunks = [] }: Ask) => {
    // Loaded here, never at the top of the file: fake mode must not pull a scoring library and its own copy of the
    // OpenAI client into a test run that will never call a model.
    const { Factuality, LLMClassifierFromTemplate } = await import('autoevals');
    // `autoevals` depends on its own major of the OpenAI client, so the handle we already hold is the same object
    // with a type the library will not recognise. It is the same API and the same key; the cast says so once.
    // gpt-oss thinks before it calls the tool that carries its choice, and thinking at length is what ran it out of
    // tokens before the call; low effort is what the app asks of it everywhere else too.
    const sharedOf = (client: JudgeClient) => ({
      client: client.api as never, model: client.model, useCoT: true, maxTokens: JUDGE_TOKENS,
      ...(/gpt-oss/.test(client.model) ? { reasoningEffort: 'low' as const } : {}),
    });

    // One scorer, tried on each provider in turn. Every attempt is counted before it is made: a call that fails was
    // still spent.
    const run = async (name: string, ask: (shared: ReturnType<typeof sharedOf>) => ScoreLike | Promise<ScoreLike>): Promise<Scored> => {
      const failures: string[] = [];
      for (const client of [...order]) {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          asked.onCall?.();
          try {
            const held = await ask(sharedOf(client));
            if (held.score === null) failures.push(`${client.name} did not choose`);
            else return { score: held.score, reason: reasonOf(held.metadata) };
          } catch (error) {
            const limited = (error as { status?: number }).status === 429;
            const after = retryAfter(error);
            if (limited) asked.onLimited?.(client.name, after);
            if (attempt === 1 && after !== undefined && after <= MAX_WAIT) { await wait(after + 300); continue; }
            failures.push(`${client.name}: ${((error as Error).message || 'error').slice(0, 160)}`);
          }
          break;
        }
        // This provider failed this scorer: the ones still to come ask the others first.
        order.splice(order.indexOf(client), 1);
        order.push(client);
      }
      return { failed: `${name}: ${failures.join('; ') || 'no provider to ask'}` };
    };

    const faithful = LLMClassifierFromTemplate<{ input: string }>({
      name: 'Faithful',
      promptTemplate: faithfulPrompt({ brief, chunks, now: asked.now?.() }),
      choiceScores: FAITHFUL_CHOICES,
      useCoT: true,
      maxTokens: JUDGE_TOKENS,
    });
    const rubric = LLMClassifierFromTemplate<{ input: string }>({
      name: 'Rubric',
      promptTemplate: rubricPrompt({ rubric: kase.rubric ?? '', now: asked.now?.() }),
      choiceScores: RUBRIC_CHOICES,
      useCoT: true,
      maxTokens: JUDGE_TOKENS,
    });

    // Faithfulness is only asked when there are passages of the notes to be faithful to.
    const held: Record<string, Scored> = {
      ...(kase.rubric ? { rubric: await run('rubric', (shared) => rubric({ ...shared, input: kase.input, output })) } : {}),
      ...(kase.expected ? { expected: await run('expected', (shared) => Factuality({ ...shared, input: kase.input, output, expected: kase.expected ?? '' })) } : {}),
      ...(chunks.length ? { faithful: await run('faithful', (shared) => faithful({ ...shared, input: kase.input, output })) } : {}),
    };

    // The judge said the passages do not speak to this question: faithfulness is no score, said as `null`.
    const beside = held.faithful?.score === NOT_RELEVANT;
    const scores = Object.entries(held).flatMap(([name, one]) => (one.score === undefined || one.score === NOT_RELEVANT ? [] : [[name, one.score] as const]));
    const broke = Object.values(held).map((one) => one.failed).filter(Boolean);
    // Nothing answered: that is a judge that would not answer in the shape asked for, and `scoreCase` says so.
    if (!scores.length && !beside) throw new Error(broke.join('; ') || 'no scorer answered');
    // The critique is the judge's own reasoning about the lowest thing it scored, said in one sentence the founder
    // can act on. A scorer that fell over is worth saying too, because a case scored on less than it should have
    // been is not the same as a case that scored badly.
    const worst = scores.map(([name, score]) => ({ score, reason: held[name].reason ?? '' })).sort((one, other) => one.score - other.score)[0];
    const critique = [worst?.reason ?? '', broke.length ? `(${broke.join('; ')})` : ''].filter(Boolean).join(' ');
    return JSON.stringify({ ...Object.fromEntries(scores), ...(beside ? { faithful: null } : {}), critique });
  };
}
