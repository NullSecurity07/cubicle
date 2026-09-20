// People here answer in markdown, and Telegram has a small HTML of its own. Sent as it is, a reply lands on the
// founder's phone full of asterisks and pound signs. This turns the handful of things a person really writes (bold,
// italics, code, links, headings, bullets, rules) into what Telegram draws, and leaves everything else as plain words.
// Everything is escaped first, so nothing a person or a web page wrote can become a tag of its own.
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(text: string): string {
  // Code first, and kept aside, so nothing inside it is taken for bold or a link.
  const kept: string[] = [];
  const keep = (html: string) => `\u0000${kept.push(html) - 1}\u0000`;
  let out = text.replace(/`([^`\n]+)`/g, (_, code: string) => keep(`<code>${code}</code>`));
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, url: string) => keep(`<a href="${url.replace(/"/g, '&quot;')}">${label}</a>`));
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/__([^_\n]+)__/g, '<b>$1</b>');
  // A single star only when it hugs the words, so "2 * 3 * 4" and a bullet stay what they are.
  out = out.replace(/(^|[\s(])\*([^\s*][^*\n]*?)\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>');
  // The same with underscores, which is how a quiet aside is usually written; `snake_case_names` have no space before
  // the first one, so they are left alone.
  out = out.replace(/(^|[\s(])_([^\s_][^_\n]*?)_(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, index: string) => kept[Number(index)]);
}

export function toTelegram(markdown: string): string {
  const blocks: string[] = [];
  const keep = (html: string) => `\u0001${blocks.push(html) - 1}\u0001`;
  const escaped = escape(markdown).replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code: string) => keep(`<pre>${code.replace(/\n$/, '')}</pre>`));
  const lines = escaped.split('\n').flatMap((line) => {
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) return [];
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*$/.exec(line);
    if (heading) return [`<b>${inline(heading[1].replace(/\*\*/g, ''))}</b>`];
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) return [`${bullet[1]}• ${inline(bullet[2])}`];
    return [inline(line)];
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\u0001(\d+)\u0001/g, (_, index: string) => blocks[Number(index)]).trim();
}
