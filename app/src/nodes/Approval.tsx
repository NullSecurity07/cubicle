import { useState } from 'react';
import type { ToolEvent } from '../../shared/model';
import { reachOf } from '../../shared/safety';
import { answerApproval } from '../api';

// A standing yes is kept by the safety extra, which owns the rules and the list the founder takes them back in; the
// step itself is then answered exactly as any other is.
async function remember(id: string, args: Record<string, string>) {
  const response = await fetch('/api/safety/rules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, args }) });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? 'that could not be remembered');
}

const TITLES: Record<string, [title: string, yes: string]> = { send_email: ['Send this email?', 'Send'], run_code: ['Run this code?', 'Run'], browse: ['Allow this step?', 'Allow'], delegate_coding: ['Start this coding task?', 'Start'] };
const FIXED = new Set(['from', 'language', 'action', 'ref', 'url', 'key', 'direction']);
const LONG = new Set(['body', 'code', 'text', 'task']);
const LABELS: Record<string, string> = { to: 'To', subject: 'Subject', body: 'Message', from: 'From', reply_to: 'In reply to', language: 'Language', code: 'Code' };
// What the founder was asked, when the step itself came with no question of its own. The needs panel says it back
// in the same words, so an approval the app closed on reads there exactly as it read in the room.
export const asked = (name: string) => TITLES[name]?.[0] ?? `Allow ${name}?`;

// An outward action waiting for the founder: everything that will go out, open to edits, and two answers.
export function Approval({ tool }: { tool: ToolEvent }) {
  const [args, setArgs] = useState(() => Object.fromEntries(Object.entries(tool.args).filter(([, value]) => typeof value === 'string')) as Record<string, string>);
  const [sending, setSending] = useState(false);
  const [always, setAlways] = useState(false);
  const [problem, setProblem] = useState('');
  const fallback = asked(tool.name);
  const yes = TITLES[tool.name]?.[1] ?? 'Allow';
  const title = tool.question || fallback;
  // What this step reaches, as the founder has it in front of them now — so editing the address changes what a
  // standing yes would cover. A step whose reach nothing in it decides is never offered one.
  const reach = reachOf(tool.name, { ...tool.args, ...args });

  async function answer(ok: boolean) {
    setSending(true);
    try {
      if (ok && always && reach) await remember(tool.id, args);
      await answerApproval(tool.id, ok, ok ? args : undefined);
    } catch (error) { setProblem((error as Error).message); setSending(false); }
  }

  return (
    <div className="approval nodrag nowheel" role="group" aria-label={fallback}>
      <div className="approval__title">{title}</div>
      {Object.entries(args).sort(([a], [b]) => Number(LONG.has(a)) - Number(LONG.has(b))).map(([key, value]) => (
        <label key={key}>{LABELS[key] ?? key}
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
        <button type="button" className="primary" disabled={sending} onClick={() => void answer(true)}>{yes}</button>
      </div>
    </div>
  );
}
