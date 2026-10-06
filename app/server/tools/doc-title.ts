// A doc's title as the founder reads it on its card: a short name, never the ask it was written for. A model often
// hands the whole request over as the title ("Write me a doc about our pricing in 400 words", "Customer notes: what we
// actually know about our beta studios"); what is left is a noun phrase of at most six words.
const MOST = 6;
const ASKING = /^(?:(?:please|can you|could you|would you|i need you to|i want you to|help me|let'?s)\s+)*(?:(?:write|make|draft|create|put together|prepare|produce|build|give|send|do|start|compose|generate|outline|sketch|jot down)\s+)(?:(?:me|us|up|out)\s+)*/i;
const ARTICLE = /^(?:(?:a|an|the|some|our|my|one|short|quick|brief|new|simple)\s+)+/i;
const KIND = /^(?:\d+[- ]?(?:words?|pages?)\s+)?(?:doc(?:ument)?|note|notes|memo|page|write-?up|summary|draft|file|card)\s+(?:about|on|for|of|covering|called|named|titled|listing|with|that)\s+/i;
const COUNT = /\b(?:in\s+|of\s+|about\s+|around\s+|under\s+|max(?:imum)?\s+|at most\s+|no more than\s+|~\s*)?\d[\d,]*\s*(?:-\s*)?(?:words?|pages?|lines?|paragraphs?|bullets?|sentences?)\b(?:\s+(?:long|max|or less|or fewer))?/gi;
const LOOSE_END = /\s+(?:of|and|or|the|for|with|about|to|in|on|a|an|at|by|from|our|my|that|which|so|as)$/i;

export function docTitle(raw: string): string {
  let title = raw.replace(/\s+/g, ' ').trim().replace(/^["'“‘]+|["'”’]+$/g, '').trim();
  title = title.replace(COUNT, ' ').replace(/\(\s*\)/g, ' ').replace(/\s+/g, ' ').trim();
  title = title.replace(ASKING, '').replace(ARTICLE, '').replace(KIND, '').replace(ARTICLE, '');
  // The name before a colon or a dash is the name; what follows says what is in it.
  const [head] = title.split(/\s*(?::|\s[-–—]\s)\s*/);
  if (head && head.trim().split(' ').length <= MOST && head.trim().length > 1) title = head;
  title = title.replace(/[.!?,;:]+$/g, '').trim();
  const words = title.split(' ').filter(Boolean).slice(0, MOST);
  title = words.join(' ');
  while (LOOSE_END.test(title)) title = title.replace(LOOSE_END, '');
  title = title.replace(/[.!?,;:]+$/g, '').trim();
  if (!title) return raw.trim().split(/\s+/).slice(0, MOST).join(' ') || 'Untitled';
  return title[0].toUpperCase() + title.slice(1);
}
