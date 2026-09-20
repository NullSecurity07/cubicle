import { describe, expect, it } from 'vitest';
import { mediaOf, toTelegram } from './format.ts';

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

  it('draws a picture written for the app as the link it is on a phone, not as a stray exclamation mark', () => {
    expect(toTelegram('![the cover](https://example.com/cover.png)')).toBe('<a href="https://example.com/cover.png">the cover</a>');
  });

  it('keeps the real draft that showed the problem readable', () => {
    const said = toTelegram('**Instagram Draft – Founder‑Friendly Events**\n\n---\n\n🚀 **Calling all founders!**\n- **Founders Meetup** – Sep 12');
    expect(said).toBe('<b>Instagram Draft – Founder‑Friendly Events</b>\n\n🚀 <b>Calling all founders!</b>\n• <b>Founders Meetup</b> – Sep 12');
    expect(said).not.toContain('**');
  });
});

describe('the pictures and the files in a reply', () => {
  it('takes a picture out of the words altogether and hands the file over', () => {
    expect(mediaOf('Made the picture.\n\n![a cat on a roof](/api/files/media/cat.png)')).toEqual({
      text: 'Made the picture.',
      files: [{ path: 'media/cat.png', label: 'a cat on a roof' }],
    });
  });

  it('leaves a file link as the words it was written as, because the link itself is no use on a phone', () => {
    expect(mediaOf('Made the film.\n\n[Launch day](/api/files/media/launch.mp4)')).toEqual({
      text: 'Made the film.\n\nLaunch day',
      files: [{ path: 'media/launch.mp4', label: 'Launch day' }],
    });
  });

  it('takes a picture and a recording out of one reply and leaves a real web link alone', () => {
    const { text, files } = mediaOf('Here it is:\n\n![the poster](/api/files/media/poster.png)\n\n[the words](/api/files/media/said.wav)\n\nand [the page](https://example.com/a).');
    expect(text).toBe('Here it is:\n\nthe words\n\nand [the page](https://example.com/a).');
    expect(files).toEqual([{ path: 'media/poster.png', label: 'the poster' }, { path: 'media/said.wav', label: 'the words' }]);
  });

  it('reads the path as it was written in the link', () => {
    expect(mediaOf('![one](/api/files/media/a%20cat%20%26%20dog.png)').files).toEqual([{ path: 'media/a cat & dog.png', label: 'one' }]);
  });

  it('hands over nothing that points anywhere but the shared files', () => {
    expect(mediaOf('![x](/api/files/../../.ssh/id_rsa)').files).toEqual([]);
    expect(mediaOf('![x](/api/files//etc/passwd)').files).toEqual([]);
    expect(mediaOf('![x](/api/files/media/%2e%2e/%2e%2e/secret.env)').files).toEqual([]);
  });

  it('sends one file once, however often it is named, and never more than ten', () => {
    const twice = mediaOf('![one](/api/files/media/cat.png)\n\n![again](/api/files/media/cat.png)');
    expect(twice.files).toEqual([{ path: 'media/cat.png', label: 'one' }]);
    const many = mediaOf(Array.from({ length: 14 }, (_, at) => `![p${at}](/api/files/media/p${at}.png)`).join('\n\n'));
    expect(many.files).toHaveLength(10);
    expect(many.files[0].path).toBe('media/p0.png');
  });

  it('leaves a reply with nothing in it but a picture with no words at all', () => {
    expect(mediaOf('![the cover](/api/files/media/cover.png)')).toEqual({ text: '', files: [{ path: 'media/cover.png', label: 'the cover' }] });
  });
});
