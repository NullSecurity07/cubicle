// Who sounds like whom. These rules sit between the server that says the words out loud and the form where the
// founder changes them, so the two can never disagree about how somebody sounds.
// The list of voices is handed in rather than imported: it lives with the model in `server/media/voice.ts`, and a
// window that imported that file would drag the whole voice model into the browser with it. The server passes
// `VOICES`; the window passes what `/api/media/voices` answered, which is the same list.
export type Gender = 'woman' | 'man' | 'neither';
// `grade` is how good the model's own table says a voice is ("A", "C+"); the list the server hands out carries it.
export type Voice = { id: string; name: string; grade?: string };
// Who put a voice on a person: the founder, by picking it, or the app, by casting it. A voice with no word on it was
// cast, because the founder's pick has always been written down as it was made.
export type VoiceBy = 'founder' | 'cast';
// Only the part of a person this needs, so these rules read a room without knowing what else is on one.
export type Speaker = { id: string; name: string; gender?: Gender; voice?: string; voiceBy?: VoiceBy };

// How good a grade is as one number, so voices sort without a table of special cases. A voice with no grade at all
// sorts below every graded one.
export const gradeRank = (grade: string | undefined): number => {
  if (!grade) return -1;
  const letters = 'FEDCBA';
  const at = letters.indexOf(grade[0]?.toUpperCase() ?? 'F');
  const sign = grade.includes('+') ? 0.33 : grade.includes('-') ? -0.33 : 0;
  return (at < 0 ? 0 : at) + sign;
};
// The line a voice the app picks on its own may not fall below. A woman is given nothing under B-: Heart, Bella, Emma
// and Nicole. Every man in Kokoro grades C+ or worse, so a man is given one of the best three there are, which today
// is Fenrir, Michael and Puck. A founder can still pick any voice by hand; this only binds the app.
export const WOMAN_FLOOR = 'B-';
export const MEN_KEPT = 3;

// Three plain options, in the founder's words, in one place: the form shows them and nothing else has to spell them.
export const GENDERS: { value: Gender; label: string }[] = [
  { value: 'woman', label: 'A woman' }, { value: 'man', label: 'A man' }, { value: 'neither', label: 'Neither / not said' },
];

// The voices' own names say which they are ("Emma · British woman"), so the two pools are read off the model's list
// rather than kept a second time here, where they would quietly drift apart from it.
// Each pool is best first, so the form's list opens on the voices worth hearing.
export const poolsOf = (voices: readonly Voice[]) => {
  const best = (test: RegExp) => voices.filter((voice) => test.test(voice.name))
    .sort((one, two) => gradeRank(two.grade) - gradeRank(one.grade)).map((voice) => voice.id);
  return { woman: best(/ woman$/), man: best(/ man$/) };
};
// The voices the app may cast for each gender on its own: a woman's at B- or better, a man's the best three. A list
// that carries no grades at all (an old window's) leaves the pools whole rather than empty.
export function castablesOf(voices: readonly Voice[]) {
  const pools = poolsOf(voices);
  const gradeOf = new Map(voices.map((voice) => [voice.id, gradeRank(voice.grade)]));
  const graded = voices.some((voice) => voice.grade);
  const woman = graded ? pools.woman.filter((id) => (gradeOf.get(id) ?? -1) >= gradeRank(WOMAN_FLOOR) - 0.01) : pools.woman;
  const third = gradeOf.get(pools.man[MEN_KEPT - 1] ?? '') ?? -1;
  const man = graded ? pools.man.filter((id) => (gradeOf.get(id) ?? -1) >= third) : pools.man;
  return { woman: woman.length ? woman : pools.woman, man: man.length ? man : pools.man, gradeOf };
}
// Whether the app could have cast this voice for somebody of this gender under today's rule.
export function castable(voice: string | undefined, gender: Gender, voices: readonly Voice[]): boolean {
  const { woman, man } = castablesOf(voices);
  return !!voice && (gender === 'woman' ? woman : gender === 'man' ? man : [...woman, ...man]).includes(voice);
}
export const voiceNamed = (id: string | undefined, voices: readonly Voice[]) => voices.find((voice) => voice.id === id)?.name ?? '';

// A modest list of given names from the places people are named after, the founder's own India included. It is only
// a guess: it is shown the moment they type a name and one press changes it. So a name that is genuinely either —
// Sam, Alex, Kiran, Jordan, Noor, Ali, Devon — is deliberately in neither list, and anything unknown is 'neither'
// too. Nobody is given a voice on the strength of a name this does not know.
const WOMEN = new Set([
  'maya', 'priya', 'ananya', 'aisha', 'ayesha', 'neha', 'pooja', 'divya', 'kavya', 'meera', 'riya', 'anjali', 'shreya',
  'nisha', 'deepa', 'lakshmi', 'sita', 'radha', 'aarti', 'ishita', 'sneha', 'tara', 'rhea', 'simran', 'nandini',
  'sara', 'sarah', 'emma', 'olivia', 'sophia', 'sofia', 'sophie', 'mia', 'isabella', 'ava', 'grace', 'hannah', 'chloe',
  'lucy', 'anna', 'elena', 'maria', 'laura', 'clara', 'julia', 'nina', 'rosa', 'ruth', 'esther', 'alice', 'lily',
  'ella', 'amelia', 'charlotte', 'fatima', 'zara', 'leila', 'layla', 'amina', 'mei', 'ling', 'yuki', 'sakura',
  'amara', 'nia', 'ines', 'valentina', 'camila', 'carmen', 'nour',
]);
const MEN = new Set([
  'arjun', 'rahul', 'rohan', 'vikram', 'amit', 'ravi', 'sanjay', 'aditya', 'karan', 'nikhil', 'raj', 'suresh', 'anil',
  'manish', 'gaurav', 'akash', 'dev', 'vivek', 'ankit', 'rajesh', 'pranav', 'siddharth', 'varun', 'aryan', 'kunal',
  'ishaan', 'sameer', 'james', 'john', 'michael', 'david', 'daniel', 'thomas', 'william', 'robert', 'peter', 'paul',
  'mark', 'luke', 'adam', 'noah', 'liam', 'ethan', 'henry', 'george', 'oliver', 'jack', 'harry', 'leo', 'max', 'felix',
  'lucas', 'mateo', 'diego', 'carlos', 'juan', 'marco', 'pablo', 'omar', 'ahmed', 'hassan', 'yusuf', 'ibrahim',
  'hiroshi', 'kenji', 'kwame', 'mustafa',
]);
export const guessGender = (name: string): Gender => {
  const first = name.trim().toLowerCase().split(/[\s.,_-]+/)[0] ?? '';
  return WOMEN.has(first) ? 'woman' : MEN.has(first) ? 'man' : 'neither';
};

// A person's own order over the voices, decided by their id and nothing else: the same order today, tomorrow, and in
// a window that has never seen the rest of the stage. FNV-1a, because this has to run the same in the browser and
// on the server and a hash is all it is.
const hashOf = (text: string) => {
  let sum = 2_166_136_261;
  for (let at = 0; at < text.length; at += 1) { sum ^= text.charCodeAt(at); sum = Math.imul(sum, 16_777_619); }
  return sum >>> 0;
};
// Best grade first; among voices as good as each other, the person's own order.
const ranked = (id: string, pool: readonly string[], gradeOf: Map<string, number>) => [...pool]
  .sort((one, two) => (gradeOf.get(two) ?? -1) - (gradeOf.get(one) ?? -1) || hashOf(`${id}:${one}`) - hashOf(`${id}:${two}`));

// Which voice this person speaks in.
//
// Their own, when one is written down on them and it is still a voice the model has. Otherwise the app casts one from
// the voices it may give their gender (`castablesOf`): the one fewest people on the stage already speak in, the best
// grade among those, and the person's own order, decided by their id alone, among voices of the same grade. So the
// first woman is Heart, and two people share a voice only once the good ones have all been given out once. The rare
// case of two wanting the same voice first is settled by who is on the stage first, which never changes for anyone
// already there.
// What makes it permanent is not this function: it is that the voice is written down on the person the first time it
// is asked for. From then on it is theirs, whoever else joins or leaves.
export function voiceFor(room: Speaker, everyone: readonly Speaker[], voices: readonly Voice[]): string {
  const known = new Set(voices.map((voice) => voice.id));
  if (room.voice && known.has(room.voice)) return room.voice;
  const { woman, man, gradeOf } = castablesOf(voices);
  const both = [...woman, ...man];
  const used = new Map<string, number>();
  let mine = '';
  for (const other of everyone.some((person) => person.id === room.id) ? everyone : [...everyone, room]) {
    // The person asked about is taken as they were handed in, not as the stage still has them: the form asks this
    // again on every keystroke, before any of it has been saved.
    const one = other.id === room.id ? room : other;
    const gender = one.gender ?? guessGender(one.name);
    const pool = gender === 'woman' ? woman : gender === 'man' ? man : both;
    if (one.voice && known.has(one.voice)) mine = one.voice;
    else {
      const order = ranked(one.id, pool, gradeOf);
      const least = Math.min(...order.map((id) => used.get(id) ?? 0));
      mine = order.find((id) => (used.get(id) ?? 0) === least) ?? '';
    }
    if (one.id === room.id) break;
    used.set(mine, (used.get(mine) ?? 0) + 1);
  }
  return mine;
}

// The people whose voice the app cast below today's rule, cast again in stage order; a voice the founder picked is
// never touched. Returns the stage's people as they should now be, and who changed from what to what.
export function recast<T extends Speaker>(rooms: readonly T[], voices: readonly Voice[]): { rooms: T[]; changed: { name: string; from: string; to: string }[] } {
  const stale = (one: T) => one.voiceBy !== 'founder' && !!one.voice && !castable(one.voice, one.gender ?? guessGender(one.name), voices);
  if (!rooms.some(stale)) return { rooms: [...rooms], changed: [] };
  let out: T[] = rooms.map((one) => (stale(one) ? { ...one, voice: undefined } : one));
  const changed: { name: string; from: string; to: string }[] = [];
  for (const [at, before] of rooms.entries()) {
    if (!stale(before)) continue;
    const to = voiceFor(out[at], out, voices);
    out = out.map((one, index) => (index === at ? { ...one, voice: to, voiceBy: 'cast' as const } : one));
    changed.push({ name: before.name, from: before.voice!, to });
  }
  return { rooms: out, changed };
}
