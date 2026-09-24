import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ModelMessage } from '../prompt.ts';
import type { ModelClient } from '../providers.ts';
import { createSeams } from '../seams.ts';
import { UNTRUSTED } from '../tools/web.ts';
import { createUsage } from '../usage.ts';
import { createShrinking, cutJson, foldRepeats, headTail, resultCap, shrinkResult, stripChrome } from './shrink.ts';

const client = (name: string, maxPromptChars: number, extra: Partial<ModelClient> = {}): ModelClient => ({ name, model: name, maxPromptChars, tools: true, limits: {}, step: async () => ({ text: '', calls: [] }), ...extra });

// A page as the browser's innerText gives it when the site has no <main>: every block on its own line, the menu's
// links one a line. Made from the crawl fixture's own home page.
function bodyText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<nav>([\s\S]*?)<\/nav>/gi, (_, inner: string) => inner.replace(/<\/a>/gi, '\n'))
    .replace(/<\/?(header|nav|main|footer|p|h\d|li|div|br|title|head)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

describe('shrinking a tool result on its way into the prompt', () => {
  it('folds the same line said over and over into one line and a count', () => {
    expect(foldRepeats(['a', 'b', 'b', 'b', 'c', '', '', 'c'])).toEqual({ lines: ['a', 'b ×3', 'c', '', 'c'], folded: 2 });
    const log = ['start', ...Array(30).fill('retrying connection'), 'done'].join('\n');
    const shrunk = shrinkResult('run_code', log);
    expect(shrunk.text).toContain('retrying connection ×30');
    expect(shrunk.text.split('\n').at(-1)).toMatch(/^\[Shrunk for the prompt: 29 repeated lines folded\./);
    expect(shrunk.after).toBeLessThan(shrunk.before);
  });

  it('drops cookie banners and menus from a web page, and never a list in the middle of it', () => {
    const menu = ['Home', 'Product', 'Pricing', 'Customers', 'Blog', 'Careers'];
    const features = ['Calendar sync', 'Task import', 'Team spaces', 'Slack app', 'Weekly review'];
    const words = Array.from({ length: 12 }, (_, at) => `Paragraph ${at + 1} of the page says something worth reading, in a whole sentence.`);
    const lines = ['Skip to content', ...menu, 'We use cookies to improve your experience.', 'Accept all', ...words.slice(0, 6), ...features, ...words.slice(6), '© 2026 Acme Inc.'];
    const { lines: kept, dropped } = stripChrome(lines, true);
    expect(kept).toEqual([...words.slice(0, 6), ...features, ...words.slice(6)]);
    expect(dropped).toBe(10);
    // A search result's short lines are not a menu: only banners go there.
    expect(stripChrome(menu, false).lines).toEqual(menu);
    // A tool that is not a web read keeps its short lines whatever they look like.
    expect(shrinkResult('read_doc', lines.join('\n')).text).toBe(lines.join('\n'));
  });

  it('keeps the start and the end of a long log, and says how much of the middle was folded', () => {
    const log = Array.from({ length: 200 }, (_, at) => `line ${at + 1}`);
    expect(headTail(log).lines).toHaveLength(81);
    const shrunk = shrinkResult('run_code', log.join('\n'));
    expect(shrunk.text).toContain('line 40\n… 120 lines folded …\nline 161');
    expect(shrunk.text).toContain('the middle 120 lines of the output folded, first 40 and last 40 kept');
    // A document read by name is the founder's to read whole: no head and tail there.
    expect(shrinkResult('read_file', log.join('\n')).text).toBe(log.join('\n'));
  });

  it('caps a result at a share of the smallest model a turn can land on, cut at a line', () => {
    expect(resultCap([client('groq', 18_000), client('gemini', 400_000), client('groq-small', 16_000, { side: true, tools: false })])).toBe(4500);
    expect(resultCap([])).toBe(Infinity);
    const text = Array.from({ length: 400 }, (_, at) => `row ${at} ${'x'.repeat(20)}`).join('\n');
    const shrunk = shrinkResult('read_file', text, 4500);
    expect(shrunk.after).toBeLessThanOrEqual(4500);
    const body = shrunk.text.split('\n').slice(0, -1);
    expect(body.every((line) => /^row \d+ x{20}$/.test(line))).toBe(true);
    expect(shrunk.text.split('\n').at(-1)).toMatch(/cut at a line after [\d,]+ of [\d,]+ characters/);
  });

  it('never cuts a JSON answer mid-structure: whole entries go from the end, and what is left still parses', () => {
    const list = Array.from({ length: 50 }, (_, at) => ({ id: at, name: `Lead ${at}`, note: 'n'.repeat(80) }));
    const text = JSON.stringify(list, null, 2);
    const shrunk = shrinkResult('list_leads', text, 3000);
    const [json, note] = [shrunk.text.slice(0, shrunk.text.lastIndexOf('\n')), shrunk.text.slice(shrunk.text.lastIndexOf('\n') + 1)];
    const back = JSON.parse(json) as typeof list;
    expect(back.length).toBeGreaterThan(0);
    expect(back).toEqual(list.slice(0, back.length));
    expect(note).toMatch(new RegExp(`only the first ${back.length} entries of 50 fit here`));
    // A JSON answer that fits is left exactly as it came, repeated lines and all.
    const small = JSON.stringify({ a: [1, 1, 1] }, null, 2);
    expect(shrinkResult('list_leads', small, 3000).text).toBe(small);
    expect(cutJson('{"a": 1}', 2)).toBeNull();
  });

  it('touches only tool results, each once, and writes down what each tool came to', async () => {
    const usage = createUsage(null);
    const seams = createSeams();
    seams.on('step:before', createShrinking({ clients: [client('groq', 18_000)], usage }));
    const noisy = Array(30).fill('the same warning, printed once a second while it waits').join('\n');
    const messages: ModelMessage[] = [
      { role: 'system', content: noisy },
      { role: 'user', content: noisy },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_code', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: noisy },
    ];
    const once = (await seams.run('step:before', { roomId: 'r', step: 2, messages })).messages;
    expect(once[0].content).toBe(noisy);
    expect(once[1].content).toBe(noisy);
    expect(once[3].content).toMatch(/^the same warning, printed once a second while it waits ×30\n\[Shrunk for the prompt: 29 repeated lines folded\./);
    const twice = (await seams.run('step:before', { roomId: 'r', step: 3, messages: once })).messages;
    expect(twice[3].content).toBe(once[3].content);
    expect(usage.today().tools).toEqual({ run_code: { results: 1, before: noisy.length, after: once[3].content.length } });
  });

  it('measures a real fixture page read off the web, before and after', () => {
    const html = readFileSync(join(import.meta.dirname, '../slices/crawl.fixtures/home.html'), 'utf8');
    const page = `${UNTRUSTED}## Acme — plan your week\nhttps://acme.test/\n\n${bodyText(html)}`;
    const shrunk = shrinkResult('web_fetch', page, resultCap([client('groq', 18_000)]));
    console.log(`web_fetch of crawl.fixtures/home.html: ${shrunk.before} characters before, ${shrunk.after} after`);
    expect(shrunk.text).toContain('Acme plans your week for you');
    expect(shrunk.text).toContain('Teams of five to fifty use it.');
    // This page is small: dropping its one footer line would save less than saying so costs, so it goes in whole.
    expect(shrunk.after).toBeLessThanOrEqual(shrunk.before);
    // A page padded the way real ones are, with a cookie banner, a menu and a footer, around the same words.
    const padded = `${UNTRUSTED}## Acme — plan your week\nhttps://acme.test/\n\n${[
      'Skip to content', 'Home', 'Pricing', 'Docs', 'Careers', 'Blog', 'Customers', 'Sign in',
      'We use cookies to give you the best experience. Read our cookie policy.', 'Accept all', 'Reject all',
      bodyText(html),
      'Share this', 'Product', 'Features', 'Integrations', 'Security', 'Company', 'About us', 'Press', 'Contact', 'Privacy', 'Terms',
      '© 2026 Acme. All rights reserved.',
    ].join('\n')}`;
    const tidy = shrinkResult('web_fetch', padded, 4500);
    console.log(`the same page with a cookie banner, a menu and a footer: ${tidy.before} characters before, ${tidy.after} after`);
    expect(tidy.after).toBeLessThan(tidy.before);
    expect(tidy.text).toContain('Acme plans your week for you');
    expect(tidy.text).not.toContain('Accept all');
    expect(tidy.text).not.toContain('Integrations');
  });
});
