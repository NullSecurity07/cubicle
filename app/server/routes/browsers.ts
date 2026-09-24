import { signedIn } from '../../shared/apps.ts';
import { isHeaded } from '../../shared/model.ts';
import type { Browser } from '../browser.ts';
import { readFailed } from '../cache.ts';
import { answer, type Route } from '../http.ts';
import type { Store } from '../store.ts';
import { browserSession } from '../tools/web.ts';

// Link and source cards read for their title, and the browser cards: watched, restarted, signed in by the founder.
export function browserRoutes(deps: { store: Store; browser: Browser }): Route {
  const { store, browser } = deps;
  return async (req, res, path) => {
    const linked = /^\/api\/links\/([^/]+)$/.exec(path)?.[1];
    if (linked && req.method === 'POST') {
      const card = (await store.loadStage()).cards?.find((one) => one.id === linked);
      if (!card || (card.kind !== 'link' && card.kind !== 'source') || !card.url) return answer(res, 404, { error: 'unknown link' });
      // A source is searched when it fits, never read into anyone's background, so only its name is kept.
      if (card.kind === 'source') return answer(res, 200, { title: (await browser.page(card.url)).title, preview: '' });
      const page = { url: card.url, ...(await browser.page(card.url)) };
      if (!readFailed(page.text)) await store.writePage(linked, page);
      return answer(res, 200, { title: page.title, preview: page.text.slice(0, 280) });
    }
    // Whether the founder is signed in to an app card. A plain browser card has no rule, so nothing is claimed for it.
    const checked = /^\/api\/browsers\/([^/]+)\/signed-in$/.exec(path)?.[1];
    if (checked && req.method === 'GET') {
      const card = (await store.loadStage()).cards?.find((one) => one.id === checked);
      if (!card || card.kind !== 'browser') return answer(res, 404, { error: 'unknown browser' });
      if (!card.app) return answer(res, 200, { signedIn: null, landedOn: '' });
      // The founder's own Chrome holds the profile; starting the card's session now would fight it for the folder.
      if (browser.handOpen(store.browserProfile(checked))) return answer(res, 200, { signedIn: null, landedOn: '', byHand: true });
      const landedOn = await browser.landing(browserSession(checked), card.app.home, { profile: store.browserProfile(checked), headed: isHeaded(card) });
      return answer(res, 200, { signedIn: signedIn(card.app, landedOn), landedOn });
    }
    // Sign in on an app card: the founder's own Chrome, not automated, on the card's profile, since Google refuses automated ones.
    const signing = /^\/api\/browsers\/([^/]+)\/sign-in$/.exec(path)?.[1];
    if (signing && req.method === 'POST') {
      const card = (await store.loadStage()).cards?.find((one) => one.id === signing);
      if (!card || card.kind !== 'browser' || !card.app) return answer(res, 404, { error: 'unknown app card' });
      await browser.close(browserSession(signing));
      void browser.byHand(store.browserProfile(signing), card.app.home).catch((error: Error) => console.error(`sign-in window for ${card.app?.name}: ${error.message}`));
      return answer(res, 200, { started: true });
    }
    // The founder has signed in: their Chrome may outlive its window, so the stage closes it for them.
    const finishing = /^\/api\/browsers\/([^/]+)\/sign-in\/done$/.exec(path)?.[1];
    if (finishing && req.method === 'POST') return answer(res, 200, { ok: browser.endHand(store.browserProfile(finishing)) });
    const watched = /^\/api\/browsers\/([^/]+)$/.exec(path)?.[1];
    if (watched && req.method === 'GET') {
      const card = (await store.loadStage()).cards?.find((one) => one.id === watched && (one.kind === 'browser' || one.kind === 'source'));
      if (!card) return answer(res, 404, { error: 'unknown browser' });
      // A source card's session holds no logins, so it is watched with no profile and no home.
      if (card.kind === 'source') return answer(res, 200, await browser.watch(browserSession(watched)));
      return answer(res, 200, await browser.watch(browserSession(watched), { profile: store.browserProfile(watched), headed: isHeaded(card) }, card.kind === 'browser' ? card.app?.home : undefined));
    }
    // "Show window" changed: Chrome reads that only at start, so end the session and start it again the new way.
    const restarted = /^\/api\/browsers\/([^/]+)\/restart$/.exec(path)?.[1];
    if (restarted && req.method === 'POST') {
      const card = (await store.loadStage()).cards?.find((one) => one.id === restarted && one.kind === 'browser');
      if (!card) return answer(res, 404, { error: 'unknown browser' });
      await browser.close(browserSession(restarted));
      return answer(res, 200, await browser.watch(browserSession(restarted), { profile: store.browserProfile(restarted), headed: isHeaded(card) }, card.kind === 'browser' ? card.app?.home : undefined));
    }
    return false;
  };
}
