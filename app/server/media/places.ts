// Places and happenings a photograph's own title can name, which a film about something else must not borrow.
//
// Journey 13: a film about a farmers market put "Kuay Makuach, farmer, Lankien, South Sudan" (an Oxfam photograph)
// under its opening question, because "farmer" was one of the film's words. A picture whose title names a country,
// a region or an event the brief never mentions is a picture of that place or that event, not of the film's subject.
// The list is short on purpose: the countries and regions a library's titles name most, and the words for a news
// event. A place the brief or the line itself names is allowed.

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

const NAMED = new RegExp(`\\b(?:${[...PLACES, ...EVENTS].map((one) => one.replace(/ /g, '\\s+')).join('|')})\\b`, 'gi');

// The places and events a title names that the film's own words do not.
export function foreignIn(title: string, allowed: string): string[] {
  const own = (allowed ?? '').toLowerCase();
  const named = [...(title ?? '').matchAll(NAMED)].map((match) => match[0].toLowerCase().replace(/\s+/g, ' '));
  return [...new Set(named)].filter((one) => !new RegExp(`\\b${one.replace(/ /g, '\\s+')}\\b`, 'i').test(own));
}
