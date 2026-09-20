// A lesson is not a log, and saying so in the instruction is not enough: a small free model, asked what it learned
// from one job, writes down that job. These are the three ways it does that which code can see — it names the
// founder's own documents and people, it copies the words of the one piece of work in front of it, and it writes
// steps nobody took. Each is refused with the reason in plain words, which `completeJson` puts back to the model for
// its one correction turn, so the usual end of a bad first answer is a better second one.
export type Lesson = { name: string; when: string; procedure: string[]; pitfalls: string[]; verify: string };
// What the lesson came out of: what is on this stage and may not be named, the words of the work, and how many calls
// were really made. `asked` is empty for a conversation, where the founder's own words are the lesson and using
// them is the whole point.
export type Ground = { names: string[]; asked: string; calls: number };

// The words everybody uses, which say nothing about what a piece of work was. What is left is what makes it that job.
const COMMON = new Set(('a about after again all also an and any are as at back be been before being but by can could did do does doing done down each even every '
  + 'first for from get give go going had has have he her here him his how i if in into is it its just like make making may me more most my need needs new no not now '
  + 'of off on once one only or other our out over own put said same say see she should so some still such take than that the their them then there these they thing '
  + 'things this those through to too two up us use used using very want was way we well were what when where which while who why will with within would you your').split(' '));
const RUN = 3;
const words = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length > 1 && !COMMON.has(word));
const loose = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Every three words in a row, once the small words are out of the way: what is left of a phrase is what was distinctive about it.
const runs = (text: string) => {
  const said = words(text);
  const found = new Set<string>();
  for (let at = 0; at + RUN <= said.length; at += 1) found.add(said.slice(at, at + RUN).join(' '));
  return found;
};

// A run of two tool calls cannot have taught a seven-step procedure; the other five steps were imagined.
export const mostSteps = (calls: number) => Math.max(3, calls + 2);

// Throws the reason this is not a lesson, in words meant for the model to act on. `whole` is false for a patch,
// where only the lines being changed are in hand and the length of the finished procedure is not.
export function checkLesson(lesson: Partial<Lesson>, ground: Ground, whole = true): void {
  const said = [lesson.name, lesson.when, ...(lesson.procedure ?? []), ...(lesson.pitfalls ?? []), lesson.verify].filter((one): one is string => !!one);
  // Every one of them at once. Named one at a time, a model that used two of them fixes the first, is refused for
  // the second and has run out of turns — which is how a good lesson was lost on a live run.
  const named = ground.names.map((name) => name.trim()).filter((name) => name.length >= 3
    && said.some((line) => new RegExp(`(^|[^\\p{L}\\p{N}])${loose(name)}($|[^\\p{L}\\p{N}])`, 'iu').test(line)));
  if (named.length) {
    throw new Error(`${named.map((name) => `"${name}"`).join(' and ')} ${named.length > 1 ? 'are names' : 'is the name'} of a document, a card or a person on this stage, and a skill has to fit the next case too. `
      + `Say what kind of thing ${named.length > 1 ? 'each' : 'it'} is, not what this one is called, and take out every one of them`);
  }
  // A skill is read back into prompts for as long as it exists, so a year written into one goes wrong the moment the
  // year turns — and the run that taught it usually had a year in its searches for the learner to copy.
  const dated = [...new Set(said.flatMap((line) => line.match(/\b(?:19|20)\d{2}\b/g) ?? []))];
  if (dated.length) {
    throw new Error(`${dated.map((year) => `"${year}"`).join(' and ')} ${dated.length > 1 ? 'are years' : 'is a year'}, and a skill has to be as right next year as it is today. `
      + 'Say it in words that stay true — "this year", "the current figures", "the newest version" — and take every year out');
  }
  if (ground.asked) {
    const taken = runs(ground.asked);
    for (const line of [lesson.name, lesson.when].filter((one): one is string => !!one)) {
      const copied = [...runs(line)].find((phrase) => taken.has(phrase));
      if (copied) throw new Error(`"${copied}" is taken word for word out of this one piece of work. Write it for the next, different case instead — a different product and a different document — and say what kind of work it is, not which job this was`);
    }
  }
  if (whole && lesson.procedure && lesson.procedure.length > mostSteps(ground.calls)) {
    throw new Error(`there are ${lesson.procedure.length} steps: only write steps that were really done. ${ground.calls} tool calls were made, so write at most ${mostSteps(ground.calls)} steps and leave out anything nobody did`);
  }
}
