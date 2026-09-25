// The Survey card's arithmetic, all of it, in one place both sides share. A survey here is written on the card,
// copied out into Tally or Google Forms (the app answers only its own page, so it cannot host a form), and its answers
// come back as the CSV those tools export. Everything the card says about them is counted here, in TypeScript: the
// share who would be very disappointed, the segment that loves the product most, the reasons people give, and NPS.
// A model is never asked for a number.

export const SURVEY_TEMPLATES = ['pmf', 'nps', 'blank'] as const;
export type SurveyTemplate = (typeof SURVEY_TEMPLATES)[number];
export const QUESTION_TYPES = ['choice', 'text', 'scale'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];
// What a question is for, so the scoring still finds the Sean Ellis question after the founder rewords it. A question
// the founder adds has none, and is read back but never scored.
export const QUESTION_ROLES = ['disappointed', 'segment', 'benefit', 'improve', 'nps', 'reason'] as const;
export type QuestionRole = (typeof QUESTION_ROLES)[number];
export type Question = { id: string; text: string; type: QuestionType; options?: string[]; role?: QuestionRole };

// One person's answers, keyed by question id. `at` is when they answered when the export said so, else when it came in.
export type SurveyResponse = { id: string; at: number; from: string; answers: Record<string, string> };
export type SurveyEvent = { responses: SurveyResponse[]; rev: number };
export const surveyChannel = (cardId: string) => `survey:${cardId}`;

// The Sean Ellis benchmark: 40% or more "very disappointed" is the sign of product-market fit. Under thirty answers
// the share moves too much from one person to the next to be trusted; that line is this app's, not the source's.
export const BENCHMARK = 40;
export const TRUSTED_AT = 30;
export const MAX_RESPONSES = 5000;
export const PRODUCT = '{product}';

export const DISAPPOINTED = ['Very disappointed', 'Somewhat disappointed', 'Not disappointed'];
export const TEMPLATE_NAMES: Record<SurveyTemplate, string> = { pmf: 'PMF', nps: 'NPS', blank: 'Blank' };

// The four questions of the Sean Ellis test, worded as Superhuman and the test's own write-ups ask them, and the
// three of an NPS survey. `{product}` becomes the product's name wherever the questions are shown or copied.
export function templateQuestions(template: SurveyTemplate): Question[] {
  if (template === 'pmf') return [
    { id: 'disappointed', role: 'disappointed', type: 'choice', text: `How would you feel if you could no longer use ${PRODUCT}?`, options: [...DISAPPOINTED] },
    { id: 'segment', role: 'segment', type: 'text', text: `What type of people do you think would most benefit from ${PRODUCT}?` },
    { id: 'benefit', role: 'benefit', type: 'text', text: `What is the main benefit you receive from ${PRODUCT}?` },
    { id: 'improve', role: 'improve', type: 'text', text: `How can we improve ${PRODUCT} for you?` },
  ];
  if (template === 'nps') return [
    { id: 'nps', role: 'nps', type: 'scale', text: `How likely are you to recommend ${PRODUCT} to a friend or colleague?` },
    { id: 'reason', role: 'reason', type: 'text', text: 'What is the main reason for your score?' },
    { id: 'improve', role: 'improve', type: 'text', text: `What is one thing we could do to make ${PRODUCT} better?` },
  ];
  return [];
}
export const templateTitle = (template: SurveyTemplate) => (template === 'pmf' ? 'PMF survey' : template === 'nps' ? 'NPS survey' : 'Survey');

export const phrased = (text: string, product?: string) => text.split(PRODUCT).join(product?.trim() || 'the product');

// ---------------------------------------------------------------- copying out

const TYPE_HINT: Record<QuestionType, string> = { choice: 'Multiple choice', text: 'Long answer', scale: 'Linear scale, 0 to 10' };

// For an email or a message: each question on its line, its choices after it in brackets.
export function questionsText(questions: Question[], product?: string): string {
  return questions.map((question, at) => {
    const options = question.type === 'choice' && question.options?.length ? ` (${question.options.join(' / ')})`
      : question.type === 'scale' ? ' (0 = not at all likely, 10 = extremely likely)' : '';
    return `${at + 1}. ${phrased(question.text, product)}${options}`;
  }).join('\n');
}

// For building the form in Tally or Google Forms: a numbered question, the kind of field to pick, and each choice
// on a line of its own, which is how both editors take a pasted list of options.
export function questionsForForms(questions: Question[], product?: string): string {
  return questions.map((question, at) => {
    const lines = [`${at + 1}. ${phrased(question.text, product)}`, `   [${TYPE_HINT[question.type]}${question.type === 'choice' ? ', one answer' : ''}]`];
    if (question.type === 'choice') for (const option of question.options ?? []) lines.push(`   - ${option}`);
    return lines.join('\n');
  }).join('\n\n');
}

// ---------------------------------------------------------------- reading an export

// Splits CSV text into rows of cells, quotes, doubled quotes and line breaks inside quotes all kept. The delimiter is
// whichever of comma, semicolon or tab the header line uses most outside quotes, so a sheet saved in a European
// locale reads the same.
export function splitCsv(text: string): string[][] {
  const body = text.replace(/^﻿/, '');
  const mark = delimiterOf(body);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let at = 0; at < body.length; at++) {
    const char = body[at];
    if (quoted) {
      if (char === '"' && body[at + 1] === '"') { cell += '"'; at++; } else if (char === '"') quoted = false; else cell += char;
    } else if (char === '"' && cell.trim() === '') { quoted = true; cell = ''; }
    else if (char === mark) { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && body[at + 1] === '\n') at++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((one) => one.map((value) => value.trim())).filter((one) => one.some(Boolean));
}
function delimiterOf(text: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === '\n' || char === '\r')) break;
    else if (!quoted && char in counts) counts[char]++;
  }
  return Object.entries(counts).sort((one, two) => two[1] - one[1])[0][0];
}

const STOP = new Set(('a an and are as at be by can do does for from have how i if in is it its me my of on or our so that the this to '
  + 'us was we what when which who will with would you your yours they them their there were been being am than then also just very really '
  + 'much more most some any all not no people person type types kind use using used get gets make makes lot like one').split(' '));
// Word forms folded so "agencies" and "agency", "founders" and "founder" count as one.
export function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(ches|shes|sses|xes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}
export const wordsOf = (text: string) => text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? [];
export const contentWords = (text: string) => wordsOf(text).map((word) => word.replace(/'[a-z]+$/, '')).filter((word) => word.length > 1 && !STOP.has(word)).map(stem);

// How alike a column header and a question are: the Dice overlap of their content words, the product's name taken
// out of both, so "…no longer use Acme?" meets "…no longer use {product}?".
export function similarity(header: string, question: string, product?: string): number {
  const strip = (text: string) => {
    let out = text.split(PRODUCT).join(' ');
    if (product?.trim()) out = out.split(new RegExp(product.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')).join(' ');
    return new Set(contentWords(out));
  };
  const one = strip(header);
  const two = strip(question);
  if (!one.size || !two.size) return 0;
  let shared = 0;
  for (const word of one) if (two.has(word)) shared++;
  return (2 * shared) / (one.size + two.size);
}

const MATCH_AT = 0.45;
// Columns every form tool adds that are never an answer.
const BOOKKEEPING = /^(timestamp|submitted at|submission (id|time|date)|respondent id|response id|id|start(ed)? (at|date|time)|end(ed)? (at|date|time)|date submitted|network id|#)$/i;
const WHEN = /^(timestamp|submitted at|submission (time|date)|date submitted|end(ed)? (at|date|time))$/i;

// Reads an answer to the Sean Ellis question into one of its three, by its words or by which of the question's own
// choices it is. Anything else is not counted.
export function disappointment(answer: string, options: string[] = DISAPPOINTED): 'very' | 'somewhat' | 'not' | null {
  const said = answer.trim().toLowerCase();
  if (!said) return null;
  const index = options.findIndex((option) => option.trim().toLowerCase() === said);
  if (index >= 0 && index < 3) return (['very', 'somewhat', 'not'] as const)[index];
  if (/\bnot\b|\bno\b|n't|wouldn.?t/.test(said) && /disappoint/.test(said)) return 'not';
  if (/\bsomewhat\b|\ba (little|bit)\b|\bslightly\b/.test(said)) return 'somewhat';
  if (/\bvery\b|\bextremely\b/.test(said)) return 'very';
  if (/^n\/?a$|don.?t use|no longer use/.test(said)) return null;
  return null;
}
// A score out of ten, however the form wrote it: "9", "9 - Very likely", "10 (Extremely likely)".
export function npsValue(answer: string): number | null {
  const found = /^\s*(10|[0-9])(?:\.0+)?\b/.exec(answer);
  return found ? Number(found[1]) : null;
}

export type Mapping = { question: string; header: string; column: number; by: 'words' | 'answers' }[];
export type ImportResult = { rows: { at: number; answers: Record<string, string>; row: number }[]; mapping: Mapping; unmatchedQuestions: string[]; unmatchedColumns: string[]; skipped: string[] };

// A CSV exported from Tally or Google Forms, read against the card's questions. Each question takes the column whose
// header says the most of what it says; the Sean Ellis and NPS questions, if their header was reworded past knowing,
// take the column whose answers are plainly theirs. A row with nothing in any matched column is skipped and said.
export function readExport(text: string, questions: Question[], product?: string, now = Date.now()): ImportResult {
  const table = splitCsv(text);
  const empty: ImportResult = { rows: [], mapping: [], unmatchedQuestions: questions.map((question) => question.id), unmatchedColumns: [], skipped: [] };
  if (!questions.length) return { ...empty, skipped: ['the survey has no questions yet'] };
  if (table.length < 2) return { ...empty, skipped: [table.length ? 'the file has a header row and no answers' : 'nothing to read'] };
  const [header, ...body] = table;
  const columns = header.map((name, column) => ({ name, column })).filter((one) => one.name && !BOOKKEEPING.test(one.name));
  // Every pairing scored, then taken best first, so two questions never share one column.
  const pairs = questions.flatMap((question) => columns.map((one) => ({ question, one, score: similarity(one.name, question.text, product) })))
    .filter((pair) => pair.score >= MATCH_AT).sort((one, two) => two.score - one.score);
  const taken = new Map<string, { column: number; by: 'words' | 'answers' }>();
  const used = new Set<number>();
  for (const pair of pairs) {
    if (taken.has(pair.question.id) || used.has(pair.one.column)) continue;
    taken.set(pair.question.id, { column: pair.one.column, by: 'words' });
    used.add(pair.one.column);
  }
  for (const question of questions) {
    if (taken.has(question.id) || (question.role !== 'disappointed' && question.role !== 'nps')) continue;
    const fits = (value: string) => (question.role === 'nps' ? npsValue(value) !== null && value.trim().length <= 24 : disappointment(value, question.options) !== null);
    const found = columns.find((one) => {
      if (used.has(one.column)) return false;
      const values = body.map((row) => row[one.column] ?? '').filter(Boolean);
      return values.length > 0 && values.filter(fits).length / values.length >= 0.6;
    });
    if (found) { taken.set(question.id, { column: found.column, by: 'answers' }); used.add(found.column); }
  }
  const when = header.findIndex((name) => WHEN.test(name));
  const rows: ImportResult['rows'] = [];
  const skipped: string[] = [];
  body.forEach((row, index) => {
    const answers: Record<string, string> = {};
    for (const [id, { column }] of taken) { const value = (row[column] ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000); if (value) answers[id] = value; }
    if (!Object.keys(answers).length) { skipped.push(`row ${index + 2}: no answer to any of the survey's questions`); return; }
    const stamp = when >= 0 ? Date.parse(row[when] ?? '') : NaN;
    rows.push({ at: Number.isFinite(stamp) ? stamp : now, answers, row: index + 2 });
  });
  const mapping: Mapping = questions.flatMap((question) => {
    const hit = taken.get(question.id);
    return hit ? [{ question: question.id, header: header[hit.column], column: hit.column, by: hit.by }] : [];
  });
  return {
    rows, mapping, skipped: taken.size ? skipped : ['no column matched any question: are these answers to this survey?'],
    unmatchedQuestions: questions.filter((question) => !taken.has(question.id)).map((question) => question.id),
    unmatchedColumns: columns.filter((one) => !used.has(one.column)).map((one) => one.name),
  };
}

// The same person answering once, however many times the file is imported: what they said, and when.
export function responseKey(at: number, answers: Record<string, string>): string {
  const text = `${at}|${Object.keys(answers).sort().map((key) => `${key}=${answers[key]}`).join('|')}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return `r-${hash.toString(36)}${text.length.toString(36)}`;
}

// ---------------------------------------------------------------- counting

// A share as a whole percent, never rounded up: 9 of 23 is 39%, not a 40% that would pass the benchmark.
export const percent = (part: number, whole: number) => (whole ? Math.floor((part * 100) / whole + 1e-9) : 0);

export const questionFor = (questions: Question[], role: QuestionRole): Question | undefined =>
  questions.find((question) => question.role === role)
  ?? (role === 'disappointed' ? questions.find((question) => question.type === 'choice' && /disappoint/i.test([question.text, ...(question.options ?? [])].join(' '))) : undefined)
  ?? (role === 'nps' ? questions.find((question) => question.type === 'scale' && /recommend/i.test(question.text)) : undefined);

export type Pmf = { answered: number; very: number; somewhat: number; not: number; score: number; passes: boolean; trusted: boolean };
export function pmfOf(responses: SurveyResponse[], question: Question): Pmf {
  const counts = { very: 0, somewhat: 0, not: 0 };
  for (const response of responses) { const said = disappointment(response.answers[question.id] ?? '', question.options); if (said) counts[said]++; }
  const answered = counts.very + counts.somewhat + counts.not;
  return { answered, ...counts, score: percent(counts.very, answered), passes: answered > 0 && counts.very * 100 >= BENCHMARK * answered, trusted: answered >= TRUSTED_AT };
}

export type Nps = { answered: number; promoters: number; passives: number; detractors: number; score: number; trusted: boolean };
export function npsOf(responses: SurveyResponse[], question: Question): Nps {
  let promoters = 0; let passives = 0; let detractors = 0;
  for (const response of responses) {
    const value = npsValue(response.answers[question.id] ?? '');
    if (value === null) continue;
    if (value >= 9) promoters++; else if (value >= 7) passives++; else detractors++;
  }
  const answered = promoters + passives + detractors;
  // Rounded half away from zero, the way NPS is quoted; the share parts beside it say the whole of it.
  const raw = answered ? ((promoters - detractors) * 100) / answered : 0;
  return { answered, promoters, passives, detractors, score: Math.sign(raw) * Math.round(Math.abs(raw)), trusted: answered >= TRUSTED_AT };
}

// People who wrote their segment in different words about the same people: "Agency founders", "founders of agencies".
// Grouped by the set of content words, named by the wording the most of them used.
export type Segment = { name: string; answered: number; very: number; score: number };
export const SEGMENT_MIN = 3;
export function segmentsOf(responses: SurveyResponse[], segment: Question, disappointed: Question): Segment[] {
  // Each wording is kept as first typed, so the card shows "Agency founders" rather than "agency founders".
  const groups = new Map<string, { names: Map<string, { count: number; typed: string }>; answered: number; very: number }>();
  for (const response of responses) {
    const said = disappointment(response.answers[disappointed.id] ?? '', disappointed.options);
    const words = response.answers[segment.id]?.trim();
    if (!said || !words) continue;
    const key = [...new Set(contentWords(words))].sort().join(' ');
    if (!key) continue;
    const group = groups.get(key) ?? { names: new Map(), answered: 0, very: 0 };
    const typed = words.replace(/[.!]+$/, '').replace(/\s+/g, ' ').slice(0, 60);
    const name = group.names.get(typed.toLowerCase()) ?? { count: 0, typed };
    name.count++;
    group.names.set(typed.toLowerCase(), name);
    group.answered++;
    if (said === 'very') group.very++;
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const top = [...group.names.values()].sort((one, two) => two.count - one.count || one.typed.length - two.typed.length)[0];
    return { name: top.typed, answered: group.answered, very: group.very, score: percent(group.very, group.answered) };
  }).sort((one, two) => two.answered - one.answered || two.score - one.score);
}

// The segment that would miss the product most, among those big enough to say so: at least SEGMENT_MIN answers, or,
// when every group is smaller than that, none at all rather than one person's say.
export function mostDisappointed(segments: Segment[]): Segment | null {
  const big = segments.filter((segment) => segment.answered >= SEGMENT_MIN && segment.very > 0);
  return big.sort((one, two) => two.score - one.score || two.answered - one.answered)[0] ?? null;
}

// What people said most often, clustered by the words they share. The term said by the most answers wins (a pair of
// words when as many said the pair), its answers are one cluster, and the next is looked for among the rest. Each
// cluster is shown by the shortest answer in it that says its words, so the card quotes a person rather than a word.
export type Reason = { term: string; count: number; quote: string };
export function topReasons(answers: string[], most = 3): Reason[] {
  let left = answers.map((text) => text.replace(/\s+/g, ' ').trim()).filter((text) => text.length > 1);
  const found: Reason[] = [];
  while (found.length < most && left.length) {
    const terms = new Map<string, { count: number; words: string[] }>();
    for (const text of left) {
      const words = contentWords(text);
      const seen = new Set<string>();
      words.forEach((word, at) => {
        seen.add(word);
        if (at + 1 < words.length) seen.add(`${word} ${words[at + 1]}`);
      });
      for (const term of seen) terms.set(term, { count: (terms.get(term)?.count ?? 0) + 1, words: term.split(' ') });
    }
    const best = [...terms].sort((one, two) => two[1].count - one[1].count || two[1].words.length - one[1].words.length || one[0].localeCompare(two[0]))[0];
    if (!best || best[1].count < 2) break;
    const [term] = best;
    const holds = (text: string) => { const words = contentWords(text); return term.includes(' ') ? words.join(' ').includes(term) : words.includes(term); };
    const cluster = left.filter(holds);
    const quote = [...cluster].sort((one, two) => one.length - two.length)[0];
    found.push({ term, count: cluster.length, quote: quote.length > 140 ? `${quote.slice(0, 137)}…` : quote });
    left = left.filter((text) => !holds(text));
  }
  return found;
}

// ---------------------------------------------------------------- what the card and a wired person read

export type SurveyCardLike = { title?: string; template?: SurveyTemplate; product?: string; questions?: Question[] };
export type Results = {
  answered: number; pmf: Pmf | null; nps: Nps | null; segments: Segment[]; top: Segment | null;
  reasons: Reason[]; asks: Reason[]; last: number | null;
};

// Everything the card shows, from the questions on it and the answers imported. The reasons are the main benefit the
// very disappointed name (they are who the product is for); with no Sean Ellis question, everyone's.
export function resultsOf(card: SurveyCardLike, responses: SurveyResponse[]): Results {
  const questions = card.questions ?? [];
  const disappointed = questionFor(questions, 'disappointed');
  const nps = questionFor(questions, 'nps');
  const segment = questionFor(questions, 'segment');
  const benefit = questionFor(questions, 'benefit') ?? questionFor(questions, 'reason');
  const improve = questionFor(questions, 'improve');
  const pmf = disappointed ? pmfOf(responses, disappointed) : null;
  const segments = disappointed && segment ? segmentsOf(responses, segment, disappointed) : [];
  const lovers = disappointed && pmf?.very ? responses.filter((response) => disappointment(response.answers[disappointed.id] ?? '', disappointed.options) === 'very') : responses;
  const answersTo = (question: Question | undefined, from: SurveyResponse[]) => (question ? from.map((response) => response.answers[question.id] ?? '').filter(Boolean) : []);
  // What would make it better is asked of those who are not yet in love with it: the somewhat disappointed, or all.
  const somewhat = disappointed ? responses.filter((response) => disappointment(response.answers[disappointed.id] ?? '', disappointed.options) === 'somewhat') : [];
  return {
    answered: responses.length, pmf, nps: nps ? npsOf(responses, nps) : null, segments, top: mostDisappointed(segments),
    reasons: topReasons(answersTo(benefit, lovers)), asks: topReasons(answersTo(improve, somewhat.length >= 2 ? somewhat : responses)),
    last: responses.length ? Math.max(...responses.map((response) => response.at)) : null,
  };
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

// The block a wired person reads each turn, in two lines at most, ending on the day the newest answer came in.
export function surveyBlock(card: SurveyCardLike, responses: SurveyResponse[], today: string, day: (at: number) => string): string {
  const kind = card.template === 'pmf' ? 'PMF survey' : card.template === 'nps' ? 'NPS survey' : 'Survey';
  const head = `- ${kind} "${card.title?.trim() || templateTitle(card.template ?? 'blank')}"`;
  if (!responses.length) return `${head}: ${plural((card.questions ?? []).length, 'question')}, no answers yet; the founder imports them from Tally or Google Forms. Read it with read_survey. Today is ${today}.`;
  const results = resultsOf(card, responses);
  const parts = [`${plural(results.answered, 'answer')}`];
  if (results.pmf?.answered) parts[0] += `, ${results.pmf.score}% very disappointed (${results.pmf.passes ? 'at or above' : 'below'} ${BENCHMARK}%)`;
  if (results.nps?.answered) parts.push(`NPS ${signed(results.nps.score)} (${plural(results.nps.answered, 'score')})`);
  const lines = [`${head}: ${parts.join('; ')}.`];
  if (results.top) lines.push(`Most disappointed: ${results.top.name.toLowerCase()} (${results.top.score}%, ${results.top.answered} answers).`);
  if (results.reasons[0]) lines.push(`Top reason: '${results.reasons[0].quote}'.`);
  const few = (results.pmf?.answered ?? results.nps?.answered ?? results.answered) < TRUSTED_AT;
  return `${lines.join(' ')}\n  ${few ? `Under ${TRUSTED_AT} answers: too few to trust. ` : ''}Raw answers with read_survey. Newest answer ${day(results.last!)}.`;
}
export const signed = (value: number) => (value > 0 ? `+${value}` : String(value));

// One line a response, for read_survey: the Sean Ellis answer first, as the thing everything else is read against.
export function responseLine(questions: Question[], response: SurveyResponse, day: (at: number) => string): string {
  const parts = questions.flatMap((question) => {
    const answer = response.answers[question.id];
    if (!answer) return [];
    const label = question.role ?? (contentWords(question.text).slice(0, 3).join(' ') || question.id);
    return [`${label}: ${answer.length > 300 ? `${answer.slice(0, 297)}…` : answer}`];
  });
  return `- ${day(response.at)} · ${parts.join(' · ')}`;
}

// Answers that hold every word of the query, however it is written.
export function matching(responses: SurveyResponse[], query: string): SurveyResponse[] {
  const wanted = wordsOf(query).map(stem).filter((word) => !STOP.has(word));
  if (!wanted.length) return responses;
  return responses.filter((response) => {
    const words = new Set(wordsOf(Object.values(response.answers).join(' ')).map(stem));
    return wanted.every((word) => words.has(word));
  });
}
