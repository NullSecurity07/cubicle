import { useCallback, useState } from 'react';

// The one way a card or a view tries something and says why it could not: the last problem is cleared as the next
// try starts, and a failure is shown in the server's own words. `work` is a promise already under way, or a function
// that starts one. It answers whether the work went through.
export function useAttempt() {
  const [problem, setProblem] = useState('');
  const attempt = useCallback(async (work: Promise<unknown> | (() => Promise<unknown>)) => {
    setProblem('');
    try { await (typeof work === 'function' ? work() : work); return true; } catch (error) { setProblem((error as Error).message); return false; }
  }, []);
  return { problem, setProblem, attempt };
}
