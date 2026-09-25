import { useReactFlow, type Node, type NodeProps } from '@xyflow/react';
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  BENCHMARK, PRODUCT, phrased, questionsForForms, questionsText, resultsOf, signed, templateQuestions, templateTitle, TEMPLATE_NAMES, TRUSTED_AT,
  type Question, type QuestionType, type SurveyResponse, type SurveyTemplate,
} from '../../shared/survey';
import { useAttempt } from '../attempt';
import { emit } from '../bus';
import { useWired } from '../flow';
import { overlay } from '../overlay/store';
import { pressed } from '../keys';
import { useFlushStage } from '../sync';
import { CardActions, Frame } from './Frame';
import { clearSurvey, importSurvey, watchSurvey, type Imported } from './surveyApi';
import './survey.css';

export type SurveyNodeType = Node<{ title?: string; template?: SurveyTemplate; product?: string; questions?: Question[] }, 'survey'>;

const FILE = /\.(csv|tsv|txt)$/i;
const TYPE_NAMES: Record<QuestionType, string> = { choice: 'Choice', text: 'Text', scale: '0–10' };
const STARTS: [SurveyTemplate, string, string][] = [
  ['pmf', 'Product-market fit', 'The Sean Ellis test: would they be very disappointed without it? 40% is the bar.'],
  ['nps', 'Net Promoter Score', 'How likely they are to recommend it, from 0 to 10, and why.'],
  ['blank', 'Blank', 'Your own questions, written here.'],
];
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const newQuestionId = () => `q-${Math.random().toString(36).slice(2, 8)}`;
const same = (one: Question[], two: Question[]) => JSON.stringify(one) === JSON.stringify(two);

// What the founder sees after an import: how many came in, what was left out and why, and which columns were read.
function importedWords(result: Imported, from: string): string {
  const parts = [result.imported ? `${plural(result.imported, 'answer')} imported from ${from}.` : `No new answers in ${from}.`];
  if (result.already) parts.push(`${result.already} already here.`);
  const total = result.matched.length + result.unmatchedQuestions.length;
  if (total) parts.push(`Matched ${result.matched.length} of ${plural(total, 'question')}.`);
  return parts.join(' ');
}

// A survey the founder writes here, sends from Tally or Google Forms, and brings the answers of back as the CSV those
// tools export. Nothing is hosted: the app answers only its own page. The score, the segment and the reasons are
// counted in `shared/survey.ts`, never by a model; a wired person turns them into a summary doc.
export function SurveyNode({ id, data, selected }: NodeProps<SurveyNodeType>) {
  const { updateNodeData } = useReactFlow();
  const flushStage = useFlushStage();
  const { problem, setProblem, attempt } = useAttempt();
  const [responses, setResponses] = useState<SurveyResponse[] | null>(null);
  const [tab, setTab] = useState<'questions' | 'results'>('questions');
  const [editing, setEditing] = useState<string | null>(null);
  const [switching, setSwitching] = useState<SurveyTemplate | null>(null);
  const [importing, setImporting] = useState(false);
  const [pasted, setPasted] = useState('');
  const [said, setSaid] = useState<{ text: string; skipped: string[]; unused: string[]; missing: string[] } | null>(null);
  const [copied, setCopied] = useState<'' | 'text' | 'forms'>('');
  const [over, setOver] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [writer, setWriter] = useState('');
  const pasteBox = useRef<HTMLTextAreaElement>(null);
  const had = useRef<number | null>(null);

  const questions = useMemo(() => data.questions ?? [], [data.questions]);
  const template = data.template;
  const product = data.product;
  const title = data.title ?? '';

  useEffect(() => {
    let stop = () => {};
    let gone = false;
    // The server must know this card before it will say anything about it.
    void flushStage().then(() => { if (!gone) stop = watchSurvey(id, (event) => setResponses(event.responses)); });
    return () => { gone = true; stop(); };
  }, [id, flushStage]);
  // The first answers to arrive open the results; a card that opens with answers already in starts there too.
  useEffect(() => {
    if (!responses) return;
    if ((had.current === null || had.current === 0) && responses.length) setTab('results');
    if (!responses.length) setTab('questions');
    had.current = responses.length;
  }, [responses]);
  useEffect(() => { if (importing) pasteBox.current?.focus(); }, [importing]);

  const results = useMemo(() => resultsOf({ title, template, product, questions }, responses ?? []), [title, template, product, questions, responses]);
  const people = useWired(id, 'room').filter((node) => node.data.name).map((node) => ({ id: node.id, name: String(node.data.name) }));
  const person = people.find((one) => one.id === writer) ?? people[0];
  const answered = responses?.length ?? 0;
  const mentionsProduct = questions.some((question) => question.text.includes(PRODUCT));

  function start(next: SurveyTemplate) {
    const fresh = templateQuestions(next);
    // A title the founder never changed follows the template; one they wrote stays.
    const titled = !title || STARTS.some(([one]) => templateTitle(one) === title);
    updateNodeData(id, { template: next, questions: fresh, ...(titled ? { title: templateTitle(next) } : {}) });
    setSwitching(null);
    setEditing(null);
    setTab('questions');
  }
  function pick(next: SurveyTemplate) {
    if (next === template) return;
    // Questions the founder wrote or changed are not thrown away without asking.
    if (questions.length && !same(questions, templateQuestions(template ?? 'blank'))) { setSwitching(next); return; }
    start(next);
  }
  const change = (next: Question[]) => updateNodeData(id, { questions: next });
  function edit(questionId: string, patch: Partial<Question>) {
    change(questions.map((question) => (question.id === questionId ? { ...question, ...patch } : question)));
  }
  function add() {
    const question: Question = { id: newQuestionId(), type: 'text', text: '' };
    change([...questions, question]);
    setEditing(question.id);
    if (!template) updateNodeData(id, { template: 'blank', title: title || templateTitle('blank') });
  }
  function remove(questionId: string) {
    change(questions.filter((question) => question.id !== questionId));
    if (editing === questionId) setEditing(null);
  }
  function copy(kind: 'text' | 'forms') {
    const words = kind === 'text' ? questionsText(questions, product) : questionsForForms(questions, product);
    void attempt(navigator.clipboard.writeText(words).then(() => { setCopied(kind); setTimeout(() => setCopied(''), 1600); }));
  }
  function read(text: string, name: string) {
    const from = name === 'pasted' ? 'the pasted table' : name;
    void attempt(async () => {
      // The server reads the file against the questions it has, so the ones on screen go first.
      await flushStage();
      const result = await importSurvey(id, text, name);
      setSaid({ text: importedWords(result, from), skipped: result.skipped, unused: result.unmatchedColumns, missing: result.unmatchedQuestions.map((one) => phrased(one, product)) });
      if (result.imported || result.already) { setPasted(''); setImporting(false); }
    });
  }
  function drop(event: DragEvent) {
    const file = event.dataTransfer.files[0];
    setOver(false);
    if (!file) return;
    event.preventDefault();
    event.stopPropagation();
    if (!FILE.test(file.name)) { setProblem('Drop the .csv file Tally or Google Forms exported.'); return; }
    void file.text().then((text) => read(text, file.name));
  }
  function summarise() {
    if (!person) return;
    const name = title.trim() || templateTitle(template ?? 'blank');
    const what = results.pmf ? `the share very disappointed against the ${BENCHMARK}% benchmark, the segment most disappointed, the top reasons in their own words, what the somewhat disappointed ask for`
      : results.nps ? 'the NPS with its promoters, passives and detractors, the main reasons in their own words'
        : 'what people answered to each question, in their own words';
    overlay.open({ kind: 'focus', id: person.id });
    emit('ask', { roomId: person.id, text: `Write a summary doc of the survey "${name}": read it with read_survey, then create a doc with ${what}, and what to do next. Use only the counted numbers.` });
  }

  const chosen = template !== undefined || questions.length > 0;

  return (
    <Frame selected={!!selected} minWidth={380} minHeight={360}>
      <header className="card__header card__header--doc">
        <svg className="doc-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.500" y="1.800" width="11" height="12.400" rx="2" fill="none" stroke="currentColor" strokeWidth="1.200" /><path d="M5 5.500h6M5 8h6M5 10.500h3.500" fill="none" stroke="currentColor" strokeWidth="1.200" strokeLinecap="round" /></svg>
        <input className="card__title-input nodrag" aria-label="Survey name" placeholder="Survey" value={title} onChange={(event) => updateNodeData(id, { title: event.target.value })} />
        <span className="survey__gap" />
        {chosen && (
          <div className="survey__switch nodrag" role="radiogroup" aria-label="Template">
            {(['pmf', 'nps', 'blank'] as const).map((one) => (
              <button key={one} type="button" role="radio" aria-checked={template === one} className={template === one ? 'is-on' : undefined} onClick={() => pick(one)}>{TEMPLATE_NAMES[one]}</button>
            ))}
          </div>
        )}
        <CardActions id={id} what="this Survey card (its answers stay in the workspace)" />
      </header>
      <div className="survey-card nodrag"
        onDragOver={(event) => { if (chosen && event.dataTransfer.types.includes('Files')) { event.preventDefault(); setOver(true); } }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) setOver(false); }}
        onDrop={drop}>
        <div className="survey nowheel">
          {!chosen ? (
            <div className="survey__start" role="group" aria-label="Start from">
              <p>Write the survey here, send it from Tally or Google Forms, and bring the answers back as their CSV.</p>
              {STARTS.map(([one, name, hint]) => (
                <button key={one} type="button" className="survey__start-one" onClick={() => start(one)}>
                  <b>{name}</b><span>{hint}</span>
                </button>
              ))}
            </div>
          ) : (
            <>
              {switching && (
                <div className="survey__confirm" role="alertdialog" aria-label="Replace the questions?">
                  <p>Replace these {plural(questions.length, 'question')} with the {TEMPLATE_NAMES[switching]} template?{answered ? ' Answers already imported stay, but only count against questions they answered.' : ''}</p>
                  <button type="button" className="is-primary" onClick={() => start(switching)}>Replace</button>
                  <button type="button" onClick={() => setSwitching(null)}>Keep</button>
                </div>
              )}
              {answered > 0 && (
                <div className="survey__tabs" role="tablist" aria-label="Survey views">
                  <button type="button" role="tab" aria-selected={tab === 'questions'} onClick={() => setTab('questions')}>Questions</button>
                  <button type="button" role="tab" aria-selected={tab === 'results'} onClick={() => setTab('results')}>Results <span>{answered}</span></button>
                </div>
              )}
              {tab === 'questions' || !answered ? (
                <section className="survey__questions" aria-label="Questions">
                  {mentionsProduct && (
                    <label className="survey__product">Product
                      <input aria-label="Product name" placeholder="Its name, as your users know it" value={product ?? ''} onChange={(event) => updateNodeData(id, { product: event.target.value || undefined })} />
                    </label>
                  )}
                  <ol className="survey__list">
                    {questions.map((question, at) => editing === question.id ? (
                      <li key={question.id} className="survey__q is-editing">
                        <span className="survey__n">{at + 1}</span>
                        <form className="survey__edit" onSubmit={(event) => { event.preventDefault(); setEditing(null); }}>
                          <textarea aria-label={`Question ${at + 1}`} rows={2} placeholder="Ask one thing" value={question.text} autoFocus
                            onChange={(event) => edit(question.id, { text: event.target.value })}
                            onKeyDown={(event) => { if (pressed(event, 'send')) { event.preventDefault(); setEditing(null); } }} />
                          <div className="survey__edit-row">
                            <select aria-label={`Question ${at + 1} kind`} value={question.type} onChange={(event) => {
                              const type = event.target.value as QuestionType;
                              edit(question.id, { type, options: type === 'choice' ? (question.options?.length ? question.options : ['', '']) : undefined });
                            }}>
                              <option value="text">Text answer</option>
                              <option value="choice">One choice</option>
                              <option value="scale">Scale 0 to 10</option>
                            </select>
                            <button type="submit">Done</button>
                          </div>
                          {question.type === 'choice' && (
                            <textarea className="survey__options" aria-label={`Question ${at + 1} choices`} rows={3} placeholder="One choice a line" value={(question.options ?? []).join('\n')}
                              onChange={(event) => edit(question.id, { options: event.target.value.split('\n').map((one) => one.slice(0, 120)).slice(0, 12) })} />
                          )}
                          {question.text.includes(PRODUCT) && <small>{PRODUCT} becomes the product's name when copied.</small>}
                        </form>
                      </li>
                    ) : (
                      <li key={question.id} className="survey__q">
                        <span className="survey__n">{at + 1}</span>
                        <button type="button" className="survey__text" onClick={() => setEditing(question.id)} title="Edit">
                          {question.text.trim() ? phrased(question.text, product) : <i>An empty question</i>}
                          {question.type === 'choice' && !!question.options?.filter(Boolean).length && <small>{question.options.filter(Boolean).join(' · ')}</small>}
                        </button>
                        <span className="survey__kind">{TYPE_NAMES[question.type]}</span>
                        <button type="button" className="survey__remove" aria-label={`Remove question ${at + 1}`} title="Remove" onClick={() => remove(question.id)}>
                          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.500 4.500l7 7M11.500 4.500l-7 7" /></svg>
                        </button>
                      </li>
                    ))}
                  </ol>
                  <button type="button" className="survey__add" onClick={add}>+ Add a question</button>
                  {!questions.length && <p className="survey__quiet">No questions yet.</p>}
                </section>
              ) : (
                <Results results={results} />
              )}
              {importing && (
                <form className="survey__paste" onSubmit={(event) => { event.preventDefault(); if (pasted.trim()) read(pasted, 'pasted'); }}>
                  <textarea ref={pasteBox} aria-label="Paste answers" rows={5} spellCheck={false} placeholder={'Paste the CSV that Tally or Google Forms exported,\nheader row first. Or drop the file on the card.'} value={pasted} onChange={(event) => setPasted(event.target.value)} />
                  <div className="survey__paste-end">
                    <small>Columns are matched to questions by their words.</small>
                    <button type="button" className="is-quiet" onClick={() => { setImporting(false); setPasted(''); }}>Cancel</button>
                    <button type="submit" className="is-primary" disabled={!pasted.trim()}>Import</button>
                  </div>
                </form>
              )}
              {said && (
                <div className="survey__said" role="status">
                  <p>{said.text}{said.skipped.length > 0 && ` Skipped ${said.skipped.length}:`}</p>
                  {said.skipped.length > 0 && <ul>{said.skipped.slice(0, 3).map((one) => <li key={one}>{one}</li>)}{said.skipped.length > 3 && <li>and {said.skipped.length - 3} more</li>}</ul>}
                  {said.missing.length > 0 && <p className="survey__said-quiet">No column for: {said.missing.map((one) => `"${one}"`).join(', ')}</p>}
                  {said.unused.length > 0 && <p className="survey__said-quiet">Not used: {said.unused.slice(0, 4).join(', ')}{said.unused.length > 4 ? ` and ${said.unused.length - 4} more` : ''}</p>}
                  <button type="button" aria-label="Close" onClick={() => setSaid(null)}>×</button>
                </div>
              )}
              {problem && <p className="survey__problem" role="alert">{problem}</p>}
            </>
          )}
        </div>
        {chosen && (
          <footer className="survey__foot">
            {tab === 'results' && answered > 0 ? (
              <>
                {clearing ? (
                  <span className="survey__clear-ask">Clear {plural(answered, 'answer')}?
                    <button type="button" className="is-danger" onClick={() => { setClearing(false); void attempt(clearSurvey(id)); setSaid(null); }}>Clear</button>
                    <button type="button" className="is-quiet" onClick={() => setClearing(false)}>Keep</button>
                  </span>
                ) : (
                  <button type="button" className="is-quiet" onClick={() => setClearing(true)}>Clear answers</button>
                )}
                <span className="survey__gap" />
                {!importing && <button type="button" onClick={() => { setImporting(true); setSaid(null); }}>Import more</button>}
                {people.length > 1 && (
                  <select aria-label="Who writes it" value={person?.id} onChange={(event) => setWriter(event.target.value)}>
                    {people.map((one) => <option key={one.id} value={one.id}>{one.name}</option>)}
                  </select>
                )}
                <button type="button" className="is-primary" disabled={!person} title={person ? `${person.name} writes it as a doc` : 'Wire a person to this card first'} onClick={summarise}>Write summary</button>
              </>
            ) : (
              <>
                <button type="button" disabled={!questions.length} onClick={() => copy('text')}>{copied === 'text' ? 'Copied' : 'Copy questions'}</button>
                <button type="button" disabled={!questions.length} title="A numbered list with the field kind and each choice on its line" onClick={() => copy('forms')}>{copied === 'forms' ? 'Copied' : 'Copy for Tally / Forms'}</button>
                <span className="survey__gap" />
                {!importing && <button type="button" className="is-primary" disabled={!questions.length} onClick={() => { setImporting(true); setSaid(null); }}>Import answers</button>}
              </>
            )}
          </footer>
        )}
        {over && <div className="survey__drop" aria-hidden="true">Drop the CSV from Tally or Google Forms</div>}
      </div>
    </Frame>
  );
}

// What the answers say, counted: the Sean Ellis share against its benchmark, the segment that would miss it most, the
// reasons the lovers give, what the rest ask for, and NPS when the survey asked for it.
function Results({ results }: { results: ReturnType<typeof resultsOf> }) {
  const { pmf, nps, segments, top, reasons, asks } = results;
  return (
    <section className="survey__results" aria-label="Results">
      {pmf && pmf.answered > 0 && (
        <section className="survey__score" aria-label="Product-market fit score">
          <h3>Very disappointed</h3>
          <div className="survey__big"><b>{pmf.score}%</b><span className={pmf.passes ? 'is-good' : 'is-short'}>{pmf.passes ? `at or above ${BENCHMARK}%` : `below ${BENCHMARK}%`}</span></div>
          <div className="survey__meter" role="img" aria-label={`${pmf.score}% against a ${BENCHMARK}% benchmark`}>
            <span className={`survey__fill${pmf.passes ? ' is-good' : ''}`} style={{ width: `${Math.min(100, pmf.score)}%` }} />
            <span className="survey__mark" style={{ left: `${BENCHMARK}%` }} />
          </div>
          <p className="survey__split">{pmf.very} very · {pmf.somewhat} somewhat · {pmf.not} not disappointed, of {pmf.answered}</p>
          {!pmf.trusted && <p className="survey__few">Under {TRUSTED_AT} answers: too few to trust yet.</p>}
        </section>
      )}
      {nps && nps.answered > 0 && (
        <section className="survey__score" aria-label="Net Promoter Score">
          <h3>Net Promoter Score</h3>
          <div className="survey__big"><b>{signed(nps.score)}</b><span className={nps.score > 0 ? 'is-good' : 'is-short'}>of {nps.answered}</span></div>
          <div className="survey__stack" role="img" aria-label={`${nps.promoters} promoters, ${nps.passives} passives, ${nps.detractors} detractors`}>
            <span className="is-good" style={{ flexGrow: nps.promoters }} /><span className="is-mid" style={{ flexGrow: nps.passives }} /><span className="is-bad" style={{ flexGrow: nps.detractors }} />
          </div>
          <p className="survey__split">{nps.promoters} promoters · {nps.passives} passives · {nps.detractors} detractors</p>
          {!nps.trusted && <p className="survey__few">Under {TRUSTED_AT} answers: too few to trust yet.</p>}
        </section>
      )}
      {segments.length > 0 && (
        <section className="survey__block" aria-label="Segments">
          <h3>Most disappointed</h3>
          {top ? <p className="survey__top"><b>{top.name}</b> {top.score}% of {top.answered}</p> : <p className="survey__quiet">No group of three or more answers yet.</p>}
          <ul className="survey__segments">
            {segments.slice(0, 4).map((segment) => (
              <li key={segment.name} className={segment === top ? 'is-top' : undefined}>
                <span className="survey__seg-name" title={segment.name}>{segment.name}</span>
                <span className="survey__seg-bar"><span style={{ width: `${segment.score}%` }} /></span>
                <span className="survey__seg-n">{segment.score}% <small>of {segment.answered}</small></span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {reasons.length > 0 && (
        <section className="survey__block" aria-label="Top reasons">
          <h3>{pmf?.very ? 'Why they would miss it' : 'Top reasons'}</h3>
          <ul className="survey__quotes">{reasons.map((reason) => <li key={reason.term}><q>{reason.quote}</q><small>{reason.count} said so</small></li>)}</ul>
        </section>
      )}
      {asks.length > 0 && (
        <section className="survey__block" aria-label="Top asks">
          <h3>What would make it better</h3>
          <ul className="survey__quotes">{asks.map((ask) => <li key={ask.term}><q>{ask.quote}</q><small>{ask.count} asked</small></li>)}</ul>
        </section>
      )}
      {!pmf?.answered && !nps?.answered && !reasons.length && <p className="survey__quiet">{plural(results.answered, 'answer')} in. Nothing to count yet: add a PMF or NPS question to score them.</p>}
    </section>
  );
}
