import { useEffect, useState } from 'react';
import type { Card, Stage } from '../../../shared/model';
import type { ReachState } from '../../../shared/reach';
import { getStage } from '../../api';
import { PanelShell } from '../../overlay/PanelShell';
import { dropHook, forgetChat, forgetGroup, getReach, makeHook, newPairing, putReach, speakTo, type Made } from './api';
import { voiceIs } from './voice';

// What leaves this machine, said once, in the words the founder would use. It is the first thing on the screen and
// it is above the switch, not under it.
const LEAVES = 'While this is on, the words of every message you and your people send each other here travel through Telegram\'s servers, the way any message on Telegram does. Nothing else goes with them: your documents, your files and everything else stay on this machine. It is off until you switch it on.';
const HOW = 'In Telegram, write to @BotFather, send /newbot, and give it any name. It hands you a token. Paste it here — it stays on this machine, in a file only you can read.';
const VOICE = 'A microphone appears in the ask box, and every reply can be read out to you. Both run on this machine: the voice is fetched once (310 MB) the first time you ask for one, and the listening the first time you hold the microphone (about 150 MB). Nothing is sent anywhere, and nothing is ever sent for you — what you say lands in the box for you to read first.';
const CLOUD = 'Leave this off and what you say is written down here on this machine. Switch it on and the recording of your voice is sent to Groq instead, which is quicker.';
const HOOKS = 'Another program on this machine can start one task here. This app listens on this machine only — nothing from the internet can reach it — and a call only counts if it is signed with the secret below.';
const TELLS = 'You do not have to come and look. When something finishes or falls over, you hear about it, and each morning you get a short note about the day ahead. Finished work arrives quietly; anything that needs you makes a sound.';
const GROUP = 'One chat with everybody in it gets long. A Telegram group with Topics on gives each person a room of their own: you write in Maya\'s room and you are talking to Maya, with nothing to type first. Everything above keeps working — use whichever you like.';
const STEPS = [
  'In Telegram, make a new group and call it anything you like.',
  'Open the group\'s settings and turn Topics on.',
  'Add your bot to the group, then make it an administrator with "Manage topics".',
  'Show a pairing code below and send it in the group. The rooms appear by themselves.',
];

export function ReachPanel() {
  const [state, setState] = useState<ReachState | null>(null);
  const [stage, setStage] = useState<Stage | null>(null);
  const [token, setToken] = useState('');
  const [problem, setProblem] = useState('');
  const [hook, setHook] = useState({ name: '', boardId: '', assignee: '' });
  const [made, setMade] = useState<Made | null>(null);
  const boards = (stage?.cards ?? []).filter((card): card is Card & { kind: 'board' } => card.kind === 'board');

  useEffect(() => {
    getReach().then(remember).catch((error: Error) => setProblem(error.message));
    getStage().then(setStage).catch(() => {});
  }, []);
  // A phone pairs, or Telegram falls over, while the founder is looking at this. It all happens on this machine, so
  // asking again every few seconds costs nothing and the screen is never out of date.
  useEffect(() => {
    if (!state?.on) return;
    const timer = setInterval(() => { getReach().then(remember).catch(() => {}); }, 3000);
    return () => clearInterval(timer);
  }, [state?.on]);

  // The conversation hears about the voice switch from here: a microphone appears in the ask box the moment it is on.
  const remember = (next: ReachState) => { voiceIs(next); setState(next); };
  const attempt = (work: Promise<ReachState>) => { setProblem(''); work.then(remember).catch((error: Error) => { setProblem(error.message); getReach().then(remember).catch(() => {}); }); };
  // A switch moves under the founder's finger, not a moment later when the server has written the file down.
  const flip = (patch: { on?: boolean; voice?: boolean; cloudSpeech?: boolean }) => { setState((held) => (held ? { ...held, ...patch } : held)); attempt(putReach(patch)); };
  const tells = (patch: Partial<ReachState['updates']>) => { setState((held) => (held ? { ...held, updates: { ...held.updates, ...patch } } : held)); attempt(putReach({ updates: patch })); };
  const left = state?.pairing ? Math.max(0, Math.round((state.pairing.until - Date.now()) / 60_000)) : 0;

  async function add() {
    setProblem('');
    try {
      setMade(await makeHook({ name: hook.name.trim(), boardId: hook.boardId, ...(hook.assignee ? { assignee: hook.assignee } : {}) }));
      setHook({ name: '', boardId: hook.boardId, assignee: hook.assignee });
      remember(await getReach());
    } catch (error) { setProblem((error as Error).message); }
  }

  return (
    <PanelShell name="reach" title="Reach you anywhere" note={state?.on ? 'Telegram is on' : 'Everything here is off'}>
      {problem && <p className="msg--problem">{problem}</p>}
      {!state && <p className="panel__empty">Reading how you like to be reached…</p>}
      {state && (
        <div className="reach">
          <section className="reach__part">
            <h3>Your phone, through Telegram</h3>
            <p className="reach__plain">{LEAVES}</p>
            {!state.hasToken && (
              <>
                <p className="reach__plain reach__quiet">{HOW}</p>
                <div className="reach__row">
                  <input value={token} placeholder="Paste the token from BotFather" onChange={(event) => setToken(event.target.value)} aria-label="Bot token" />
                  <button type="button" className="primary" disabled={!token.trim()} onClick={() => { attempt(putReach({ token })); setToken(''); }}>Keep it</button>
                </div>
              </>
            )}
            {state.hasToken && (
              <div className="reach__row">
                <span className="reach__quiet">{state.fromEnv ? 'A bot token is set in your .env file.' : 'A bot token is kept on this machine.'}</span>
                {!state.fromEnv && <button type="button" onClick={() => attempt(putReach({ token: '', on: false }))}>Forget it</button>}
              </div>
            )}
            <label className="reach__switch">
              <input type="checkbox" checked={state.on} disabled={!state.hasToken} onChange={(event) => flip({ on: event.target.checked })} />
              <span>Let my people reach me on Telegram{state.hasToken ? '' : ' — paste a token first'}</span>
            </label>
            {state.trouble && <p className="reach__trouble">{state.trouble}</p>}
            {state.on && (
              <>
                <div className="reach__row">
                  <button type="button" onClick={() => attempt(newPairing())}>{state.pairing ? 'Show another code' : 'Show a pairing code'}</button>
                  {state.pairing && <span className="reach__quiet">Send it to your bot. It works for {left} more minute{left === 1 ? '' : 's'}, and stops after five wrong tries.</span>}
                </div>
                {state.pairing && <p className="reach__code">{state.pairing.code}</p>}
                <ul className="reach__list">
                  {state.paired.map((chat) => (
                    <li key={chat.chatId}>
                      <span>{chat.name}</span>
                      <span className="reach__row">
                        <label className="reach__switch reach__quiet">
                          <input type="checkbox" checked={!!chat.speak} onChange={(event) => attempt(speakTo(chat.chatId, event.target.checked))} />
                          <span>Answer me out loud</span>
                        </label>
                        <button type="button" onClick={() => attempt(forgetChat(chat.chatId))}>Forget</button>
                      </span>
                    </li>
                  ))}
                  {!state.paired.length && <li className="reach__quiet">No phone is paired yet.</li>}
                </ul>
              </>
            )}
          </section>

          {state.on && (
            <section className="reach__part">
              <h3>What I tell you, without being asked</h3>
              <p className="reach__plain">{TELLS}</p>
              <label className="reach__switch">
                <input type="checkbox" checked={state.updates.on} onChange={(event) => tells({ on: event.target.checked })} />
                <span>Tell me things without being asked</span>
              </label>
              {state.updates.on && (
                <>
                  <label className="reach__switch">
                    <input type="checkbox" checked={state.updates.finished} onChange={(event) => tells({ finished: event.target.checked })} />
                    <span>When work finishes, or falls over</span>
                  </label>
                  <label className="reach__switch">
                    <input type="checkbox" checked={state.updates.stuck} onChange={(event) => tells({ stuck: event.target.checked })} />
                    <span>When something could not start, or was missed while the app was closed</span>
                  </label>
                  <label className="reach__switch">
                    <input type="checkbox" checked={state.updates.digest} onChange={(event) => tells({ digest: event.target.checked })} />
                    <span>A short note each morning</span>
                  </label>
                  {state.updates.digest && (
                    <div className="reach__row">
                      <span className="reach__quiet">Send it at</span>
                      <input type="time" className="reach__time" value={state.updates.at} aria-label="When the morning note arrives" onChange={(event) => { if (event.target.value) tells({ at: event.target.value }); }} />
                    </div>
                  )}
                </>
              )}
            </section>
          )}

          {state.on && (
            <section className="reach__part">
              <h3>A room for each of them</h3>
              <p className="reach__plain">{GROUP}</p>
              {state.group
                ? (
                  <>
                    <ul className="reach__list">
                      <li>
                        <span>{state.group.title} <span className="reach__quiet">{state.group.people.length ? `· ${state.group.people.join(', ')}` : '· no rooms yet'}</span></span>
                        <button type="button" onClick={() => attempt(forgetGroup())}>Forget this group</button>
                      </li>
                    </ul>
                    {state.group.trouble && <p className="reach__trouble">{state.group.trouble}</p>}
                  </>
                )
                : <ol className="reach__steps">{STEPS.map((step) => <li key={step}>{step}</li>)}</ol>}
            </section>
          )}

          <section className="reach__part">
            <h3>Your voice</h3>
            <p className="reach__plain">{VOICE}</p>
            <label className="reach__switch">
              <input type="checkbox" checked={state.voice} onChange={(event) => flip({ voice: event.target.checked })} />
              <span>Let me talk to my people, and hear them</span>
            </label>
            {state.voice && <>
              <p className="reach__plain reach__quiet">{CLOUD}</p>
              <label className="reach__switch">
                <input type="checkbox" checked={state.cloudSpeech} onChange={(event) => flip({ cloudSpeech: event.target.checked })} />
                <span>Let Groq write down what I say</span>
              </label>
              <p className="reach__quiet">Right now, what you say is written down {state.listening === 'cloud' ? 'at Groq' : 'here, on this machine'}.</p>
            </>}
          </section>

          <section className="reach__part">
            <h3>Calls from another program</h3>
            <p className="reach__plain">{HOOKS}</p>
            <ul className="reach__list">
              {state.hooks.map((one) => (
                <li key={one.id}>
                  <span>{one.name} <span className="reach__quiet">→ {boards.find((board) => board.id === one.boardId) ? 'a board' : 'a board that has gone'}{one.assignee ? `, ${stage?.rooms.find((room) => room.id === one.assignee)?.name ?? 'someone'}` : ', nobody yet'}</span></span>
                  <button type="button" onClick={() => attempt(dropHook(one.id))}>Remove</button>
                </li>
              ))}
              {!state.hooks.length && <li className="reach__quiet">Nothing can call in yet.</li>}
            </ul>
            {boards.length === 0
              ? <p className="reach__quiet">Add a task board to the stage first: that is where a call in leaves its task.</p>
              : (
                <div className="reach__row">
                  <input value={hook.name} placeholder="What to call the task it starts" onChange={(event) => setHook({ ...hook, name: event.target.value })} aria-label="Task title" />
                  <select value={hook.boardId} onChange={(event) => setHook({ ...hook, boardId: event.target.value })} aria-label="Board">
                    <option value="">Which board</option>
                    {boards.map((board, at) => <option key={board.id} value={board.id}>Board {boards.length > 1 ? at + 1 : ''}</option>)}
                  </select>
                  <select value={hook.assignee} onChange={(event) => setHook({ ...hook, assignee: event.target.value })} aria-label="Who does it">
                    <option value="">Nobody yet</option>
                    {(stage?.rooms ?? []).map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
                  </select>
                  <button type="button" className="primary" disabled={!hook.name.trim() || !hook.boardId} onClick={() => void add()}>Make one</button>
                </div>
              )}
            {made && (
              <div className="reach__made">
                <p>This is the only time you will see this secret. Keep it somewhere safe.</p>
                <code>{made.url}</code>
                <code>{made.secret}</code>
                <p className="reach__quiet">The program that calls in sends the moment it called in an <code>x-cubicle-timestamp</code> header, and in <code>x-cubicle-signature</code> that moment, a dot and the body, signed with this secret (HMAC-SHA256, in hex). Anything older than five minutes is turned away.</p>
                <button type="button" onClick={() => setMade(null)}>I have kept it</button>
              </div>
            )}
          </section>
        </div>
      )}
    </PanelShell>
  );
}
