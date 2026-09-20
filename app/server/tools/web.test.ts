import { describe, expect, it } from 'vitest';
import { seedStage } from '../../shared/model.ts';
import type { Browser } from '../browser.ts';
import type { Store } from '../store.ts';
import { webTools, yearless } from './web.ts';

// Sunday 20 September 2026, noon where the machine is.
const NOON = new Date(2026, 8, 20, 12).getTime();
// A browser that searches nothing and only writes down what it was asked for.
const asking = () => {
  const ran: { queries: string[]; recent?: string }[] = [];
  const browser = { search: async (queries: string[], recent?: string) => { ran.push({ queries, recent }); return queries.map((query) => `## ${query}\n1. A result`).join('\n\n'); } } as unknown as Browser;
  return { ran, search: webTools(browser, () => ({}), () => NOON).find((tool) => tool.name === 'web_search')! };
};
const context = (query: string) => ({ stage: seedStage, roomId: 'marketing', store: {} as Store, granted: new Map<string, string>(), query });

describe('web_search', () => {
  it('passes the window the person asked for through to the engine, and refuses a window that means nothing', async () => {
    const { ran, search } = asking();
    await search.run({ queries: ['sast market size'], recent: 'week' }, context('look up the SAST market'));
    expect(ran).toEqual([{ queries: ['sast market size'], recent: 'week' }]);
    await expect(search.run({ queries: ['x'], recent: 'fortnight' }, context(''))).rejects.toThrow(/day, week, month, year/);
  });

  it('runs a remembered year again without it, because the founder never asked for that year', async () => {
    const { ran, search } = asking();
    const { text } = await search.run({ queries: ['global static application security testing market size 2024 AI'] }, context('look up SAST using AI market'));
    expect(ran).toEqual([
      { queries: ['global static application security testing market size 2024 AI'], recent: undefined },
      { queries: ['global static application security testing market size AI'], recent: 'year' },
    ]);
    // The founder reads nothing of this, but the person is told in one line what happened and which set to trust.
    expect(text.split('\n')[0]).toContain('names a year that is past');
    expect(text.split('\n')[0]).toContain('It is now 2026');
    expect(text.split('\n')[0]).toContain('work from that second set');
  });

  it('leaves the year alone when the founder was the one who named it', async () => {
    const { ran, search } = asking();
    const { text } = await search.run({ queries: ['what happened in 2024 to the SAST market'] }, context('what happened in 2024'));
    expect(ran).toEqual([{ queries: ['what happened in 2024 to the SAST market'], recent: undefined }]);
    expect(text).not.toContain('names a year that is past');
  });

  it('knows which queries need running again', () => {
    expect(yearless(['vc funding india 2024'], '', 2026)).toEqual(['vc funding india']);
    // This year and next are what a person is told to write, so neither is netted.
    expect(yearless(['vc funding 2026', 'roadmap 2027'], '', 2026)).toEqual([]);
    expect(yearless(['prices 2022', 'prices 2023'], '', 2026)).toEqual(['prices']);
    // A query that is nothing but a year has nothing left to search for.
    expect(yearless(['2019'], '', 2026)).toEqual([]);
  });
});
