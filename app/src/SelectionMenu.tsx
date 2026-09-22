import { Panel, useStore } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';
import { frameworkId } from '../shared/frameworks';
import { saveFramework } from './api';
import { refreshFrameworks } from './frameworks';
import { BlocksIcon } from './nodes/FrameworksPanel';
import { useFlushStage } from './sync';

// What the founder can do with several cards at once. Two or more selected is somebody treating them as a group, and
// the one thing worth offering about a group is keeping it: saved as a framework, the same people, docs, cards and
// wires come back in one press, anywhere, any number of times.
export function SelectionMenu() {
  // Only the ids, joined: this is redrawn when the selection changes and not once while a card is being dragged.
  const chosen = useStore((store) => [...store.nodeLookup.values()].filter((node) => node.selected).map((node) => node.id).join(' '));
  const flush = useFlushStage();
  const field = useRef<HTMLInputElement>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [problem, setProblem] = useState('');
  const [saved, setSaved] = useState('');
  const ids = chosen ? chosen.split(' ') : [];

  // A selection the founder has moved on from takes the dialog with it, so a half-typed name never reappears over
  // some other group later on.
  useEffect(() => { setNaming(false); setProblem(''); setSaved(''); }, [chosen]);
  useEffect(() => { if (naming) field.current?.focus(); }, [naming]);

  async function save() {
    try {
      setProblem('');
      // The stage as it is right now: the server writes the framework from what it has, so anything moved a moment
      // ago has to have landed there first.
      await flush();
      const framework = await saveFramework(frameworkId(name), { name, ids });
      await refreshFrameworks();
      setNaming(false);
      setSaved(framework.name);
    } catch (error) { setProblem((error as Error).message); }
  }

  if (ids.length < 2) return null;
  return (
    <Panel position="top-center" className="chosen">
      {saved ? <p className="chosen__done" role="status">Saved “{saved}” — it is in Frameworks.</p> : naming ? (
        <form
          className="chosen__name"
          data-holds-escape
          onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setNaming(false); } }}
          onSubmit={(event) => { event.preventDefault(); void save(); }}
        >
          <input ref={field} aria-label="Framework name" placeholder="What is this team called?" value={name} onChange={(event) => setName(event.target.value)} />
          <button type="button" onClick={() => setNaming(false)}>Cancel</button>
          <button type="submit" className="primary" disabled={!name.trim()}>Save</button>
        </form>
      ) : (
        <button type="button" className="chosen__act" onClick={() => setNaming(true)}>
          <BlocksIcon />
          Save {ids.length} as framework
        </button>
      )}
      {problem && <p className="chosen__problem">{problem}</p>}
    </Panel>
  );
}
