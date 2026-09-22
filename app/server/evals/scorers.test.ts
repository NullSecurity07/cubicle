import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { Case } from '../../shared/frameworks.ts';
import { todayBlock } from '../prompt.ts';
import type { ModelClient } from '../providers.ts';
import { caseScore, scoreCase } from './score.ts';
import { autoevalsJudge, faithfulPrompt, formatScore, judgeClientOf, MOST_OUTPUT_CHARS, verdictWords } from './scorers.ts';

// The verdict step of the framework that ships with the app, cut to the part that promises a shape.
const VERDICT = 'You are step five of the founder\'s notes, "Evaluating a Startup Idea": STEP FIVE — The verdict.\n\n'
  + 'Three allowed outcomes, no fourth. STRONG: assumption plausible, flaws survivable — build a cheap test now. '
  + 'WEAK: a step fails hard, usually pain or distribution. PIVOT REQUIRED: the pain is real but attacked wrong.\n\n'
  + '"It has potential, but…" is a banned phrase. Answer in ONE word before writing anything else, and ask of each flaw "does this apply to MY idea?".';
const PLAIN = 'You are step one. Name the one belief that, if false, makes everything else irrelevant.';

const kase = (over: Partial<Case> = {}): Case => ({ id: 'airbnb-verdict', keys: ['verdict'], input: 'Verdict?', addedBy: 'founder', ...over });

// An OpenAI-compatible endpoint that answers like one, without one. `autoevals` asks for a single tool call naming a
// choice, so that is what comes back — and every prompt it sent is kept, because what the judge was told is as much
// of the behaviour as what it said.
function stub(answer: (prompt: string) => { choice?: string; reasons?: string; throws?: string }) {
  const prompts: string[] = [];
  const api = {
    chat: {
      completions: {
        create: async (params: { messages: { content: string }[] }) => {
          const prompt = params.messages.map((message) => message.content).join('\n');
          prompts.push(prompt);
          const said = answer(prompt);
          if (said.throws) throw new Error(said.throws);
          return { choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'select_choice', arguments: JSON.stringify({ choice: said.choice, reasons: said.reasons ?? '' }) } }] } }] };
        },
      },
    },
  };
  return { prompts, client: { api: api as never, model: 'openai/gpt-oss-120b', name: 'groq' } };
}

describe('the shape a brief promises', () => {
  it('takes the words the notes let the answer be, and leaves emphasis alone', () => {
    expect(verdictWords(VERDICT)).toEqual(['STRONG', 'WEAK', 'PIVOT REQUIRED']);
  });

  it('finds nothing in a brief that promises no shape', () => {
    expect(verdictWords(PLAIN)).toEqual([]);
    expect(verdictWords('')).toEqual([]);
  });

  it('takes a word the brief shouts in quotes as well as one it labels with a colon', () => {
    expect(verdictWords('Answer with "HIRE" or "NO HIRE" and nothing else.')).toEqual(['HIRE', 'NO HIRE']);
  });
});

describe('the check that needs no model', () => {
  it('is the length alone when the brief promised no shape', () => {
    expect(formatScore('A real answer.', PLAIN)).toBe(1);
    expect(formatScore('   ', PLAIN)).toBe(0);
    expect(formatScore('x'.repeat(MOST_OUTPUT_CHARS), PLAIN)).toBe(0);
    expect(formatScore('A real answer.')).toBe(1);
  });

  it('is half an answer when the shape was promised and never said', () => {
    expect(formatScore('STRONG. The assumption holds.', VERDICT)).toBe(1);
    expect(formatScore('This one looks rather good to me.', VERDICT)).toBe(0.5);
    expect(formatScore('   ', VERDICT)).toBe(0);
  });

  it('hears the word whichever way the person wrote it', () => {
    expect(formatScore('My verdict: pivot required, the wedge is wrong.', VERDICT)).toBe(1);
  });
});

describe('what the faithful classifier is asked', () => {
  const now = Date.UTC(2026, 8, 22);
  const prompt = faithfulPrompt({ brief: PLAIN, chunks: ['A passage of the notes.', 'And another.'], now });

  it('puts the founder\'s own passages and their brief in front of the judge', () => {
    expect(prompt).toContain(PLAIN);
    expect(prompt).toContain('A passage of the notes.');
    expect(prompt).toContain('And another.');
  });

  it('allows the judge nothing but those notes, and three answers', () => {
    expect(prompt).toContain('Draw only on the passages of the founder\'s notes');
    expect(prompt).toContain('(yes)');
    expect(prompt).toContain('(partly)');
    expect(prompt).toContain('(no)');
  });

  it('leaves the question and the answer for the library to fill in, and says what day it is last', () => {
    expect(prompt).toContain('{{input}}');
    expect(prompt).toContain('{{output}}');
    expect(prompt.endsWith(todayBlock(now))).toBe(true);
  });

  it('never lets a note\'s own braces be read as a hole to fill', () => {
    expect(faithfulPrompt({ brief: 'Use {{name}} here', chunks: ['a {{trap}}'], now })).not.toContain('{{name}}');
  });
});

describe('the scorers a case is given', () => {
  it('asks the judge three things when the notes state both an answer and criteria', async () => {
    // Each library scorer is told apart by the words of its own published template, so the stub answers each in the
    // letters that scorer really uses.
    const { prompts, client } = stub((prompt) => (prompt.includes('[Expert]') ? { choice: 'C' } : prompt.includes('[Criterion]') ? { choice: 'Y' } : { choice: 'yes', reasons: 'It walks the steps.' }));
    let calls = 0;
    const judged = await scoreCase(
      { kase: kase({ expected: 'STRONG.', rubric: 'Three outcomes, no fourth.' }), output: 'STRONG. The assumption holds.', brief: VERDICT, chunks: ['A passage.'] },
      autoevalsJudge({ client, onCall: () => { calls += 1; } }),
    );
    expect(Object.keys(judged.scores).sort()).toEqual(['expected', 'faithful', 'format', 'rubric']);
    expect(judged.scores).toEqual({ format: 1, faithful: 1, expected: 1, rubric: 1 });
    expect(caseScore(judged)).toBe(1);
    // Three model calls, one per scorer that needed one, and the local check cost nothing.
    expect(calls).toBe(3);
    expect(prompts).toHaveLength(3);
  });

  it('asks only what the case really has', async () => {
    const { client } = stub(() => ({ choice: 'yes' }));
    let calls = 0;
    const bare = await scoreCase({ kase: kase(), output: 'STRONG.', brief: VERDICT, chunks: [] }, autoevalsJudge({ client, onCall: () => { calls += 1; } }));
    expect(Object.keys(bare.scores).sort()).toEqual(['faithful', 'format']);
    expect(calls).toBe(1);

    const { client: other } = stub((prompt) => (prompt.includes('[Criterion]') ? { choice: 'Y' } : { choice: 'yes' }));
    const rubric = await scoreCase({ kase: kase({ rubric: 'Three outcomes.' }), output: 'WEAK.', brief: VERDICT, chunks: [] }, autoevalsJudge({ client: other }));
    expect(Object.keys(rubric.scores).sort()).toEqual(['faithful', 'format', 'rubric']);
  });

  it('carries the notes and the brief into the prompt the judge really receives', async () => {
    const { prompts, client } = stub(() => ({ choice: 'partly', reasons: 'It skips the decision tree.' }));
    const judged = await scoreCase({ kase: kase(), output: 'Looks fine.', brief: VERDICT, chunks: ['Walk the decision tree in order.'] }, autoevalsJudge({ client }));
    expect(prompts[0]).toContain('Walk the decision tree in order.');
    expect(prompts[0]).toContain('Three allowed outcomes');
    // The library filled the two holes with the real question and the real answer.
    expect(prompts[0]).toContain('Verdict?');
    expect(prompts[0]).toContain('Looks fine.');
    expect(judged.scores.faithful).toBe(0.5);
    expect(judged.critique).toBe('It skips the decision tree.');
  });

  it('keeps the case when one scorer falls over, and counts the call it spent anyway', async () => {
    const { client } = stub((prompt) => (prompt.includes('Choose one:') ? { choice: 'yes' } : { throws: 'rate limited' }));
    let calls = 0;
    const judged = await scoreCase(
      { kase: kase({ expected: 'STRONG.' }), output: 'STRONG.', brief: VERDICT, chunks: [] },
      autoevalsJudge({ client, onCall: () => { calls += 1; } }),
    );
    expect(Object.keys(judged.scores).sort()).toEqual(['faithful', 'format']);
    expect(judged.critique).toContain('rate limited');
    expect(calls).toBe(2);
  });

  it('leaves the case with what needed no judge when nothing would answer', async () => {
    const { client } = stub(() => ({ throws: 'the key is gone' }));
    const judged = await scoreCase({ kase: kase(), output: 'STRONG.', brief: VERDICT, chunks: [] }, autoevalsJudge({ client }));
    expect(judged.scores).toEqual({ format: 1 });
    expect(judged.critique).toContain('did not answer in the shape');
  });
});

describe('who does the scoring', () => {
  const of = (name: string, over: Partial<ModelClient> = {}): ModelClient => ({
    name, model: `${name}-1`, maxPromptChars: 1000, tools: true, limits: {},
    openai: {} as never, step: async () => ({ text: '', calls: [] }), ...over,
  });

  it('is Groq when Groq is set up, whatever order the providers are in', () => {
    expect(judgeClientOf([of('cerebras'), of('gemini'), of('groq')])?.name).toBe('groq');
  });

  it('is Gemini\'s OpenAI endpoint when Groq is not', () => {
    expect(judgeClientOf([of('mistral'), of('gemini')])?.name).toBe('gemini');
  });

  it('takes the same key the app already holds, never a second one', () => {
    const groq = of('groq');
    expect(judgeClientOf([groq])?.api).toBe(groq.openai);
  });

  it('takes a provider that can answer now over a preferred one that is out of quota for the day', () => {
    const spent = new Set(['groq']);
    const chosen = judgeClientOf([of('groq'), of('gemini')], (client) => !spent.has(client.name));
    expect(chosen?.name).toBe('gemini');
    // And when nothing has anything left, the preference decides again rather than nobody scoring at all.
    expect(judgeClientOf([of('gemini'), of('groq')], () => false)?.name).toBe('groq');
  });

  it('passes over anything that cannot answer through a tool call, or has no endpoint of its own', () => {
    expect(judgeClientOf([of('groq', { tools: false }), of('gemini')])?.name).toBe('gemini');
    expect(judgeClientOf([of('fake', { openai: undefined })])).toBe(null);
    expect(judgeClientOf([])).toBe(null);
  });
});

describe('the scoring library', () => {
  it('is only ever reached for when a real key is about to be used', async () => {
    const source = await readFile(new URL('./scorers.ts', import.meta.url), 'utf8');
    // A static import would pull the library, and its own copy of the OpenAI client, into every offline test run and
    // every browser journey. It is asked for inside the judge, one line before the first real call.
    expect(source).not.toMatch(/^import .*'autoevals'/m);
    expect(source).toContain('await import(\'autoevals\')');
  });
});
