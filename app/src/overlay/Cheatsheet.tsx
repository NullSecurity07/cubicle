import { Fragment, useEffect, useState, useSyncExternalStore } from 'react';
import { getKeys } from '../api';
import { capsOf, keysOf, onOverrides, overridesVersion, SHORTCUTS, WHEN_TITLE, type When } from '../keys';
import { commandWords } from './commands';
import { PanelShell } from './PanelShell';
import './cheatsheet.css';

const ORDER: When[] = ['anywhere', 'stage', 'room', 'overlay'];

// Every key and every word the app answers to, on one calm sheet. Both lists are read from the tables the handlers
// and the command bar themselves read, so what is written here is what the keys do.
export function Cheatsheet() {
  useSyncExternalStore(onOverrides, overridesVersion);
  const [found, setFound] = useState<{ file: string; problems: string[] } | null>(null);
  useEffect(() => { getKeys().then(setFound).catch(() => {}); }, []);
  const words = commandWords();

  return (
    <PanelShell name="keys" title="Keyboard shortcuts">
      <div className="cheatsheet">
        <div className="cheatsheet__columns">
          {ORDER.map((when) => (
            <section key={when} className="cheatsheet__group" aria-label={WHEN_TITLE[when]}>
              <h3>{WHEN_TITLE[when]}</h3>
              <ul>
                {SHORTCUTS.filter((row) => row.when === when).map((row) => (
                  <li key={row.id} data-shortcut={row.id}>
                    <span className="cheatsheet__keys">
                      {keysOf(row.id).map((chord, at) => (
                        <Fragment key={chord}>
                          {at > 0 && <span className="cheatsheet__or">or</span>}
                          <span className="cheatsheet__chord">
                            {capsOf(chord).map((cap, index) => <kbd key={index}>{cap}</kbd>)}
                            {row.with && <span className="cheatsheet__with">{row.with}</span>}
                          </span>
                        </Fragment>
                      ))}
                    </span>
                    <span className="cheatsheet__does">{row.does}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <section className="cheatsheet__words" aria-label="Command bar words">
          <h3>Command bar words</h3>
          <ul>
            {words.map((word) => (
              <li key={word.does}>
                <span className="cheatsheet__say">{word.say.map((say) => <q key={say}>{say}</q>)}</span>
                <span className="cheatsheet__does">{word.does}</span>
              </li>
            ))}
          </ul>
        </section>

        <footer className="cheatsheet__foot">
          <span>Change a key: edit keys.json in the workspace</span>
          <code>{found?.file ?? 'keys.json'}</code>
          {found?.problems.map((problem) => <p key={problem} className="cheatsheet__problem">{problem}</p>)}
        </footer>
      </div>
    </PanelShell>
  );
}
