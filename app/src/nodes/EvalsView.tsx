import { useEffect, useRef, useState } from 'react';
import type { EvalsView as Evals, RunLine } from '../../shared/evals';
import { scoreLine, staleWhy } from '../../shared/evals';
import type { Framework } from '../../shared/frameworks';
import type { Note } from '../../shared/library';
import { getEvals, promoteRun } from '../api';

// What a framework scored, and the history of every time it was asked. This is the part of the panel that makes a
// framework a building block rather than a folder: a number the founder can see before they place a team, a reason
// when that number has stopped being true, and a list of the experiments it came out of.

const HOW_OFTEN = 1200;

// The pill beside a framework's name. Amber when the score can no longer be trusted — the notes the team was written
// from have been edited, or the model that scored it is not set up here any more — and the reason is on the pill
// rather than in a help page, because it is one sentence and the founder is looking straight at it.
export function ScorePill({ framework, notes, models }: { framework: Framework; notes: Note[]; models: string[] }) {
  if (!framework.scorecard) return null;
  const why = staleWhy(framework, notes, models);
  return (
    <span className={why ? 'score is-stale' : 'score'} title={why || undefined} data-stale={why ? 'yes' : undefined}>
      {scoreLine(framework.scorecard)}
    </span>
  );
}

const when = (at: number) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
// What became of one run, in one word. `forced` is said out loud for good: a scorecard the arithmetic refused and the
// founder took anyway is not the same thing as one it agreed with, and a month later nobody would remember.
const became = (run: RunLine) => (run.forced ? 'promoted by hand' : run.rejected ? 'kept, not promoted' : 'promoted');

// Every run this framework has had, newest first, and the lines of the one that is running now. Collapsed until the
// founder asks for it: the list matters on the day something goes wrong and not before.
export function Runs({ framework, watch, onChanged }: { framework: Framework; watch: number; onChanged: () => Promise<void> }) {
  const [held, setHeld] = useState<Evals | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(0);
  const lines = useRef<HTMLDivElement>(null);
  // So a finished run refreshes the frameworks once, rather than on every look at a job that is already over.
  const told = useRef(0);

  useEffect(() => {
    let gone = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const look = async () => {
      try {
        const view = await getEvals(framework.id);
        if (gone) return;
        setHeld(view);
        // Nothing moves on its own once the run is over, so nothing is asked either — and the panel is told once,
        // because the framework it is drawing may have just been given a new score.
        if (view.job?.state !== 'testing') {
          clearInterval(timer);
          if (view.job && told.current !== watch) { told.current = watch; void onChanged(); }
        }
      } catch (error) { if (!gone) setProblem((error as Error).message); }
    };
    void look();
    timer = setInterval(() => { void look(); }, HOW_OFTEN);
    return () => { gone = true; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new look is wanted when a run starts, not when the panel redraws
  }, [framework.id, watch]);

  useEffect(() => { lines.current?.scrollTo({ top: lines.current.scrollHeight }); }, [held?.job?.lines.length]);

  async function take(at: number) {
    setBusy(at);
    try { setProblem(''); await promoteRun(framework.id, at); await onChanged(); setHeld(await getEvals(framework.id)); }
    catch (error) { setProblem((error as Error).message); } finally { setBusy(0); }
  }

  const running = held?.job?.state === 'testing';
  const nameOf = (key: string) => framework.rooms.find((room) => room.key === key)?.name ?? key;

  return (
    <div className="runs">
      <p className="runs__head">Runs <small>version {framework.version}</small></p>
      {(running || (held?.job?.lines.length ?? 0) > 0) && (
        <div className="forge__lines" ref={lines}>
          {held?.job?.lines.map((line, index) => <p key={`${index}-${line}`}>{line}</p>)}
        </div>
      )}
      {held?.job?.error && <p className="msg--problem">{held.job.error}</p>}
      {problem && <p className="msg--problem">{problem}</p>}
      {held && !held.runs.length && !running && <p className="library__empty">Nothing has been run yet. Press “Rerun evals” and this team answers your own test cases.</p>}
      <ul className="runs__list">
        {(held?.runs ?? []).map((run) => (
          <li key={run.at} className={run.rejected && !run.forced ? 'runs__one is-rejected' : 'runs__one'}>
            <div className="runs__line">
              <b>{run.mean.toFixed(2)}</b>
              <span>{when(run.at)}</span>
              <em>{became(run)}</em>
              <small>v{run.version} · {run.calls === 1 ? '1 call' : `${run.calls} calls`}{run.models.length ? ` · ${run.models.join(', ')}` : ''}</small>
            </div>
            {run.rejected && !run.forced && (
              <div className="runs__why">
                {run.regressed?.length ? (
                  <ul>
                    {run.regressed.map((one) => (
                      <li key={one.id}><span>{nameOf(one.key)} · {one.id}</span><b>{one.was.toFixed(2)} → {one.now.toFixed(2)}</b></li>
                    ))}
                  </ul>
                ) : <p>It scored below the {run.previous?.toFixed(2) ?? 'previous'} this framework already holds.</p>}
                <button type="button" disabled={busy === run.at} onClick={() => void take(run.at)}>Promote anyway</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
