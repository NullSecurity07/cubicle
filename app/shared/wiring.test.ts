import { describe, expect, it } from 'vitest';
import * as server from '../server/media/video.ts';
import type { Card, Stage } from './model.ts';
import { docsFor, filmSays, sourcesFor, wiredTo } from './wiring.ts';

const box = { x: 0, y: 0, w: 100, h: 100 };
const cards: Card[] = [
  { id: 'film', kind: 'videogen', ...box },
  { id: 'studio', kind: 'imagegen', ...box },
  { id: 'pic', kind: 'image', path: 'media/launch.png', ...box },
  { id: 'empty-pic', kind: 'image', ...box },
  { id: 'feeder', kind: 'imagegen', ...box },
  { id: 'note', kind: 'note', text: 'Tagline: less, sooner', ...box },
  { id: 'blank-note', kind: 'note', text: '  ', ...box },
  { id: 'link', kind: 'link', url: 'https://example.com', title: 'Example', ...box },
  { id: 'browser', kind: 'browser', ...box },
  { id: 'idle-browser', kind: 'browser', ...box },
  { id: 'code', kind: 'project', path: '/home/me/code/shop/', ...box },
  { id: 'leads', kind: 'leads', ...box },
  { id: 'kept', kind: 'library', noteId: 'n1', ...box },
  { id: 'unpicked', kind: 'library', noteId: '', ...box },
  { id: 'site', kind: 'source', url: 'https://www.startups.rip/list', about: 'dead startups', ...box },
  { id: 'their-browser', kind: 'browser', ...box },
];
const wire = (from: string, to: string) => ({ id: `${from}-${to}`, from, fromHandle: 'r', to, toHandle: 'l' });
const stage: Stage = {
  rooms: [{ id: 'maya', name: 'Maya', role: 'Marketing', accent: '#fff', brief: '', ...box }],
  docs: [{ id: 'brief', title: 'Company brief', ...box }, { id: 'other', title: 'Other doc', ...box }],
  cards,
  wires: [
    wire('film', 'studio'), wire('pic', 'film'), wire('film', 'empty-pic'), wire('feeder', 'empty-pic'), wire('film', 'note'),
    wire('blank-note', 'film'), wire('film', 'link'), wire('film', 'browser'), wire('film', 'idle-browser'), wire('film', 'code'),
    wire('film', 'leads'), wire('film', 'brief'), wire('maya', 'other'), wire('maya', 'note'),
    wire('film', 'kept'), wire('film', 'unpicked'), wire('film', 'site'),
  ],
};

describe('what a film may draw on', () => {
  it('is worked out exactly as the server works it out', () => {
    for (const [cardId, roomId] of [['film', undefined], ['film', 'maya'], [undefined, 'maya'], ['empty-pic', undefined]] as const) {
      expect(sourcesFor(stage, cardId, roomId)).toEqual(server.sourcesFor(stage, cardId, roomId));
      expect(docsFor(stage, cardId, roomId)).toEqual(server.docsFor(stage, cardId, roomId));
    }
    expect(wiredTo(stage, 'film')).toEqual(server.wiredTo(stage, 'film'));
  });

  // The media builder is teaching the server the same rule; until that lands on this branch it is pinned here alone.
  it('carries the browser wired to whoever is making the film', () => {
    const theirs = { ...stage, wires: [...stage.wires, wire('maya', 'their-browser')] };
    expect(sourcesFor(theirs, 'film', 'maya').map((card) => card.id)).toContain('their-browser');
    expect(sourcesFor(theirs, undefined, 'maya').map((card) => card.id)).toEqual(['note', 'their-browser']);
  });

  it('reaches the image studio behind an empty picture card', () => {
    expect(sourcesFor(stage, 'film').map((card) => card.id)).toContain('feeder');
  });
});

describe('what the video card says it will use', () => {
  const seen = { where: (id: string) => (id === 'browser' ? 'https://shop.example' : id === 'idle-browser' ? '' : ''), drawn: (id: string) => (id === 'studio' ? 5 : id === 'feeder' ? 1 : 0) };
  const says = filmSays(sourcesFor(stage, 'film'), ['Company brief'], { ...seen, noteTitle: (id) => (id === 'n1' ? 'Pricing notes' : '') });

  it('names what a film will really gather, then the docs', () => {
    expect(says).toEqual(['3 pictures from the image studio', 'a picture', 'a note', 'Example', 'a browser card', 'shop project', 'Pricing notes', 'startups.rip', '1 picture from the image studio', 'Company brief']);
  });

  it('leaves out an empty picture or note card, a blank browser and a studio that has drawn nothing', () => {
    expect(filmSays(sourcesFor(stage, 'film'), [], { where: () => 'about:blank', drawn: () => 0 })).toEqual(['a picture', 'a note', 'Example', 'shop project', 'a note from your library', 'startups.rip']);
  });
});
