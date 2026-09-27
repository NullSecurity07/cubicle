// Live check, needs real keys: one case of the framework that ships with the app, put through the real `autoevals`
// scorers, with every number and the judge's own sentence printed. Run with `pnpm check:evals`.
//
// It exists because everything else about the scoring is proved offline against a stand-in judge: the unit tests know
// which scorers a case is given and what the prompts say, and no test anywhere can tell you that Groq will really
// answer a classifier's tool call. This can, for the price of three calls.
//
// `STAGE_FAKE_MODEL=1 pnpm check:evals` walks the same road with the stand-in judge and no key at all, which proves
// the script runs but proves nothing about a provider.
//
// Before any of that, with or without a key, it puts every defect the co-founder journeys found that a check in code
// now holds back through that check (server/evals/regressions.ts), and fails when one came back.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
try { process.loadEnvFile(resolve(import.meta.dirname, '../../.env')); } catch { /* no keys: the check says what it needs */ }
const { REGRESSIONS, runRegressions } = await import('../server/evals/regressions.ts');
const { caseScore, fakeJudge, scoreCase } = await import('../server/evals/score.ts');
const { autoevalsJudge, judgeClientOf, verdictWords } = await import('../server/evals/scorers.ts');
const { chunksOf } = await import('../server/recall.ts');
const { realClients } = await import('../server/providers.ts');
const { wordsIn } = await import('../shared/library.ts');
import type { Framework } from '../shared/frameworks.ts';

const here = resolve(import.meta.dirname, '..');
const fake = process.env.STAGE_FAKE_MODEL === '1';
const CHUNKS = 3;

// The passages of the note that answer this question, worked out here with no model of any kind: the live check is
// about the scorers, and an embedder downloaded in the middle of it would be a second thing to go wrong. Words the
// question and the passage share, most first — crude, and good enough to put the right section in front of a judge.
function passagesFor(note: string, question: string): string[] {
  const asked = new Set(wordsIn(question.toLowerCase()) ? question.toLowerCase().match(/[a-z]{4,}/g) ?? [] : []);
  return chunksOf(note)
    .map((chunk) => ({ chunk, shared: new Set((chunk.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((word) => asked.has(word))).size }))
    .sort((one, other) => other.shared - one.shared)
    .slice(0, CHUNKS)
    .map((one) => one.chunk);
}

const regressions = await runRegressions();
console.log(`Journey regressions: ${regressions.passed} of ${REGRESSIONS.length} held`);
for (const { defect, fault } of regressions.failed) console.log(`  CAME BACK  ${defect}\n             ${fault}`);
console.log('');
if (regressions.failed.length) process.exitCode = 1;

const framework = JSON.parse(await readFile(resolve(here, 'frameworks/startup-evaluation/framework.json'), 'utf8')) as Framework;
// The case the notes state an answer and criteria for, so all three scorers really run rather than one.
const kase = framework.dataset.find((one) => one.expected && one.rubric) ?? framework.dataset[0];
const room = framework.rooms.find((one) => kase.keys.includes(one.key))!;
const note = await readFile(resolve(here, 'frameworks/startup-evaluation/notes', 'startup-evaluation-notes.md'), 'utf8')
  .catch(async () => {
    const { readdir } = await import('node:fs/promises');
    const folder = resolve(here, 'frameworks/startup-evaluation/notes');
    const [first] = (await readdir(folder)).filter((name) => /\.(md|markdown|txt)$/i.test(name));
    return first ? readFile(resolve(folder, first), 'utf8') : '';
  });

const clients = realClients();
const client = judgeClientOf(clients);
if (!fake && !client) {
  console.log('NOT SET UP: no OpenAI-compatible provider is configured. Put GROQ_API_KEY or GEMINI_API_KEY in the repository\'s .env and run this again.');
  // Not set up is no failure; a regression that came back still is.
  process.exit(process.exitCode ?? 0);
}

let calls = 0;
const judge = fake || !client ? fakeJudge : autoevalsJudge({ client, onCall: () => { calls += 1; } });
// The answer being scored is the one the founder's own notes give. A perfect answer is the right thing to send on a
// live check: anything less and a low score could be the answer's fault rather than the scorers'.
const output = kase.expected ?? 'STRONG.';
const chunks = passagesFor(note, kase.input);

console.log(`${framework.name} · ${room.name}, ${room.role}`);
console.log(fake || !client ? 'Judge: the stand-in, no model (this proves the script runs and nothing else)' : `Judge: ${client.name} · ${client.model}`);
console.log(`Case: ${kase.id}`);
console.log(`  asked:    ${kase.input}`);
console.log(`  answered: ${output}`);
console.log(`  notes:    ${chunks.length} ${chunks.length === 1 ? 'passage' : 'passages'}, ${chunks.reduce((sum, one) => sum + one.length, 0)} characters`);
const shapes = verdictWords(room.brief);
console.log(`  shape:    ${shapes.length ? shapes.join(' / ') : 'the brief promises none, so the local check is the length alone'}`);

const started = Date.now();
const judged = await scoreCase({ kase, output, brief: room.brief, chunks }, judge);
const seconds = ((Date.now() - started) / 1000).toFixed(1);

console.log('');
for (const [name, score] of Object.entries(judged.scores)) console.log(`  ${name.padEnd(9)} ${score.toFixed(2)}`);
console.log(`  ${'case'.padEnd(9)} ${caseScore(judged).toFixed(2)}`);
console.log('');
console.log(`Critique: ${judged.critique || '(the judge said nothing)'}`);
console.log(`${calls} ${calls === 1 ? 'call' : 'calls'} · ${seconds}s`);
// A judge that would not answer leaves the case with the one check that needs nobody, and that is a failure, not a
// low score: it means the scorers never really ran.
if (!fake && Object.keys(judged.scores).length === 1) {
  console.error('FAILED: nothing but the local check answered — the scorers did not run.');
  process.exit(1);
}
