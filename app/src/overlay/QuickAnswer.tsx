import { useState } from 'react';
import { useAttention } from './attention';
import { answerQuick, quickAnswer, type Quick } from './rowAnswer';

// What a dashboard row may answer, read from the live needs-you list: the row's buttons go the moment the step is
// answered anywhere, here, in Needs you or on the card.
export function useQuick() {
  const waiting = useAttention();
  return (id: string) => quickAnswer(waiting.find((one) => one.id === id));
}

// Don't and the step's own yes, under the words of a dashboard row that waits for the founder's OK.
export function QuickAnswer({ quick, title }: { quick: Quick; title: string }) {
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState('');
  async function answer(ok: boolean) {
    setSending(true);
    setProblem('');
    try { await answerQuick(quick, ok); } catch (error) { setProblem((error as Error).message); setSending(false); }
  }
  return (
    <div className="dash__answer" role="group" aria-label={`Answer: ${title}`}>
      <button type="button" className="dash__act" disabled={sending} onClick={() => void answer(false)}>Don't</button>
      <button type="button" className="dash__act primary" disabled={sending} onClick={() => void answer(true)}>{quick.yes}</button>
      {problem && <p className="msg--problem" role="alert">{problem}</p>}
    </div>
  );
}
