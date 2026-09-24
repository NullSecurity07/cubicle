import { useState } from 'react';
import type { CoderAsk as Asked } from '../../shared/coder';
import { answerCoder } from '../api';
import { pressed } from '../keys';

// What the coder wants to do, in the founder's words: run a command, change a file.
export const askedFor = (ask: Asked) => (ask.tool === 'bash' ? 'Run this command?' : ask.tool === 'edit' || ask.tool === 'write' ? 'Change this file?' : `Allow ${ask.tool}?`);

// The coder waiting for the founder, inside its own log and in "Needs you": the command or the file, and three answers.
// "Always" allows the wider pattern OpenCode suggests, for the rest of this session. A no may carry a reason, which
// goes back to the coder so it can try another way.
export function CoderAsk({ cardId, ask }: { cardId: string; ask: Asked }) {
  const [why, setWhy] = useState('');
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState('');
  const always = ask.always.filter((one) => one !== '*').join(', ');

  async function answer(reply: 'once' | 'always' | 'reject') {
    setSending(true);
    setProblem('');
    try { await answerCoder(cardId, ask.id, reply, reply === 'reject' ? why.trim() || undefined : undefined); }
    catch (error) { setProblem((error as Error).message); setSending(false); }
  }

  return (
    <div className="approval coder-ask nodrag nowheel" role="group" aria-label={askedFor(ask)}>
      <div className="approval__title">{askedFor(ask)}</div>
      <code className="coder-ask__what">{ask.what || ask.tool}</code>
      <input aria-label="Reason, if you say no" placeholder="Reason, if you say no (optional)" value={why} disabled={sending} onChange={(event) => setWhy(event.target.value)}
        onKeyDown={(event) => { if (pressed(event, 'send') && why.trim()) void answer('reject'); }} />
      {problem && <p className="msg--problem">{problem}</p>}
      <div className="approval__end">
        <button type="button" disabled={sending} onClick={() => void answer('reject')}>Reject</button>
        <button type="button" disabled={sending} title={always ? `Allow ${always} for the rest of this session` : 'Allow this for the rest of this session'} onClick={() => void answer('always')}>
          Always{always ? <span className="coder-ask__pattern">{always}</span> : null}
        </button>
        <button type="button" className="primary" disabled={sending} onClick={() => void answer('once')}>Allow</button>
      </div>
    </div>
  );
}
