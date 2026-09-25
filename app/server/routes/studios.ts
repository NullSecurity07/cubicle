import { MEDIA_KINDS, type MediaKind } from '../../shared/model.ts';
import { answer, body, openFeed, UPLOAD_LIMIT, type Route } from '../http.ts';
import { probe } from '../media/ff.ts';
import { thumbOf } from '../media/footage.ts';
import { byGrade, VOICES } from '../media/voice.ts';
import type { Store } from '../store.ts';
import type { wireStudios } from '../wiring/studios.ts';

// The studio cards: their one feed, the voices on offer, and each card's makes, stops and dropped-in footage.
// The feed and the voices come before the card paths, which would otherwise take "events" and "voices" for a card.
export function studioRoutes(deps: { store: Store } & Pick<ReturnType<typeof wireStudios>, 'media' | 'filmPictures'>): Route {
  const { store, media, filmPictures } = deps;
  return async (req, res, path, url) => {
    // Every studio card on the stage streams through one feed, the way the attention list does.
    if (path === '/api/media/events' && req.method === 'GET') {
      openFeed(res);
      res.on('close', media.watch((event) => res.write(`data: ${JSON.stringify(event)}\n\n`)));
      return true;
    }
    // The voices a voice studio offers, named for the founder. A fixed list: asking the model would fetch 310 MB first.
    // Best first, and each one saying who it sounds like: a founder choosing a narrator is casting, and casting
    // needs to know the gender, the accent and how good the voice actually is.
    if (path === '/api/media/voices' && req.method === 'GET') return answer(res, 200, { voices: byGrade(VOICES) });
    const studio = /^\/api\/media\/([^/]+)(?:\/(make|stop|assets)(?:\/([^/]{1,120}))?)?$/.exec(path);
    if (studio) {
      const [, cardId, action, assetName] = studio;
      const card = (await store.loadStage()).cards?.find((one) => one.id === cardId && (MEDIA_KINDS as readonly string[]).includes(one.kind));
      if (!card) return answer(res, 404, { error: 'unknown studio' });
      if (!action && req.method === 'GET') return answer(res, 200, {
        ...(await media.read(cardId)), hint: media.ready(card.kind as MediaKind),
        // A video studio says its minutes before Make is pressed, and the minutes turn on where pictures are drawn.
        ...(card.kind === 'videogen' ? { drawnHere: filmPictures.next?.() === 'this computer' } : {}),
      });
      // The founder's own footage, dropped on a studio card. A video is far bigger than anything else this app takes,
      // so it is written to disk as it arrives rather than held in memory, and only then looked at.
      if (action === 'assets' && !assetName && req.method === 'POST') {
        const name = url.searchParams.get('name') ?? 'clip.mp4';
        const { path: saved, bytes } = await store.streamUpload(name, req, UPLOAD_LIMIT);
        const track = await probe(store.pathOf(saved)).catch(() => null);
        if (!track) { return answer(res, 400, { error: 'that file could not be read as a video, a picture or a sound' }); }
        let thumb: string | undefined;
        if (track.kind === 'video') {
          const into = `media/thumb-${Date.now().toString(36)}.jpg`;
          await thumbOf(store.pathOf(saved), store.pathOf(into), Math.min(1, track.seconds / 3)).then(() => { thumb = into; }, () => {});
        } else if (track.kind === 'image') thumb = saved;
        return answer(res, 200, await media.addAsset(cardId, { file: name, path: saved, kind: track.kind, bytes, seconds: track.seconds || undefined, thumb }));
      }
      // A path is not decoded on the way in, and an asset is named after a file, spaces and all.
      if (action === 'assets' && assetName && req.method === 'DELETE') { await media.removeAsset(cardId, decodeURIComponent(assetName)); return answer(res, 200, { ok: true }); }
      if (action === 'make' && req.method === 'POST') {
        const asked = await body(req);
        const prompt = String(asked.prompt ?? '').trim();
        if (!prompt) return answer(res, 400, { error: 'say what to make first' });
        // A video takes minutes. Every studio answers the moment the job starts and the feed carries the rest, so the
        // founder's window is never left holding a request open.
        void media.make(card, { ...asked, prompt }).catch(() => { /* the card hears the failure through the feed */ });
        return answer(res, 202, { started: true });
      }
      if (action === 'stop' && req.method === 'POST') { media.stop(cardId); return answer(res, 200, { ok: true }); }
    }
    return false;
  };
}
