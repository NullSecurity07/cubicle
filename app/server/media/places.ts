// Places and happenings a photograph's own title can name, which a film about something else must not borrow.
//
// Journey 13: a film about a farmers market put "Kuay Makuach, farmer, Lankien, South Sudan" (an Oxfam photograph)
// under its opening question, because "farmer" was one of the film's words. A picture whose title names a country,
// a region or an event the brief never mentions is a picture of that place or that event, not of the film's subject.
// The list is short on purpose: the countries and regions a library's titles name most, and the words for a news
// event. Any other name a title gives is caught by its capital (`namesInTitle`). A place the brief or the line itself
// names is allowed.

const PLACES = [
  'afghanistan', 'albania', 'algeria', 'angola', 'argentina', 'armenia', 'australia', 'austria', 'azerbaijan', 'bangladesh',
  'belarus', 'belgium', 'benin', 'bolivia', 'bosnia', 'botswana', 'brazil', 'bulgaria', 'burkina faso', 'burundi', 'cambodia',
  'cameroon', 'canada', 'chad', 'chile', 'china', 'colombia', 'congo', 'costa rica', 'croatia', 'cuba', 'cyprus', 'czechia',
  'denmark', 'dominica', 'ecuador', 'egypt', 'el salvador', 'eritrea', 'estonia', 'ethiopia', 'fiji', 'finland', 'france',
  'gabon', 'gambia', 'gaza', 'georgia', 'germany', 'ghana', 'greece', 'guatemala', 'guinea', 'haiti', 'honduras', 'hungary',
  'iceland', 'india', 'indonesia', 'iran', 'iraq', 'ireland', 'israel', 'italy', 'jamaica', 'japan', 'jordan', 'kazakhstan',
  'kenya', 'korea', 'kosovo', 'kuwait', 'kyrgyzstan', 'laos', 'latvia', 'lebanon', 'lesotho', 'liberia', 'libya', 'lithuania',
  'madagascar', 'malawi', 'malaysia', 'mali', 'mauritania', 'mexico', 'moldova', 'mongolia', 'morocco', 'mozambique', 'myanmar',
  'namibia', 'nepal', 'netherlands', 'new zealand', 'nicaragua', 'niger', 'nigeria', 'norway', 'oman', 'pakistan', 'palestine',
  'panama', 'papua', 'paraguay', 'peru', 'philippines', 'poland', 'portugal', 'qatar', 'romania', 'russia', 'rwanda',
  'saudi arabia', 'senegal', 'serbia', 'sierra leone', 'singapore', 'slovakia', 'slovenia', 'somalia', 'south africa',
  'south sudan', 'spain', 'sri lanka', 'sudan', 'sweden', 'switzerland', 'syria', 'taiwan', 'tajikistan', 'tanzania',
  'thailand', 'togo', 'tunisia', 'turkey', 'turkmenistan', 'uganda', 'ukraine', 'united kingdom', 'united states', 'uruguay',
  'uzbekistan', 'venezuela', 'vietnam', 'yemen', 'zambia', 'zimbabwe',
  'africa', 'asia', 'europe', 'antarctica', 'balkans', 'caribbean', 'darfur', 'kashmir', 'sahel', 'siberia', 'tibet',
  'beirut', 'kabul', 'kyiv', 'baghdad', 'damascus', 'mogadishu', 'pyongyang', 'tehran',
];
// The words for a news event rather than a place or a thing: a photograph of one is a photograph of that day.
const EVENTS = ['war', 'protest', 'protests', 'riot', 'riots', 'refugee', 'refugees', 'explosion', 'bombing', 'earthquake',
  'flood', 'flooding', 'famine', 'hurricane', 'cyclone', 'massacre', 'troops', 'military', 'army', 'soldiers', 'election',
  'elections', 'funeral', 'crash', 'disaster', 'conflict', 'crisis', 'shelling', 'evacuation', 'drought'];

// Landmarks: a photograph of a city hall, a cathedral or a shopping mall is of that building, whatever its tags share
// with the film. Journey 15's film about a marketplace for idle 3D printers was handed "Old marketplace and city hall in
// Poznań" and "International Marketplace - Waikiki" because "marketplace" was one of its words.
const LANDMARKS = ['city hall', 'town hall', 'market square', 'town square', 'old town', 'cathedral', 'basilica', 'church',
  'mosque', 'temple', 'palace', 'castle', 'monument', 'mall', 'shopping mall', 'shopping centre', 'shopping center', 'plaza',
  'skyline', 'downtown', 'harbour', 'harbor', 'boulevard'];

const NAMED = new RegExp(`\\b(?:${[...PLACES, ...EVENTS, ...LANDMARKS].map((one) => one.replace(/ /g, '\\s+')).join('|')})\\b`, 'gi');

// Capitalised words that are not somebody's or somewhere's name.
const NOT_NAMES = new Set(['i', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january',
  'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'mr', 'mrs',
  'ms', 'dr', 'the', 'a', 'an', 'my', 'our', 'photo', 'image', 'picture', 'flickr', 'wikimedia', 'commons', 'creative']);
// What comes before a name: a separator in a title ("International Marketplace - Waikiki", "farmer, Lankien") or a
// word that puts a thing somewhere ("city hall in Poznań").
const BEFORE_NAME = /^(?:[-–—|(:,]|in|at|near|from|outside|inside)$/i;

// The proper names a title gives that the film's words do not: a capitalised word in the middle of a sentence ("city
// hall in Poznań"), after a separator ("International Marketplace - Waikiki"), or spelt with letters English does not
// use. A list of places can never be long enough; a library's titles name every town on earth. A title written in
// Title Case is read for the names after a separator or a place word only, since every word in it has a capital.
export function namesInTitle(title: string): string[] {
  const tokens = (title ?? '').replace(/([-–—|(:])/g, ' $1 ').split(/\s+/).filter(Boolean);
  const names: string[] = [];
  tokens.forEach((token, at) => {
    const word = token.replace(/^[^\p{L}]+|[^\p{L}'-]+$/gu, '');
    if (at === 0 || !/^\p{Lu}\p{Ll}/u.test(word) || NOT_NAMES.has(word.toLowerCase())) return;
    const before = tokens[at - 1];
    if (/[.!?]$/.test(before)) return;
    const lowerBefore = /^\p{Ll}[\p{Ll}'-]*$/u.test(before);
    const separated = /,$/.test(before) || BEFORE_NAME.test(before.replace(/,$/, ''));
    const foreign = /[^\x00-\x7F]/.test(word);
    if (lowerBefore || separated || foreign) names.push(word.toLowerCase());
  });
  return [...new Set(names)];
}

const stemOf = (word: string) => word.replace(/(?:'s|s)$/, '');

// The places, landmarks, events and names a title has that the film's own words do not.
export function foreignIn(title: string, allowed: string): string[] {
  const own = (allowed ?? '').toLowerCase();
  const said = new Set(own.split(/[^\p{L}\p{N}'-]+/u).filter(Boolean).map(stemOf));
  const named = [...(title ?? '').matchAll(NAMED)].map((match) => match[0].toLowerCase().replace(/\s+/g, ' '));
  const listed = [...new Set(named)].filter((one) => !new RegExp(`\\b${one.replace(/ /g, '\\s+')}\\b`, 'i').test(own));
  const names = namesInTitle(title).filter((one) => !said.has(stemOf(one)) && !listed.includes(one));
  return [...listed, ...names];
}
