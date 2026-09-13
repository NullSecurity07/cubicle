// Preload that moves the process clock forward by SHIFT_DAYS (default 20), so a test that pins "today" to the
// day it was written and mixes it with a real-clock stamp fails now rather than on the morning the calendar
// turns. Two such tests slipped through on 2026-09-13 (the pantry's one-card-a-day rule, the CFO's dateline).
// Only `Date` moves: file mtimes and the event log stay on the machine's clock, so a test that compares the two
// (screencast pruning) is expected to fail under this preload and is the one to read, not to fix.
//
//   pnpm test:clock            # every package, 20 days ahead
//   SHIFT_DAYS=400 pnpm test:clock
const SHIFT = Number(process.env.SHIFT_DAYS ?? 20) * 86_400_000;
const RealDate = Date;
const now = () => RealDate.now() + SHIFT;
class ShiftedDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(now()); else super(...a); }
  static now() { return now(); }
}
globalThis.Date = ShiftedDate;
