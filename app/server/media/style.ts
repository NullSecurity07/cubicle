// One film, one look: the words that ask for a drawing, and how a picture prompt that uses one is put back into the
// look the rest of the film is in. The critic reads every storyboard with these; they live on their own because they
// are about a film's pictures, not its writing.

// A film is shot one way. The style bible is one line of visual direction pasted in front of every picture, and it
// was meant to be enough — but a model writing six scenes will write "a 3d render of a founder" into scene four and
// the bible in front of it does not stop it, so a real fifteen-second reel came back with a cartoon character
// standing next to four photographs. Nothing reads worse: it is the one fault a stranger sees before they have read
// a word. So the words that ask for a drawing are named here, and a picture prompt that uses one is caught and put
// back into the look the rest of the film is in.
//
// A notebook film is drawn by hand on purpose, so none of this applies to it: what decides is the film's own bible,
// not our opinion of the word. A bible that says "illustration" is a film of illustrations, and every scene in it
// may say so too.
const DRAWN: RegExp[] = [
  /\bcartoons?\b/i,
  /\billustrat(?:ion|ions|ed|ive)\b/i,
  // "3-D render", "3d rendered", "3 D rendering": one thing, written five ways, and the one that made the fault.
  /\b3[\s-]?d\s*render(?:ed|ing|s)?\b/i,
  /\bcgi\b/i,
  /\banime\b/i,
  /\bcomics?\b/i,
  /\bvector\s+art\b/i,
  /\bflat\s+design\b/i,
  /\bclip\s+art\b/i,
  /\bpaintings?\b/i,
  /\bwater\s?colou?rs?\b/i,
  /\bsketch(?:es|ed|y)?\b/i,
  // "drawing on experience" and "drawing up a list" are things a person does, not things a picture is. Only the
  // noun counts, and the plural is always the noun: "drawings on the wall" are drawings.
  /\bdrawing\b(?!\s+(?:on|from|up|out|board|attention|breath|to)\b)|\bdrawings\b/i,
  // A "render" is a picture; "rendering" and "rendered" are what this tool does to a film every time it makes one,
  // so the bare noun is the only form that may be read as a style.
  /\brenders?\b/i,
];

// What a film is really shot on, and the light it is shot in. A bible that names neither is not a look, it is a
// mood word, and a picture model handed it will do whatever it likes — which is the fault this is here to stop.
const PHOTO_MEDIUM = /\b(photograph\w*|photos?|cinematograph\w*|film stills?|shot on|\d{2}\s?mm|medium format|documentary|portraits?|long lens|telephoto|macro|anamorphic|camera)\b/i;
const PHOTO_LIGHT = /\b(light\w*|lit|sunlight|daylight|backlit|shadows?|haze|glows?|glowing|golden hour|overcast|dusk|dawn|flare|contrast|exposure|silhouettes?|bright|dark\w*|moody)\b/i;

// The word in a line that asks for a drawing, as it was written, or nothing. Used on a bible to work out what kind
// of film this is, and on a scene's own prompt to work out whether it has wandered off.
export function drawnWord(text: string): string | null {
  for (const pattern of DRAWN) {
    const found = pattern.exec(text ?? '');
    if (found) return found[0].trim();
  }
  return null;
}

// Whether this film is a photographed one: it names a real medium and a real light, and it asks for nothing drawn.
export const photographic = (bible: string): boolean =>
  !drawnWord(bible ?? '') && PHOTO_MEDIUM.test(bible ?? '') && PHOTO_LIGHT.test(bible ?? '');

// What the film is made of, in the two forms a prompt needs it: "a photograph OF a founder" and "a photographED
// founder". The bible is written in adjectives — "editorial photography" — and a scene needs the thing itself, so
// the medium the bible names is turned back into a noun and the verb that goes with it.
const mediumOf = (bible: string): { noun: string; shot: string } =>
  (/cinemat|film still/i.test(PHOTO_MEDIUM.exec(bible)?.[0] ?? '')
    ? { noun: 'film still', shot: 'filmed' }
    : { noun: 'photograph', shot: 'photographed' });

// The word a picture prompt uses to ask for a look this film is not in, or nothing. A film that is drawn by hand
// allows all of them, because in that film they are the look.
export const offStyle = (prompt: string, bible: string): string | null =>
  (photographic(bible) ? drawnWord(prompt ?? '') : null);

// The same prompt, in the film's own look: every word that asked for a drawing is replaced by what the bible says
// this film is made of. Nothing else about the line is touched, because the subject was never the problem.
export function inStyle(prompt: string, bible: string): string {
  if (!prompt?.trim() || !photographic(bible)) return prompt;
  const { noun, shot } = mediumOf(bible);
  let said = prompt;
  // "a cartoon of a founder" is a thing; "a cartoon founder" is a way of being one. Which of the two words goes in
  // is decided by whether an "of" follows, because "a photograph founder" is not English and a picture model reads
  // a prompt the way a person does.
  for (const pattern of DRAWN) {
    said = said.replace(new RegExp(`(?:${pattern.source})(\\s+of\\b)?`, 'gi'), (_, of: string | undefined) => (of ? `${noun}${of}` : shot));
  }
  // A prompt that named two drawn looks in a row — "a 3d render cartoon of a desk" — would otherwise ask for the
  // same photograph twice. The last of the run is the one beside the subject, so that is the one that stays.
  const both = `\\b(?:${noun}|${shot})\\b`;
  return said
    .replace(new RegExp(`${both}(?:[\\s,]+${both})+`, 'gi'), (run) => run.trim().split(/[\s,]+/).at(-1) ?? run)
    .replace(/\s{2,}/g, ' ').replace(/\s+([,.])/g, '$1').trim();
}
