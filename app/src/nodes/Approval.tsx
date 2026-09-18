import { useState } from 'react';
import type { ToolEvent } from '../../shared/model';
import { answerApproval } from '../api';

const TITLES: Record<string, [title: string, yes: string]> = { send_email: ['Send this email?', 'Send'], run_code: ['Run this code?', 'Run'], browse: ['Allow this step?', 'Allow'], delegate_coding: ['Start this coding task?', 'Start'] };
const FIXED = new Set(['from', 'language', 'action', 'ref', 'url', 'key', 'direction']);
const LONG = new Set(['body', 'code', 'text', 'task']);
const LABELS: Record<string, string> = { to: 'To', subject: 'Subject', body: 'Message', from: 'From', reply_to: 'In reply to', language: 'Language', code: 'Code' };

// An outward action waiting for the founder: everything that will go out, open to edits, and two answers.
export function Approval({ tool }: { tool: ToolEvent }) {
  const [args, setArgs] = useState(() => Object.fromEntries(Object.entries(tool.args).filter(([, value]) => typeof value === 'string')) as Record<string, string>);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState('');
  const [fallback, yes] = TITLES[tool.name] ?? [`Allow ${tool.name}?`, 'Allow'];
  const title = tool.question || fallback;

  async function answer(ok: boolean) {
    setSending(true);
    try { await answerApproval(tool.id, ok, ok ? args : undefined); } catch (error) { setProblem((error as Error).message); setSending(false); }
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
      {problem && <p className="msg--problem">{problem}</p>}
      <div className="approval__end">
        <button type="button" disabled={sending} onClick={() => void answer(false)}>Don't</button>
        <button type="button" className="primary" disabled={sending} onClick={() => void answer(true)}>{yes}</button>
      </div>
    </div>
  );
}
