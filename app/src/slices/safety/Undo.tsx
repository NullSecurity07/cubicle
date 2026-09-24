import { useState } from 'react';
import type { ToolEvent } from '../../../shared/model';
import { UNDO_LINE } from '../../../shared/safety';
import { undoStep } from './api';

const files = (count: number) => `${count} ${count === 1 ? 'file' : 'files'}`;

// Quietly at the foot of a coding receipt: the way back. The receipt itself says whether the folder was saved before
// the step, so nothing has to be asked of the server to draw this.
export function UndoStep({ tool }: { tool: ToolEvent }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  const [problem, setProblem] = useState('');
  if ((tool.name !== 'code_task' && tool.name !== 'code_reply') || !tool.result?.includes(UNDO_LINE)) return null;

  async function undo() {
    setBusy(true);
    setProblem('');
    try {
      const put = await undoStep(tool.id);
      setSaid([
        put.restored.length ? `Put ${files(put.restored.length)} back the way they were.` : 'Nothing had to be put back.',
        put.kept.length ? `You have changed ${put.kept.join(', ')} since, so ${put.kept.length === 1 ? 'it was' : 'they were'} left alone.` : '',
        put.cut ? 'This step is out of the conversation now.' : '',
      ].filter(Boolean).join(' '));
    } catch (error) { setProblem((error as Error).message); setBusy(false); }
  }

  return (
    <div className="undo">
      {said ? <p className="undo__said" role="status">{said}</p> : <button type="button" className="undo__act" disabled={busy} onClick={() => void undo()}>Undo this</button>}
      {problem && <p className="msg--problem">{problem}</p>}
    </div>
  );
}
