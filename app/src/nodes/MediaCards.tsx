import { useReactFlow, type NodeProps } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';
import { SHAPES, type Shape } from '../../shared/model';
import { useAddCard } from '../addCard';
import { fileUrl, getVoices, stopMedia } from '../api';
import { useMedia } from '../media';
import type { ImageGenNodeType, VideoGenNodeType, VoiceGenNodeType } from '../stage';
import { CardActions, Frame } from './Frame';

const SHAPE_WORDS: Record<Shape, string> = { square: 'Square', wide: 'Wide', tall: 'Tall' };

// A picture studio. The founder writes what they want, or a wired person draws with generate_image; either way the
// picture appears here and the file goes to the shared files.
export function ImageGenNode({ id, data, selected }: NodeProps<ImageGenNodeType>) {
  const { updateNodeData } = useReactFlow();
  const addCard = useAddCard();
  const { media, hint, making, problem, make } = useMedia(id);
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
          {making && <p className="studio__doing">{media.log.at(-1) ?? 'making it…'}</p>}
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

// The voices come from the server once, for every voice card on the stage: a fixed list, not a model that must load first.
let voicesAsked: Promise<{ id: string; name: string }[]> | null = null;
function useVoices() {
  const [voices, setVoices] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let gone = false;
    voicesAsked ??= getVoices().then((got) => got.voices).catch(() => []);
    void voicesAsked.then((got) => { if (!gone) setVoices(got); });
    return () => { gone = true; };
  }, []);
  return voices;
}

// A voice studio. The founder writes the words, or a wired person says them with generate_voice; either way the
// recording appears here and the file goes to the shared files.
export function VoiceGenNode({ id, data, selected }: NodeProps<VoiceGenNodeType>) {
  const { updateNodeData } = useReactFlow();
  const { media, hint, making, problem, make } = useMedia(id);
  const voices = useVoices();
  const [shown, setShown] = useState(0);
  const words = data.text ?? '';
  const said = media.results[shown] ?? media.results[0];
  const say = () => { if (words.trim() && !making) { setShown(0); void make({ prompt: words.trim(), voice: data.voice ?? '' }); } };

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
          {making && <p className="studio__doing">{media.log.at(-1) ?? 'saying it…'}</p>}
          {!said && !making && <p className="chat__empty">{hint ?? 'Write what should be said and press Make. A person wired to this card can speak here too.'}</p>}
        </div>
        {media.results.length > 1 && (
          <div className="studio__takes nowheel" aria-label="Said earlier">
            {media.results.map((one, index) => (
              <button key={one.path} type="button" className={index === shown ? 'is-shown' : undefined} title={one.prompt} onClick={() => setShown(index)}>{one.prompt}</button>
            ))}
          </div>
        )}
        {said && <div className="studio__done"><a href={fileUrl(said.path)} download>Download</a></div>}
        <form className="studio__ask" onSubmit={(event) => { event.preventDefault(); say(); }}>
          <textarea
            aria-label="What to say" placeholder="Thanks for stopping by. Here is what we built this week…" rows={2} value={words}
            onChange={(event) => updateNodeData(id, { text: event.target.value })}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); say(); } }}
          />
          <div className="studio__end">
            <select aria-label="Voice" value={data.voice ?? voices[0]?.id ?? ''} onChange={(event) => updateNodeData(id, { voice: event.target.value })}>
              {voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
            </select>
            {making
              ? <button type="button" onClick={() => void stopMedia(id)}>Stop</button>
              : <button type="submit" className="primary" disabled={!words.trim() || !!hint} title={hint ?? ''}>Make</button>}
          </div>
        </form>
        {!making && (problem || media.problem) && <p className="msg--problem studio__problem">That did not work: {problem || media.problem}</p>}
      </div>
    </Frame>
  );
}

const LOOK_WORDS: Record<string, string> = { clean: 'Clean', sketch: 'Sketch' };

// A video studio. The founder writes a brief and the server storyboards it, draws the stills, records the narration and
// renders the film here on this machine; a wired person builds one scene by scene with generate_video. A render takes
// minutes, so every step the renderer takes shows on the card as it happens.
export function VideoGenNode({ id, data, selected }: NodeProps<VideoGenNodeType>) {
  const { updateNodeData } = useReactFlow();
  const { media, hint, making, problem, make } = useMedia(id);
  const [shown, setShown] = useState(0);
  const log = useRef<HTMLDivElement>(null);
  const brief = data.brief ?? '';
  const film = media.results[shown] ?? media.results[0];
  const shoot = () => { if (brief.trim() && !making) { setShown(0); void make({ prompt: brief.trim(), format: data.format ?? 'wide', look: data.look ?? 'clean', narrate: !data.silent }); } };

  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [media.log]);

  return (
    <Frame selected={!!selected} minWidth={320} minHeight={380}>
      <header className="card__header card__header--doc">
        <svg className="doc-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3.500" width="12" height="9" rx="1.600" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M6.700 6.600l3.100 1.900-3.100 1.900z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>
        <div className="card__name">Video studio</div>
        <CardActions id={id} what="this video studio (the films it made stay in the shared files)" />
      </header>
      <div className="studio nodrag">
        <div className="studio__result">
          {film && !making && <video src={fileUrl(film.path)} poster={film.poster ? fileUrl(film.poster) : undefined} controls preload="metadata" aria-label={film.prompt} />}
          {making && (
            <div className="project__log studio__lines nowheel" ref={log}>
              {media.log.length ? media.log.map((line, index) => <div key={index}>{line}</div>) : <div>starting…</div>}
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
        {film && !making && <div className="studio__done"><a href={fileUrl(film.path)} download>Download</a></div>}
        <form className="studio__ask" onSubmit={(event) => { event.preventDefault(); shoot(); }}>
          <textarea
            aria-label="What the film is about" placeholder="A one-minute update for investors: what shipped this month, the numbers, what is next…" rows={2} value={brief}
            onChange={(event) => updateNodeData(id, { brief: event.target.value })}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); shoot(); } }}
          />
          <div className="studio__end">
            <select aria-label="Shape" value={data.format ?? 'wide'} onChange={(event) => updateNodeData(id, { format: event.target.value as Shape })}>
              {SHAPES.map((shape) => <option key={shape} value={shape}>{SHAPE_WORDS[shape]}</option>)}
            </select>
            <select aria-label="Look" value={data.look ?? 'clean'} onChange={(event) => updateNodeData(id, { look: event.target.value as 'clean' | 'sketch' })}>
              {Object.entries(LOOK_WORDS).map(([look, word]) => <option key={look} value={look}>{word}</option>)}
            </select>
            <label className="studio__toggle"><input type="checkbox" checked={!data.silent} onChange={(event) => updateNodeData(id, { silent: !event.target.checked })} />Narrate</label>
            {making
              ? <button type="button" onClick={() => void stopMedia(id)}>Stop</button>
              : <button type="submit" className="primary" disabled={!brief.trim() || !!hint} title={hint ?? ''}>Make</button>}
          </div>
        </form>
        {!making && (problem || media.problem) && <p className="msg--problem studio__problem">That did not work: {problem || media.problem}</p>}
      </div>
    </Frame>
  );
}
