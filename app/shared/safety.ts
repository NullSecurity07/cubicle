// The safety net, as both sides see it: the standing "always allow" rules, and the two lines a coding receipt ends
// with so the founder knows whether that step can be put back.

// One standing yes: this person, this tool, this one argument that decides how far the call reaches (the recipient of
// an email, the site a browser step is on). Never anything wider, and never a rule the founder cannot see and take back.
export type AllowRule = { id: string; roomId: string; who: string; tool: string; reach: string; label: string; at: number };

// Running code, handing work to a coding agent and handing work to a colleague are never remembered: each one is its
// own decision, however often it is asked for.
export const NEVER_ALWAYS = ['run_code', 'delegate_coding', 'delegate_task'];

const origin = (raw: string) => { try { return new URL(raw).host.toLowerCase(); } catch { return ''; } };
const addresses = (raw: string) => raw.split(/[,;\s]+/).map((one) => one.trim().toLowerCase()).filter(Boolean);

// What one call reaches, when it is the kind of call that can be remembered at all. A tool whose arguments say nothing
// about how far it goes has no rule to make, so the founder is never offered one.
export function reachOf(tool: string, args: Record<string, unknown>): { reach: string; label: string } | null {
  if (NEVER_ALWAYS.includes(tool)) return null;
  if (tool === 'send_email') {
    const to = addresses(typeof args.to === 'string' ? args.to : '');
    if (!to.length) return null;
    const reach = [...new Set(to)].sort().join(', ');
    return { reach, label: to.length === 1 ? `emails to ${reach}` : `emails to those ${to.length} addresses` };
  }
  if (tool === 'browse') {
    const host = origin(typeof args.url === 'string' ? args.url : '');
    return host ? { reach: host, label: `steps on ${host}` } : null;
  }
  return null;
}

// What came of putting a step back: what went back the way it was, and what the founder has changed since and is
// therefore left exactly as they left it. `cut` says the step is out of the conversation too.
export type Undone = { dir: string; roomId: string; restored: string[]; kept: string[]; cut?: boolean };

// The last line of a coding receipt. The screen reads it to decide whether to offer "Undo this", so both sides say the
// same thing and no extra question has to be asked of the server to draw a chip.
export const UNDO_LINE = 'The folder was saved before this step, so you can undo it.';
export const NO_UNDO_LINE = 'The folder was not saved before this step, so there is nothing to undo.';
