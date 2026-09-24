import { useReactFlow, type NodeProps } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';
import { NONCOMMERCIAL, OMNI_PICKER_LINE, PERMISSION_LINE, SHAPES, type MediaAsset, type MediaResult, type Shape, type VideoLook, type VoiceEngine } from '../../shared/model';
import { afforded, makingWords, shotsIn } from '../../shared/film-time';
import { useAddCard } from '../addCard';
import { addAsset, fileUrl, getVoices, removeAsset, stopMedia } from '../api';
import { useElapsed, useMedia } from '../media';
import type { ImageGenNodeType, VideoGenNodeType, VoiceGenNodeType } from '../stage';
import { CardActions, Frame } from './Frame';

const SHAPE_WORDS: Record<Shape, string> = { square: 'Square', wide: 'Wide', tall: 'Tall' };

// A picture studio. The founder writes what they want, or a wired person draws with generate_image; either way the
// picture appears here and the file goes to the shared files.
export function ImageGenNode({ id, data, selected }: NodeProps<ImageGenNodeType>) {
  const { updateNodeData } = useReactFlow();
  const addCard = useAddCard();
  const { media, hint, making, problem, make } = useMedia(id);
  const elapsed = useElapsed(making);
  const [shown, setShown] = useState(0);
  const prompt = data.prompt ?? '';
  const picture = media.results[shown] ?? media.results[0];
  const draw = () => { if (prompt.trim() && !making) { setShown(0); void make({ prompt: prompt.trim(), shape: data.shape ?? 'square' }); } };

  return (
    <Frame selected={!!selected} minWidth={260} minHeight={300}>
      <header className="card__header card__header--doc">
        <svg className="doc-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.800" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M5.400 10.600l1.900-2.400 1.500 1.800 1.200-1.400 1.600 2M6 6.200h.01" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <div className="card__name">Image studio</div>
        <CardActions id={id} what="this image studio (the pictures it made stay in the shared files)" />
      </header>
      <div className="studio nodrag">
        <div className={`studio__result${making ? ' is-making' : ''}`}>
          {picture && <img src={fileUrl(picture.path)} alt={picture.prompt} draggable={false} />}
          {making && <p className="studio__doing">{media.log.at(-1) ?? 'making it…'}<span className="studio__clock">{elapsed}</span></p>}
          {!picture && !making && <p className="chat__empty">{hint ?? 'Say what you want to see and press Make. A person wired to this card can draw here too.'}</p>}
        </div>
        {media.results.length > 1 && (
          <div className="studio__strip nowheel" aria-label="Made earlier">
            {media.results.map((one, index) => (
              <button key={one.path} type="button" className={index === shown ? 'is-shown' : undefined} title={one.prompt} aria-label={one.prompt} onClick={() => setShown(index)}>
                <img src={fileUrl(one.path)} alt="" draggable={false} />
              </button>
            ))}
          </div>
        )}
        {picture && (
          <div className="studio__done">
            {picture.by && <span className="studio__by">{picture.by === 'this computer' ? 'Drawn on this computer' : `Drawn on ${picture.by}`}</span>}
            <a href={fileUrl(picture.path)} download>Download</a>
            <button type="button" onClick={() => addCard('image', { path: picture.path })}>Put on stage</button>
          </div>
        )}
        <form className="studio__ask" onSubmit={(event) => { event.preventDefault(); draw(); }}>
          <textarea
            aria-label="What to draw" placeholder="A quiet desk at dawn, soft light, photo…" rows={2} value={prompt}
            onChange={(event) => updateNodeData(id, { prompt: event.target.value })}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); draw(); } }}
          />
          <div className="studio__end">
            <select aria-label="Shape" value={data.shape ?? 'square'} onChange={(event) => updateNodeData(id, { shape: event.target.value as Shape })}>
              {SHAPES.map((shape) => <option key={shape} value={shape}>{SHAPE_WORDS[shape]}</option>)}
            </select>
            {making
              ? <button type="button" onClick={() => void stopMedia(id)}>Stop</button>
              : <button type="submit" className="primary" disabled={!prompt.trim() || !!hint} title={hint ?? ''}>Make</button>}
          </div>
        </form>
        {!making && (problem || media.problem) && <p className="msg--problem studio__problem">That did not work: {problem || media.problem}</p>}
      </div>
    </Frame>
  );
}

// The voices come from the server once, for every voice card on the stage and every person who speaks in one: a
// fixed list, not a model that must load first.
let voicesAsked: Promise<{ id: string; name: string; grade?: string }[]> | null = null;
export function useVoices() {
  const [voices, setVoices] = useState<{ id: string; name: string; grade?: string }[]>([]);
  useEffect(() => {
    let gone = false;
    voicesAsked ??= getVoices().then((got) => got.voices).catch(() => []);
    void voicesAsked.then((got) => { if (!gone) setVoices(got); });
    return () => { gone = true; };
  }, []);
  return voices;
}

// The small mark a recording made with non-commercial weights carries wherever it is listed.
function NotForSale({ result }: { result?: MediaResult }) {
  if (!result?.noncommercial) return null;
  return <span className="studio__mark" title={`Made with OmniVoice: ${NONCOMMERCIAL}`}>non-commercial</span>;
}
// What a first switch-on says, to set OmniVoice up with the founder watching and prove it speaks.
const OMNI_NARRATOR = 'omnivoice';
const FIRST_WORDS = 'This is OmniVoice, set up and speaking on this computer.';

// A voice studio. The founder writes the words, or a wired person says them with generate_voice; either way the
// recording appears here and the file goes to the shared files. Kokoro is the engine unless the founder switches to
// OmniVoice, which designs a voice from a few words or clones one dropped on the card, and whose weights are
// non-commercial: the card says so beside the switch, on every file it makes and in the log.
export function VoiceGenNode({ id, data, selected }: NodeProps<VoiceGenNodeType>) {
  const { updateNodeData } = useReactFlow();
  const { media, hint, making, problem, make, reload } = useMedia(id);
  const elapsed = useElapsed(making);
  const voices = useVoices();
  const [shown, setShown] = useState(0);
  const words = data.text ?? '';
  const said = media.results[shown] ?? media.results[0];
  const omni = data.engine === 'omnivoice';
  const recordings = (media.assets ?? []).filter((one) => one.kind === 'audio');
  const clone = omni && recordings.some((one) => one.name === data.clone) ? data.clone : undefined;
  const asked = (prompt: string) => (omni
    ? { prompt, engine: 'omnivoice', design: data.design ?? '', language: data.language ?? '', ...(clone ? { clone } : {}) }
    : { prompt, voice: data.voice ?? '' });
  const say = () => { if (words.trim() && !making) { setShown(0); void make(asked(words.trim())); } };
  // The first time it is switched on, OmniVoice is set up in front of the founder and says one line to prove it.
  const switchTo = (engine: VoiceEngine) => {
    updateNodeData(id, { engine: engine === 'kokoro' ? undefined : engine });
    const setUp = media.results.some((one) => one.by?.startsWith('OmniVoice'));
    if (engine === 'omnivoice' && !setUp && !making) { setShown(0); void make({ prompt: FIRST_WORDS, engine: 'omnivoice', design: data.design ?? '' }); }
  };

  return (
    <Frame selected={!!selected} minWidth={260} minHeight={260}>
      <header className="card__header card__header--doc">
        <svg className="doc-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.200a1.900 1.900 0 0 1 1.900 1.900v3.700a1.900 1.900 0 0 1-3.800 0V4.100A1.900 1.900 0 0 1 8 2.200zM4 7.400a4 4 0 0 0 8 0M8 11.400v2.400" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
        <div className="card__name">Voice studio</div>
        <CardActions id={id} what="this voice studio (the recordings it made stay in the shared files)" />
      </header>
      <div className="studio nodrag">
        <div className={`studio__result studio__result--sound${making ? ' is-making' : ''}`}>
          {said && !making && (
            <div className="studio__sound">
              <audio src={fileUrl(said.path)} controls preload="metadata" aria-label="What was said" />
              <p>{said.prompt}</p>
            </div>
          )}
          {making && <p className="studio__doing">{media.log.at(-1) ?? 'saying it…'}<span className="studio__clock">{elapsed}</span></p>}
          {!said && !making && <p className="chat__empty">{hint ?? 'Write what should be said and press Make. A person wired to this card can speak here too.'}</p>}
        </div>
        {media.results.length > 1 && (
          <div className="studio__takes nowheel" aria-label="Said earlier">
            {media.results.map((one, index) => (
              <button key={one.path} type="button" className={index === shown ? 'is-shown' : undefined} title={one.prompt} onClick={() => setShown(index)}>
                {one.noncommercial && <NotForSale result={one} />}{one.prompt}
              </button>
            ))}
          </div>
        )}
        {said && (
          <div className="studio__done">
            {said.by && <span className="studio__by">{said.by === 'Kokoro' ? 'Said on this computer' : `Said by ${said.by}`}</span>}
            <NotForSale result={said} />
            {said.credits && <a href={fileUrl(said.credits)} target="_blank" rel="noreferrer">Licence</a>}
            <a href={fileUrl(said.path)} download>Download</a>
          </div>
        )}
        <form className="studio__ask" onSubmit={(event) => { event.preventDefault(); say(); }}>
          <textarea
            aria-label="What to say" placeholder="Thanks for stopping by. Here is what we built this week…" rows={2} value={words}
            onChange={(event) => updateNodeData(id, { text: event.target.value })}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); say(); } }}
          />
          <div className="studio__end">
            {omni
              ? (
                <select aria-label="Voice" value={clone ?? ''} onChange={(event) => updateNodeData(id, { clone: event.target.value || undefined })}>
                  <option value="">Designed voice</option>
                  {recordings.map((one) => <option key={one.name} value={one.name}>Clone {one.name}</option>)}
                </select>
              )
              : (
                <select aria-label="Voice" value={data.voice ?? voices[0]?.id ?? ''} onChange={(event) => updateNodeData(id, { voice: event.target.value })}>
                  {voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
                </select>
              )}
            {making
              ? <button type="button" onClick={() => void stopMedia(id)}>Stop</button>
              : <button type="submit" className="primary" disabled={!words.trim() || (!omni && !!hint)} title={omni ? '' : hint ?? ''}>Make</button>}
          </div>
          <details className="studio__more" open={omni || undefined}>
            <summary>Engine: {omni ? `OmniVoice · non-commercial` : 'Kokoro'}</summary>
            <div className="studio__grid">
              <label className="studio__wide">
                Engine
                <select aria-label="Engine" value={data.engine ?? 'kokoro'} onChange={(event) => switchTo(event.target.value as VoiceEngine)}>
                  <option value="kokoro">Kokoro</option>
                  <option value="omnivoice">OmniVoice</option>
                </select>
              </label>
            </div>
            <p className="studio__aside">OmniVoice {OMNI_PICKER_LINE}. Kokoro is free to use for anything.</p>
            {omni && (
              <>
                <div className="studio__grid">
                  <label className="studio__wide">
                    Designed voice
                    <input aria-label="Design" value={data.design ?? ''} placeholder="older man, low pitch, british accent" disabled={!!clone}
                      onChange={(event) => updateNodeData(id, { design: event.target.value || undefined })} />
                  </label>
                  <label>
                    Language
                    <input aria-label="Language" value={data.language ?? ''} placeholder="Auto, or es, Hindi…" onChange={(event) => updateNodeData(id, { language: event.target.value || undefined })} />
                  </label>
                </div>
                <p className="studio__aside">It knows gender, age, pitch, a whisper and ten English accents. [laughter] and [sigh] in the words are heard, not read.</p>
                <p className="studio__aside">To clone a voice, drop a 5 to 20 second recording here. {PERMISSION_LINE}</p>
                <AssetTray id={id} assets={recordings} onChange={reload} accept="audio/*" />
              </>
            )}
          </details>
        </form>
        {!making && (problem || media.problem) && <p className="msg--problem studio__problem">That did not work: {problem || media.problem}</p>}
      </div>
    </Frame>
  );
}

const LOOK_WORDS: Record<VideoLook, string> = {
  clean: 'Clean', creator: 'Creator', editorial: 'Editorial', neon: 'Neon', documentary: 'Documentary', sketch: 'Sketch', brand: 'Brand',
};
// What the film is for. The words are the founder's, not the code's; each one sets a structure, a pace and a length
// on the server. Every picker starts on Auto, which is not a default but a decision: the director reads the brief and
// works it out, and anything the founder does set it obeys instead.
const PURPOSE_WORDS: [string, string][] = [
  ['explainer', 'Product explainer'], ['launch', 'Launch announcement'], ['feature', 'One feature'],
  ['ad', 'Marketing ad'], ['reel', 'Influencer-style reel'], ['pitch', 'Investor pitch'], ['testimonial', 'Customer testimonial'],
];
// The moods the music maker can actually write a bed in, plus silence. Music is on by default: a film with nothing
// under it sounds like a draft, and the studio can write one for any of these without asking anybody for anything.
const MUSIC_WORDS: [string, string][] = [
  ['none', 'No music'], ['upbeat', 'Upbeat'], ['calm', 'Calm'], ['cinematic', 'Cinematic'],
  ['tech', 'Tech'], ['warm', 'Warm'], ['playful', 'Playful'], ['dramatic', 'Dramatic'],
];
const LENGTH_WORDS = [15, 20, 30, 45, 60, 90];
// How long a film of this length takes to make here, in the founder's words, said before they press Make rather than
// found out afterwards. The sum is the studio's own (`shared/film-time`), so the card and the first line of the log
// agree: what decides it is how many pictures there are and whether this computer has to draw them.
const howLong = (seconds: number | undefined, clips: 'auto' | 'on' | 'off', draft: boolean, here: boolean, narrate: boolean): string => {
  const length = seconds ?? 30;
  const pictures = afforded(shotsIn(length), here, 8, draft);
  const moving = clips === 'on' && !draft ? ' — plus about three minutes for each moving shot' : '';
  return `${makingWords({ seconds: length, pictures, clips: 0, narrate, here, draft })}${moving}`;
};
const MEDIA_FILE = 'video/*,image/*,audio/*';
const seconds = (value?: number) => (value ? `${Math.round(value)}s` : '');

// What the founder dropped on the card, and what the card is drawing on besides. A film is built around these, so the
// card says out loud what it will use before the founder presses Make.
function AssetTray({ id, assets, onChange, accept = MEDIA_FILE }: { id: string; assets: MediaAsset[]; onChange: () => void; accept?: string }) {
  const [busy, setBusy] = useState('');
  const pick = useRef<HTMLInputElement>(null);
  const take = async (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      setBusy(`adding ${file.name}…`);
      try { await addAsset(id, file); } catch (error) { setBusy(`${file.name}: ${(error as Error).message}`); await new Promise((wait) => setTimeout(wait, 4000)); }
      onChange();
    }
    setBusy('');
  };
  return (
    <div className="tray">
      <input ref={pick} type="file" accept={accept} multiple hidden onChange={(event) => { void take(event.target.files); event.target.value = ''; }} />
      {assets.map((asset) => (
        <div key={asset.name} className="tray__one" title={`${asset.name} · ${asset.kind}${asset.seconds ? ` · ${seconds(asset.seconds)}` : ''}`}>
          {asset.thumb ? <img src={fileUrl(asset.thumb)} alt="" draggable={false} /> : <span className="tray__kind">{asset.kind === 'audio' ? '♪' : '▦'}</span>}
          <span className="tray__name">{asset.name}</span>
          {asset.seconds ? <span className="tray__len">{seconds(asset.seconds)}</span> : null}
          <button type="button" aria-label={`Remove ${asset.name}`} onClick={() => void removeAsset(id, asset.name).then(onChange)}>×</button>
        </div>
      ))}
      <button type="button" className="tray__add" onClick={() => pick.current?.click()}>{busy || 'Drop video, pictures or a music track here — or click to add'}</button>
    </div>
  );
}

// A video studio. The founder writes a brief and the server storyboards it out of whatever is wired to the card —
// the product's own code, its screens, the founder's own footage — draws the stills, records the narration and renders
// the film here on this machine; a wired person builds one scene by scene with generate_video. A render takes minutes,
// so every step the renderer takes shows on the card as it happens.
export function VideoGenNode({ id, data, selected }: NodeProps<VideoGenNodeType>) {
  const { updateNodeData, getNodes, getEdges } = useReactFlow();
  const { media, hint, drawnHere, making, problem, make, reload } = useMedia(id);
  const elapsed = useElapsed(making);
  const voices = useVoices();
  const [shown, setShown] = useState(0);
  const [over, setOver] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const brief = data.brief ?? '';
  const film = media.results[shown] ?? media.results[0];
  const assets = media.assets ?? [];
  const shoot = () => {
    if (!brief.trim() || making) return;
    setShown(0);
    // Everything the founder left on Auto goes as 'auto', which is the studio's word for "you decide".
    void make({
      prompt: brief.trim(), format: data.format ?? 'auto', look: data.look ?? 'auto', narrate: !data.silent,
      purpose: data.purpose ?? 'auto', length: data.length, pace: data.pace ?? 'auto', music: data.music ?? 'auto',
      captions: data.captions === 'on' ? true : data.captions === 'off' ? false : undefined,
      sfx: data.sfx !== 'off', ai: data.ai ?? 'auto', address: data.address, voice: data.voice, speed: data.speed ?? 'full',
      ...(data.engine === 'omnivoice' ? { engine: 'omnivoice', design: data.design ?? '' } : {}),
    });
  };

  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [media.log]);

  // What this film will be made of, in the founder's words, so nothing about it is a surprise.
  const using = (() => {
    const joined = getEdges().filter((edge) => edge.source === id || edge.target === id).map((edge) => (edge.source === id ? edge.target : edge.source));
    const nodes = getNodes().filter((node) => joined.includes(node.id));
    const said: string[] = [];
    for (const node of nodes) {
      if (node.type === 'project') said.push(`${String((node.data as { path?: string }).path ?? '').split('/').filter(Boolean).at(-1) ?? 'a'} project`);
      else if (node.type === 'link') said.push(String((node.data as { title?: string; url?: string }).title || (node.data as { url?: string }).url || 'a page'));
      else if (node.type === 'browser') said.push('a browser card');
      else if (node.type === 'doc') said.push(String((node.data as { title?: string }).title ?? 'a document'));
      else if (node.type === 'note') said.push('a note');
      else if (node.type === 'image') said.push('a picture');
    }
    if (data.address?.trim()) said.unshift(data.address.trim());
    const clips = assets.filter((one) => one.kind === 'video').length;
    if (clips) said.push(`${clips} of your clip${clips === 1 ? '' : 's'}`);
    const track = assets.find((one) => one.kind === 'audio');
    if (track && data.music !== 'none') said.push('your music');
    return said;
  })();

  return (
    <Frame selected={!!selected} minWidth={340} minHeight={420}>
      <header className="card__header card__header--doc">
        <svg className="doc-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3.500" width="12" height="9" rx="1.600" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M6.700 6.600l3.100 1.900-3.100 1.900z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>
        <div className="card__name">Video studio</div>
        <CardActions id={id} what="this video studio (the films it made stay in the shared files)" />
      </header>
      <div
        className={`studio nodrag${over ? ' is-over' : ''}`}
        onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setOver(true); } }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          setOver(false);
          void (async () => { for (const file of Array.from(event.dataTransfer.files)) await addAsset(id, file).catch(() => {}); reload(); })();
        }}
      >
        <div className="studio__result">
          {film && !making && <video src={fileUrl(film.path)} poster={film.poster ? fileUrl(film.poster) : undefined} controls preload="metadata" aria-label={film.prompt} />}
          {making && (
            <div className="project__log studio__lines nowheel" ref={log}>
              {media.log.length ? media.log.map((line, index) => <div key={index}>{line}</div>) : <div>starting…</div>}
              <div className="studio__clock">{elapsed}</div>
            </div>
          )}
          {!film && !making && <p className="chat__empty">{hint ?? 'Say what the film is about and press Make. It is storyboarded, drawn, narrated and rendered here, which takes a few minutes.'}</p>}
        </div>
        {media.results.length > 1 && (
          <div className="studio__takes nowheel" aria-label="Made earlier">
            {media.results.map((one, index) => (
              <button key={one.path} type="button" className={index === shown ? 'is-shown' : undefined} title={one.prompt} onClick={() => setShown(index)}>{one.prompt}</button>
            ))}
          </div>
        )}
        {film && !making && (
          <div className="studio__done">
            <a href={fileUrl(film.path)} download>Download</a>
            {film.poster && <a href={fileUrl(film.poster)} download>Poster</a>}
            {film.mlt && <a href={fileUrl(film.mlt)} download title="The film as tracks, for Shotcut or Kdenlive. Its pictures and sound sit beside it in the shared files, in a folder of the same name.">.mlt</a>}
          </div>
        )}
        {film?.mlt && !making && <p className="studio__note">Also an .mlt for Shotcut or Kdenlive.</p>}
        {!!using.length && <p className="studio__using">Using: {using.join(', ')}</p>}
        {film?.music && !making && <p className="studio__note">Music: {film.music.title} by {film.music.by} · {film.music.licence}</p>}
        {film?.noncommercial && !making && <p className="studio__note"><NotForSale result={film} /> Narrated with OmniVoice: {NONCOMMERCIAL}.{film.credits && <> <a href={fileUrl(film.credits)} target="_blank" rel="noreferrer">Credits</a></>}</p>}
        {!making && !!brief.trim() && <p className="studio__note">{data.speed === 'draft' ? 'A draft takes' : 'Making it takes'} {howLong(data.length, data.ai ?? 'auto', data.speed === 'draft', drawnHere, !data.silent)}. Everything left on Auto, the director reads out of the brief.</p>}
        <form className="studio__ask" onSubmit={(event) => { event.preventDefault(); shoot(); }}>
          <textarea
            aria-label="What the film is about" placeholder="A one-minute update for investors: what shipped this month, the numbers, what is next…" rows={2} value={brief}
            onChange={(event) => updateNodeData(id, { brief: event.target.value })}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); shoot(); } }}
          />
          <div className="studio__end">
            <select aria-label="What it is for" value={data.purpose ?? ''} onChange={(event) => updateNodeData(id, { purpose: event.target.value || undefined })}>
              <option value="">Auto</option>
              {PURPOSE_WORDS.map(([value, word]) => <option key={value} value={value}>{word}</option>)}
            </select>
            <select aria-label="How long" value={String(data.length ?? '')} onChange={(event) => updateNodeData(id, { length: event.target.value ? Number(event.target.value) : undefined })}>
              <option value="">Auto</option>
              {LENGTH_WORDS.map((one) => <option key={one} value={one}>{one} seconds</option>)}
            </select>
            {/* The one choice about time, beside the button it decides the wait for. Full is the film; Draft is the
                quick one to look at first, and asking for Full afterwards finishes that same film. */}
            <select
              className="studio__speed" aria-label="How fast" value={data.speed ?? ''}
              title="Full is the film. Draft is the quick one to look at first: the same words and the same cut, on a few small pictures, with nothing moving drawn for it. Ask for Full afterwards and it is that film, finished."
              onChange={(event) => updateNodeData(id, { speed: (event.target.value || undefined) as 'draft' | undefined })}
            >
              <option value="">Full</option><option value="draft">Draft</option>
            </select>
            {making
              ? <button type="button" onClick={() => void stopMedia(id)}>Stop</button>
              : <button type="submit" className="primary" disabled={!brief.trim() || !!hint} title={hint ?? ''}>Make</button>}
          </div>
          {/* Everything a founder sets once and rarely changes tucks away, so the card stays as calm as the others. */}
          <details className="studio__more">
            <summary>More{assets.length ? ` · ${assets.length} file${assets.length === 1 ? '' : 's'}` : ''}</summary>
            <div className="studio__grid">
              <label>Shape
                <select value={data.format ?? ''} onChange={(event) => updateNodeData(id, { format: (event.target.value || undefined) as Shape | undefined })}>
                  <option value="">Auto</option>
                  {SHAPES.map((shape) => <option key={shape} value={shape}>{SHAPE_WORDS[shape]}</option>)}
                </select>
              </label>
              <label>Look
                <select value={data.look ?? ''} onChange={(event) => updateNodeData(id, { look: (event.target.value || undefined) as VideoLook | undefined })}>
                  <option value="">Auto</option>
                  {Object.entries(LOOK_WORDS).map(([look, word]) => <option key={look} value={look}>{word}</option>)}
                </select>
              </label>
              <label>Pace
                <select value={data.pace ?? ''} onChange={(event) => updateNodeData(id, { pace: (event.target.value || undefined) as 'calm' | 'punchy' | undefined })}>
                  <option value="">Auto</option><option value="calm">Calm</option><option value="punchy">Punchy</option>
                </select>
              </label>
              <label>Music
                <select value={data.music ?? ''} onChange={(event) => updateNodeData(id, { music: event.target.value || undefined })}>
                  <option value="">Auto</option>
                  {MUSIC_WORDS.map(([value, word]) => <option key={value} value={value}>{word}</option>)}
                </select>
              </label>
              <label className="studio__wide">Product address
                <input
                  type="text" placeholder="relay.app, or http://localhost:3000" value={data.address ?? ''}
                  onChange={(event) => updateNodeData(id, { address: event.target.value })}
                />
              </label>
            </div>
            <div className="studio__switches">
              <label className="studio__toggle"><input type="checkbox" checked={!data.silent} onChange={(event) => updateNodeData(id, { silent: !event.target.checked })} />Narrate</label>
              <label className="studio__toggle"><input type="checkbox" checked={data.captions === 'on'} onChange={(event) => updateNodeData(id, { captions: event.target.checked ? 'on' : 'off' })} />Captions</label>
              <label className="studio__toggle"><input type="checkbox" checked={data.sfx !== 'off'} onChange={(event) => updateNodeData(id, { sfx: event.target.checked ? 'on' : 'off' })} />Sound</label>
            </div>
            {/* "AI clips" was a switch nobody could answer: it named how a shot is made rather than what the film
                gets. This asks the only question a founder actually has an opinion about — where the pictures in
                my film come from — and the studio works out the rest. */}
            <label className="studio__ai" title="Where the pictures in this film come from. Your own footage and screenshots always come first; the rest is made up from what is left.">
              Footage
              <select value={data.ai ?? ''} onChange={(event) => updateNodeData(id, { ai: (event.target.value || undefined) as 'on' | 'off' | undefined })}>
                <option value="">Auto</option>
                <option value="off">My footage only</option>
                <option value="on">Stock and generated</option>
              </select>
            </label>
            {data.ai === 'on' && <p className="studio__aside">Moving shots are drawn here on this computer: about three minutes each, and the film waits for them.</p>}
            {data.ai === 'off' && <p className="studio__aside">Only what you dropped on this card, what is wired to it, and the film's own type and graphics.</p>}
            {/* Who reads it. One voice a film, and the card says which — a narrator who does not match whoever is
                on screen is the fastest way to lose a viewer, so the studio would rather show nobody. */}
            <label className="studio__ai" title="One narrator reads the whole film. Left on Auto, the studio casts the best voice that fits the brief.">
              Narrator
              <select value={data.engine === 'omnivoice' ? OMNI_NARRATOR : data.voice ?? ''} onChange={(event) => {
                const picked = event.target.value;
                updateNodeData(id, picked === OMNI_NARRATOR ? { engine: 'omnivoice', voice: undefined } : { engine: undefined, voice: picked || undefined });
              }}>
                <option value="">Auto</option>
                {voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
                <option value={OMNI_NARRATOR}>OmniVoice · non-commercial</option>
              </select>
            </label>
            {/* The one way a film is read in OmniVoice: the founder picks it here, by hand, and is told what it means. */}
            {data.engine === 'omnivoice' && (
              <>
                <input className="studio__design" aria-label="The narrator's voice" value={data.design ?? ''} placeholder="older man, low pitch, british accent"
                  onChange={(event) => updateNodeData(id, { design: event.target.value || undefined })} />
                <p className="studio__aside">OmniVoice {OMNI_PICKER_LINE}. The film says so in its credits.</p>
              </>
            )}
            <AssetTray id={id} assets={assets} onChange={reload} />
          </details>
        </form>
        {!making && (problem || media.problem) && <p className="msg--problem studio__problem">That did not work: {problem || media.problem}</p>}
      </div>
    </Frame>
  );
}
