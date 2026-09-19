import { useReactFlow, type NodeProps } from '@xyflow/react';
import { useState } from 'react';
import { SHAPES, type Shape } from '../../shared/model';
import { useAddCard } from '../addCard';
import { fileUrl, makeMedia, stopMedia } from '../api';
import { useMedia } from '../media';
import type { ImageGenNodeType } from '../stage';
import { CardActions, Frame } from './Frame';

const SHAPE_WORDS: Record<Shape, string> = { square: 'Square', wide: 'Wide', tall: 'Tall' };

// A picture studio. The founder writes what they want, or a wired person draws with generate_image; either way the
// picture appears here and the file goes to the shared files.
export function ImageGenNode({ id, data, selected }: NodeProps<ImageGenNodeType>) {
  const { updateNodeData } = useReactFlow();
  const addCard = useAddCard();
  const { media, hint } = useMedia(id);
  const [asking, setAsking] = useState(false);
  const [shown, setShown] = useState(0);
  const [problem, setProblem] = useState('');
  const prompt = data.prompt ?? '';
  const making = asking || media.state === 'making';
  const picture = media.results[shown] ?? media.results[0];

  async function make() {
    if (!prompt.trim() || making) return;
    setProblem('');
    setShown(0);
    setAsking(true);
    try { await makeMedia(id, { prompt: prompt.trim(), shape: data.shape ?? 'square' }); }
    catch (error) { setProblem((error as Error).message); }
    finally { setAsking(false); }
  }

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
        <form className="studio__ask" onSubmit={(event) => { event.preventDefault(); void make(); }}>
          <textarea
            aria-label="What to draw" placeholder="A quiet desk at dawn, soft light, photo…" rows={2} value={prompt}
            onChange={(event) => updateNodeData(id, { prompt: event.target.value })}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void make(); } }}
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
