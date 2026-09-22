// One long job at a time, across every slice that runs one. The forge and the evals both drive whole turns through
// the same free models and the same day's quota: two of them at once is two jobs that each take twice as long and a
// founder watching two sets of lines with no idea which is theirs. So each slice says, in one line, whether it is
// busy and in what words, and whoever is about to start asks everybody first.
//
// The same small handle the library and the frameworks use to ask each other a question across a slice boundary:
// nothing here holds a lock, keeps a timer or can be left locked by a crash — a claim is a question about the state
// a slice already has, asked at the moment somebody wants to start.
//
// Claims are kept per workspace, because a workspace is what one founder's stage, quota and frameworks are. One
// process can hold several — the tests open a fresh one each time — and a job running in one of them is no reason
// to make another wait.

type Claim = () => string | null;

const claims = new Map<string, Set<Claim>>();

// A slice says how to ask it whether it is busy, and is given the way to stop being asked. Called on install and
// undone on close, so a workspace opened twice in one process never inherits the first one's answer.
export function claiming(workspace: string, claim: Claim): () => void {
  const held = claims.get(workspace) ?? new Set<Claim>();
  held.add(claim);
  claims.set(workspace, held);
  return () => {
    held.delete(claim);
    if (!held.size) claims.delete(workspace);
  };
}

// What is busy in this workspace, in the words the slice that is busy chose, or nothing when it is free. The first
// answer wins: the founder needs one sentence about why they are being asked to wait, not a list.
export function busyWith(workspace: string): string | null {
  for (const claim of claims.get(workspace) ?? []) {
    const said = claim();
    if (said) return said;
  }
  return null;
}
