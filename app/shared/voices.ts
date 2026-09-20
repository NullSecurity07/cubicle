// Who sounds like whom. These rules sit between the server that says the words out loud and the form where the
// founder changes them, so the two can never disagree about how somebody sounds.
// The list of voices is handed in rather than imported: it lives with the model in `server/media/voice.ts`, and a
// window that imported that file would drag the whole voice model into the browser with it. The server passes
// `VOICES`; the window passes what `/api/media/voices` answered, which is the same list.
export type Gender = 'woman' | 'man' | 'neither';
export type Voice = { id: string; name: string };
// Only the part of a person this needs, so these rules read a room without knowing what else is on one.
export type Speaker = { id: string; name: string; gender?: Gender; voice?: string };

// Three plain options, in the founder's words, in one place: the form shows them and nothing else has to spell them.
export const GENDERS: { value: Gender; label: string }[] = [
  { value: 'woman', label: 'A woman' }, { value: 'man', label: 'A man' }, { value: 'neither', label: 'Neither / not said' },
];

// The voices' own names say which they are ("Emma · British woman"), so the two pools are read off the model's list
// rather than kept a second time here, where they would quietly drift apart from it.
export const poolsOf = (voices: readonly Voice[]) => ({
  woman: voices.filter((voice) => / woman$/.test(voice.name)).map((voice) => voice.id),
  man: voices.filter((voice) => / man$/.test(voice.name)).map((voice) => voice.id),
});
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
const ranked = (id: string, pool: readonly string[]) => [...pool].sort((one, two) => hashOf(`${id}:${one}`) - hashOf(`${id}:${two}`));

// Which voice this person speaks in.
//
// Their own, when the founder picked one and it is still a voice the model has. Otherwise everybody ranks the voices
// their gender draws from in the order their id alone decides, and each takes the first that nobody before them on
// the stage has taken — so two people never share a voice while the pool lasts, and the rare case of two wanting the
// same one first is settled by who is on the stage first, which never changes for anyone already there.
// What makes it permanent is not this function: it is that the voice is written down on the person the first time it
// is asked for. From then on it is theirs, whoever else joins or leaves.
export function voiceFor(room: Speaker, everyone: readonly Speaker[], voices: readonly Voice[]): string {
  const known = new Set(voices.map((voice) => voice.id));
  if (room.voice && known.has(room.voice)) return room.voice;
  const pools = poolsOf(voices);
  const both = [...pools.woman, ...pools.man];
  const taken = new Set<string>();
  let mine = '';
  for (const other of everyone.some((person) => person.id === room.id) ? everyone : [...everyone, room]) {
    // The person asked about is taken as they were handed in, not as the stage still has them: the form asks this
    // again on every keystroke, before any of it has been saved.
    const one = other.id === room.id ? room : other;
    const gender = one.gender ?? guessGender(one.name);
    const pool = gender === 'neither' ? both : pools[gender];
    // A pool that has run dry draws from the whole list; only when that is dry too does anybody share a voice.
    mine = one.voice && known.has(one.voice) ? one.voice
      : ranked(one.id, pool).find((id) => !taken.has(id)) ?? ranked(one.id, both).find((id) => !taken.has(id)) ?? ranked(one.id, both)[0] ?? '';
    if (one.id === room.id) break;
    taken.add(mine);
  }
  return mine;
}
