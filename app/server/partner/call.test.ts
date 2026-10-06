import { describe, expect, it } from 'vitest';
import type { TurnResult } from '../loop.ts';
import { asksVerdict, callNudge, callShape, checkTitle, holdCall, killOf, NO_SIGNAL, plusDays, readCall, renderCall, unsourcedIn } from './call.ts';

const today = '2026-10-06';
const brief = '## Numbers\n- Beta users: 12 (2 paying)\n- Price: €39 a month\n- MRR: €78\n- Cash: €9,800\n- Burn: €1,650 a month\n- Runway: 5.9 months';
const turn = (text: string, extra: Partial<TurnResult> = {}): TurnResult => ({ text, tools: [], provider: 'p', model: 'm', usage: { input: 1, output: 1 }, stopped: false, ...extra });
const full = '**My call:** keep going.\n**Why:** 2 of 12 beta users already pay €39 a month, so the pain is real.\n'
  + '**Kill signal:** 6 paying users by 2026-11-03; if not, change course.\n**This week:** Call the 10 free beta users and ask each one to pay.\n\nThe runway gives us room.';

describe('a verdict ask', () => {
  it('is an ask for the verdict on the company, not any question', () => {
    for (const said of ['Give me your verdict on Kindling: keep going, pivot, or stop?', 'Should we keep going?', 'should I kill it?', 'Keep going or stop?', 'go or no-go on this?'])
      expect(asksVerdict(said), said).toBe(true);
    for (const said of ['What is our runway?', 'Write the beta-user update', 'keep going with the draft']) expect(asksVerdict(said), said).toBe(false);
  });

  it('asks for the four lines with a window of days counted from today', () => {
    expect(callShape(today)).toContain('from 2026-10-20 to 2026-11-17 (today is 2026-10-06)');
    expect(plusDays('2026-12-25', 14)).toBe('2027-01-08');
  });
});

describe('reading a verdict', () => {
  it('reads a full verdict: the call, the reason, the kill signal with its day, the first move, and keeps the rest', () => {
    const read = readCall(full, today, brief);
    expect(read).toMatchObject({ decision: 'keep going', missing: [], unsourced: [], signal: { what: '6 paying users', by: '2026-11-03', then: 'if not, change course' } });
    expect(read.why).toBe('2 of 12 beta users already pay €39 a month, so the pain is real.');
    expect(read.move).toBe('Call the 10 free beta users and ask each one to pay.');
    expect(read.rest).toBe('The runway gives us room.');
  });

  it('names what is missing: no kill signal, no day, a kill signal with no number', () => {
    expect(readCall('My call: keep going.\nWhy: 2 of 12 pay.\nThis week: call them.', today, brief).missing).toEqual(['kill signal', 'date']);
    expect(readCall('My call: change course.\nWhy: 2 of 12 pay.\nKill signal: 6 paying users soon.\nThis week: call them.', today, brief).missing).toEqual(['date']);
    expect(readCall('My call: stop.\nWhy: 2 of 12 pay.\nKill signal: more paying users by 2026-11-03.\nThis week: tell them.', today, brief).missing).toEqual(['kill signal']);
    expect(readCall('Keep going, I think.', today, brief).missing).toEqual(['call', 'why', 'kill signal', 'date', 'this week']);
  });

  it('rejects a past day, a day too soon and one too far, and reads a day written out', () => {
    expect(killOf('6 paying users by 2026-09-30', today).missing).toEqual(['date']);
    expect(killOf('6 paying users by 2026-10-10', today).missing).toEqual(['date']);
    expect(killOf('6 paying users by 2027-01-30', today).missing).toEqual(['date']);
    expect(killOf('6 paying users by 3 November 2026', today).signal).toEqual({ what: '6 paying users', by: '2026-11-03' });
    expect(killOf('6 paying users by November 17, 2026.', today).signal).toEqual({ what: '6 paying users', by: '2026-11-17' });
    expect(killOf('6 paying users by 2026-02-30', today).missing).toEqual(['date']);
  });

  it('holds the reason to numbers on record: a worked-out 17% or an invented market is missing its source', () => {
    expect(unsourcedIn('2 of 12 pay €39; cash €9,800 and 5.9 months of runway', brief)).toEqual([]);
    expect(unsourcedIn('17% already pay, in a market of 20,000 studios', brief)).toEqual(['17', '20000']);
    const read = readCall(full.replace('2 of 12 beta users already pay €39 a month', '17% of users already pay'), today, brief);
    expect(read.missing).toEqual(['why']);
    expect(read.unsourced).toEqual(['17']);
    expect(callNudge(read, today)).toContain('nothing on record gives 17');
  });
});

describe('holding the reply', () => {
  it('renders a full verdict in four lines without a second look', async () => {
    let asked = 0;
    const out = await holdCall('your verdict?', turn(full), async () => { asked++; return turn(''); }, today, brief);
    expect(asked).toBe(0);
    expect(out.askedAgain).toBe(false);
    expect(out.reply.text).toBe('My call: **keep going**.\nWhy: 2 of 12 beta users already pay €39 a month, so the pain is real.\n'
      + 'Kill signal: 6 paying users by 2026-11-03; if not, change course.\nThis week: Call the 10 free beta users and ask each one to pay.\n\nThe runway gives us room.');
  });

  it('asks once for only the missing kill signal and fills it from the second answer', async () => {
    const nudges: string[] = [];
    const first = turn('My call: keep going.\nWhy: 2 of 12 pay €39.\nThis week: call the 10 free users.');
    const out = await holdCall('verdict: keep going or stop?', first, async (_, nudge) => { nudges.push(nudge); return turn('Kill signal: 6 paying users by 2026-11-10', { usage: { input: 2, output: 2 } }); }, today, brief);
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toContain('missing kill signal.');
    expect(nudges[0]).not.toMatch(/^My call:|^This week:/m);
    expect(out.call?.signal).toEqual({ what: '6 paying users', by: '2026-11-10' });
    expect(out.reply.usage).toEqual({ input: 3, output: 3 });
    expect(out.reply.text).toContain('Kill signal: 6 paying users by 2026-11-10.');
  });

  it('says honestly when no kill signal is named after the second look, and invents none', async () => {
    const first = turn('My call: keep going.\nWhy: 2 of 12 pay.\nThis week: call them.');
    const out = await holdCall('your verdict?', first, async () => turn('Kill signal: more traction by 2026-09-01'), today, brief);
    expect(out.call?.signal).toBeUndefined();
    expect(out.reply.text).toContain(`Kill signal: ${NO_SIGNAL}.`);
  });

  it('leaves other asks alone', async () => {
    const first = turn('Runway is 5.9 months.');
    expect((await holdCall('what is our runway?', first, async () => turn('x'), today, brief)).reply).toBe(first);
  });

  it('words the Needs you check and a call with no signal', () => {
    expect(checkTitle({ what: '12 paying users', by: '2026-11-03' })).toBe('Check: 12 paying users by 2026-11-03?');
    expect(renderCall({ decision: 'stop' })).toBe(`My call: **stop**.\nKill signal: ${NO_SIGNAL}.`);
  });
});
