import { useState } from 'react';
import type { ToolEvent } from '../../shared/model';
import { reachOf } from '../../shared/safety';
import { answerApproval, request, send } from '../api';

// A standing yes is kept by the safety extra, which owns the rules and the list the founder takes them back in; the
// step itself is then answered exactly as any other is.
async function remember(id: string, args: Record<string, string>) {
  await request('/api/safety/rules', send('POST', { id, args }), 'that could not be remembered');
}

const TITLES: Record<string, [title: string, yes: string]> = { send_email: ['Send this email?', 'Send'], run_code: ['Run this code?', 'Run'], browse: ['Allow this step?', 'Allow'], code_task: ['Start this coding task?', 'Start'], code_reply: ['Send this to the coder?', 'Send'], browse_help: ['Do this step by hand?', 'Done'], map_folder: ['Map this folder?', 'Map'], ask_founder: ['A question for you', 'Answer'] };
const FIXED = new Set(['from', 'language', 'action', 'ref', 'url', 'key', 'direction', 'card']);
const LONG = new Set(['body', 'code', 'text', 'task', 'brief']);
const LABELS: Record<string, string> = { to: 'To', subject: 'Subject', body: 'Message', from: 'From', reply_to: 'In reply to', language: 'Language', code: 'Code', brief: 'Brief', card: 'Card', answer: 'Why not (if you won\'t)' };
// A question put to the founder carries their answer in the same field a refused step carries its reason.
export const fieldLabel = (tool: string, key: string) => (tool === 'ask_founder' && key === 'answer' ? 'Your answer' : LABELS[key] ?? key);
// The answers a question to the founder offers, each shown as its own button; nothing for any other step.
export const choicesOf = (tool: Pick<ToolEvent, 'name' | 'choices'> & Partial<ToolEvent>) => (tool.name === 'ask_founder' ? (tool.choices ?? []).filter((one) => one.trim()) : []);
// A question to the founder waits for words or a choice: an empty answer would close it with nothing said.
export const canAnswer = (tool: string, args: Record<string, string>) => tool !== 'ask_founder' || !!args.answer?.trim();
// What the founder was asked, when the step itself came with no question of its own. The needs panel says it back
// in the same words, so an approval the app closed on reads there exactly as it read in the room.
export const asked = (name: string) => TITLES[name]?.[0] ?? `Allow ${name}?`;
// The word on the yes button, the same wherever the step is answered.
export const yesOf = (name: string) => TITLES[name]?.[1] ?? 'Allow';

// An outward action waiting for the founder: everything that will go out, open to edits, and two answers.
export function Approval({ tool }: { tool: ToolEvent }) {
  const [args, setArgs] = useState(() => Object.fromEntries(Object.entries(tool.args).filter(([, value]) => typeof value === 'string')) as Record<string, string>);
  const [sending, setSending] = useState(false);
  const [always, setAlways] = useState(false);
  const [problem, setProblem] = useState('');
  const fallback = asked(tool.name);
  const yes = yesOf(tool.name);
  const title = tool.question || fallback;
  // What this step reaches, as the founder has it in front of them now — so editing the address changes what a
  // standing yes would cover. A step whose reach nothing in it decides is never offered one.
  const reach = reachOf(tool.name, { ...tool.args, ...args });

  const choices = choicesOf(tool);

  // `picked` is one of the question's choices, sent as the answer in place of whatever the field says.
  async function answer(ok: boolean, picked?: string) {
    setSending(true);
    try {
      if (ok && always && reach) await remember(tool.id, args);
      // A person asking for a hand is told why not, when the founder says why; every other "no" carries nothing.
      await answerApproval(tool.id, ok, picked !== undefined ? { ...args, answer: picked } : ok || tool.name === 'browse_help' ? args : undefined);
    } catch (error) { setProblem((error as Error).message); setSending(false); }
  }

  return (
    <div className="approval nodrag nowheel" role="group" aria-label={fallback}>
      <div className="approval__title">{title}</div>
      {choices.length > 0 && (
        <div className="approval__choices" role="group" aria-label="Choose an answer">
          {choices.map((choice) => <button key={choice} type="button" disabled={sending} onClick={() => void answer(true, choice)}>{choice}</button>)}
        </div>
      )}
      {Object.entries(args).sort(([a], [b]) => Number(LONG.has(a)) - Number(LONG.has(b))).map(([key, value]) => (
        <label key={key}>{fieldLabel(tool.name, key)}
          {LONG.has(key)
            ? <textarea className={key === 'code' ? 'approval__code' : undefined} rows={key === 'code' ? 8 : 5} spellCheck={key !== 'code'} value={value} onChange={(event) => setArgs({ ...args, [key]: event.target.value })} />
            : FIXED.has(key) ? <input value={value === 'me' ? 'their own mailbox' : value === 'founder' ? 'your address' : value} readOnly />
            : <input value={value} onChange={(event) => setArgs({ ...args, [key]: event.target.value })} />}
        </label>
      ))}
      {reach && (
        <label className="approval__always">
          <input type="checkbox" checked={always} disabled={sending} onChange={(event) => setAlways(event.target.checked)} />
          Always allow {reach.label}
        </label>
      )}
      {problem && <p className="msg--problem">{problem}</p>}
      <div className="approval__end">
        <button type="button" disabled={sending} onClick={() => void answer(false)}>Don't</button>
        <button type="button" className="primary" disabled={sending || !canAnswer(tool.name, args)} title={canAnswer(tool.name, args) ? undefined : 'Type an answer or pick a choice'} onClick={() => void answer(true)}>{yes}</button>
      </div>
    </div>
  );
}
