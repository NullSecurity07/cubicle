import { describe, expect, it } from 'vitest';
import type { TurnResult } from '../loop.ts';
import { economicsOf } from './economics.ts';
import { asksVerdict, callNudge, callShape, checkTitle, deadSignal, holdCall, killOf, NO_SIGNAL, plusDays, readCall, renderCall, thresholdOf, unsourcedIn } from './call.ts';

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

describe('a claim of evidence in the reason', () => {
  // Journey 12: "The product itself works" stood in the partner's verdict with nothing behind it.
  const works = full.replace('**Why:** 2 of 12 beta users already pay €39 a month, so the pain is real.', '**Why:** The product itself works, and 2 of 12 beta users already pay €39 a month.');
  it('is marked "(assumption)" when nothing the founder said or a tool gave backs it', async () => {
    const out = await holdCall('your verdict?', turn(works), undefined, today, brief, [brief]);
    expect(out.call?.why).toBe('The product itself works, and 2 of 12 beta users already pay €39 a month (assumption).');
    expect(out.reply.text).toContain('Why: The product itself works, and 2 of 12 beta users already pay €39 a month (assumption).');
  });
  it('stands when the founder said it', async () => {
    const out = await holdCall('your verdict?', turn(works), undefined, today, brief, [brief, 'Our studios say the build flow works for them.']);
    expect(out.call?.why).not.toContain('(assumption)');
  });
});

// Journey 13: "keep going" for a goal of 10 paying offices while the brief's numbers put break-even at 34.
describe('a verdict held to the brief\'s break-even', () => {
  const harvest = '- Paying offices: 3 (since September 2026)\n- Price: €240 a month per office\n- Produce + delivery cost: €41 per box, about €178 a month per office\n- Cash: €12,000\n- Burn: €2,100 a month';
  const economics = economicsOf(harvest)!;
  const blind = 'My call: keep going.\nWhy: We have €12,000 cash and €2,100 monthly burn to support our goal of 10 paying offices.\n'
    + 'Kill signal: Paying offices below 5 by 2026-11-17.\nThis week: Pitch the remaining 2 pilot offices.';

  it('shows the working under the reason, and its figures count as sourced', async () => {
    const said = 'My call: change course.\nWhy: Break-even is 34 paying offices and runway is 6.3 months, so the pilot still loses money.\n'
      + 'Break-even: ceil(2100 / (240 - 178)) = 34\nKill signal: Paying offices below 5 by 2026-11-17.\nThis week: Price a bigger box at €320.';
    const out = await holdCall('your verdict?', turn(said), async () => { throw new Error('not asked'); }, today, harvest, [harvest], economics);
    expect(out.askedAgain).toBe(false);
    expect(out.reply.text).toBe('My call: **change course**.\nWhy: Break-even is 34 paying offices and runway is 6.3 months, so the pilot still loses money.\n'
      + '- Break-even: ceil(2100 / (240 - 178)) = 34 paying offices to cover fixed costs; we have 3.\n- Runway: round(12000 / (2100 - 3 * (240 - 178)), 1) = 6.3 months at the net burn.\n'
      + 'Kill signal: Paying offices below 5 by 2026-11-17.\nThis week: Price a bigger box at €320.');
    expect(out.call?.working).toHaveLength(2);
  });

  it('asks a "keep going" far below break-even how the gap closes, and keeps the answer', async () => {
    const nudges: string[] = [];
    const out = await holdCall('Give me your verdict: keep going, pivot, or stop?', turn(blind), async (_, nudge) => { nudges.push(nudge); return turn('My call: keep going.\nGap: reach 34 paying offices by raising the price to €320 and signing 4 offices a month.'); }, today, harvest, [harvest], economics);
    expect(nudges[0]).toContain('how the gap closes. Answer');
    expect(nudges[0]).toContain('Gap: your call is keep going, but break-even is 34 paying offices and the company has 3.');
    expect(out.reply.text).toContain('Gap: reach 34 paying offices by raising the price to €320 and signing 4 offices a month.');
    expect(out.call?.decision).toBe('keep going');
  });

  it('takes a changed call, and says so in words when nothing closes the gap', async () => {
    const changed = await holdCall('your verdict?', turn(blind), async () => turn('My call: change course.'), today, harvest, [harvest], economics);
    expect(changed.call?.decision).toBe('change course');
    expect(changed.reply.text).not.toContain('Gap:');
    // A gap line the partner wrote on a call that is not "keep going" is not shown.
    const labelled = await holdCall('your verdict?', turn(blind.replace('keep going', 'change course') + '\nGap: break-even is far off, so the price has to rise.'), undefined, today, harvest, [harvest], economics);
    expect(labelled.reply.text).not.toContain('Gap:');
    const silent = await holdCall('your verdict?', turn(blind), async () => turn('My call: keep going.'), today, harvest, [harvest], economics);
    expect(silent.reply.text).toContain('Gap: break-even is 34 paying offices and the company has 3; nothing said yet closes that gap.');
  });
});

// Journey 14's Company brief: 2 paying practices already, so "< 2" could only fire if one left.
const CALLBACK = '- Price: €49 per practice per month\n- Practices contacted: 40\n- Pilots running: 3\n- Paying practices: 2\n- Cash in the bank: €4,000\n- Monthly burn: €900';
describe('a kill signal that can fail', () => {
  it('reads the threshold and which way it fires', () => {
    expect(thresholdOf('paying practices < 2')).toEqual({ metric: 'paying practices', below: true, value: 2 });
    expect(thresholdOf('Paying practices still below 10')).toEqual({ metric: 'Paying practices', below: true, value: 10 });
    expect(thresholdOf('fewer than 10 paying practices')).toEqual({ metric: 'paying practices', below: true, value: 10 });
    expect(thresholdOf('monthly burn above €1,200')).toEqual({ metric: 'monthly burn', below: false, value: 1200 });
    expect(thresholdOf('6 paying users')).toEqual({ metric: 'paying users', below: true, value: 6 });
    expect(thresholdOf('more traction')).toBeNull();
  });

  it('turns down a threshold on the winning side of today, or out of reach, and keeps one the company could miss', () => {
    const by = '2026-11-03';
    expect(deadSignal({ what: 'paying practices < 2', by }, CALLBACK)).toContain('Paying practices is 2 now (Company brief), so "paying practices < 2" can only fire if it falls back');
    expect(deadSignal({ what: 'paying practices < 1', by }, CALLBACK)).toContain('can only fire');
    expect(deadSignal({ what: 'Paying practices < 10', by }, CALLBACK)).toBeNull();
    expect(deadSignal({ what: 'paying practices < 500', by }, CALLBACK)).toContain('out of reach');
    expect(deadSignal({ what: 'monthly burn above €1,200', by }, CALLBACK)).toContain('can only fire if it rises back');
    expect(deadSignal({ what: 'monthly burn above €800', by }, CALLBACK)).toBeNull();
    // A number the brief does not hold is not judged.
    expect(deadSignal({ what: 'reply rate < 20%', by }, CALLBACK)).toBeNull();
  });

  it('asks once for a real one, and says none is named when the second is no better', async () => {
    const first = turn('My call: keep going.\nWhy: 2 paying practices out of 40 contacted.\nKill signal: paying practices < 2 by 2026-11-03.\nThis week: convert the 3 pilots.');
    const nudges: string[] = [];
    const fixed = await holdCall('your verdict?', first, async (_, nudge) => { nudges.push(nudge); return turn('Kill signal: paying practices < 10 by 2026-11-03'); }, today, CALLBACK, [CALLBACK], null, CALLBACK);
    expect(nudges[0]).toContain('can only fire if it falls back');
    expect(fixed.call?.signal).toEqual({ what: 'paying practices < 10', by: '2026-11-03' });
    const still = await holdCall('your verdict?', first, async () => turn('Kill signal: paying practices < 2 by 2026-11-03'), today, CALLBACK, [CALLBACK], null, CALLBACK);
    expect(still.call?.signal).toBeUndefined();
    expect(still.reply.text).toContain(`Kill signal: ${NO_SIGNAL}.`);
  });
});
