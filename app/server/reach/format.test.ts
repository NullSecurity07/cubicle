import { describe, expect, it } from 'vitest';
import { toTelegram } from './format.ts';

describe('what a reply looks like on the founder\'s phone', () => {
  it('draws what a person really writes, and leaves plain words alone', () => {
    expect(toTelegram('Paired. Write to me here.')).toBe('Paired. Write to me here.');
    expect(toTelegram('## Launch plan\n\n**Bold** and *soft*, with `code` and [a page](https://example.com/a?b=1).'))
      .toBe('<b>Launch plan</b>\n\n<b>Bold</b> and <i>soft</i>, with <code>code</code> and <a href="https://example.com/a?b=1">a page</a>.');
    expect(toTelegram('- one\n- **two**\n\n---\n\n* three')).toBe('• one\n• <b>two</b>\n\n• three');
    expect(toTelegram('```js\nconst a = 1 < 2;\n```')).toBe('<pre>const a = 1 &lt; 2;</pre>');
  });

  it('never lets what somebody wrote become a tag, and does not take arithmetic for italics', () => {
    expect(toTelegram('<b>hi</b> & <script>x</script>')).toBe('&lt;b&gt;hi&lt;/b&gt; &amp; &lt;script&gt;x&lt;/script&gt;');
    expect(toTelegram('2 * 3 * 4 is 24')).toBe('2 * 3 * 4 is 24');
    expect(toTelegram('`**not bold**` and [not a link](javascript:alert(1))')).toBe('<code>**not bold**</code> and [not a link](javascript:alert(1))');
    expect(toTelegram('snake_case_name stays')).toBe('snake_case_name stays');
    // The aside under the morning note, exactly as it reached the founder's phone with its underscores showing.
    expect(toTelegram('Everything is quiet.\n\n_1 turn, 13.1k in and 409 out. All of it on free allowances._'))
      .toBe('Everything is quiet.\n\n<i>1 turn, 13.1k in and 409 out. All of it on free allowances.</i>');
    expect(toTelegram('see my_file_name.ts and _this_ too')).toBe('see my_file_name.ts and <i>this</i> too');
  });

  it('keeps the real draft that showed the problem readable', () => {
    const said = toTelegram('**Instagram Draft – Founder‑Friendly Events**\n\n---\n\n🚀 **Calling all founders!**\n- **Founders Meetup** – Sep 12');
    expect(said).toBe('<b>Instagram Draft – Founder‑Friendly Events</b>\n\n🚀 <b>Calling all founders!</b>\n• <b>Founders Meetup</b> – Sep 12');
    expect(said).not.toContain('**');
  });
});
