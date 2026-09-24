// How slow work in the studio takes its turn: a few things at a time, or one at a time.

// A few slow things at a time, for work that turns up as it is found rather than as one list. The pictures of a
// film start being drawn while its narration is still being listened back to, and a few more may be asked for
// once the cut is measured; both lots go through the same pair of hands.
export function hands(most: number): <T>(job: () => Promise<T>) => Promise<T> {
  let busy = 0;
  const waiting: (() => void)[] = [];
  return async (job) => {
    // A place is handed straight to whoever is waiting rather than given up and taken again, so nobody who
    // arrives in between can slip into it.
    if (busy >= most) await new Promise<void>((go) => waiting.push(go));
    else busy += 1;
    try { return await job(); } finally {
      const next = waiting.shift();
      if (next) next(); else busy -= 1;
    }
  };
}

// One job at a time, in the order they were asked for. A job that fails does not stop the next one: each queue is
// its own instance, so the heavy local models and the picture checker never wait on each other.
export function serial(): <T>(job: () => Promise<T>) => Promise<T> {
  let turn: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const mine = turn.then(job, job);
    turn = mine.catch(() => undefined);
    return mine;
  };
}
