import { useEffect, useState } from 'react';
import type { AllowRule } from '../../../shared/safety';
import { PanelShell } from '../../overlay/PanelShell';
import { forgetRule, getRules } from './api';

const since = (at: number) => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

// Every standing yes the founder has given, and the way to take one back. The window mounts it while it is open.
export function AllowedPanel() {
  const [rules, setRules] = useState<AllowRule[]>([]);
  const [problem, setProblem] = useState('');

  useEffect(() => { getRules().then(setRules).catch((error: Error) => setProblem(error.message)); }, []);

  const take = (id: string) => { forgetRule(id).then(getRules).then(setRules).catch((error: Error) => setProblem(error.message)); };

  return (
    <PanelShell name="safety" title="Always allowed" note={rules.length ? `${rules.length} standing` : undefined}>
      {!rules.length && !problem && (
        <p className="panel__empty">
          Nothing stands allowed yet. When somebody asks to do something that reaches outside, you can say yes to that
          one address or site for good — and take it back here whenever you like.
        </p>
      )}
      {problem && <p className="msg--problem">{problem}</p>}
      <ul className="allowed">
        {rules.map((rule) => (
          <li key={rule.id} className="allowed__item">
            <div className="allowed__what">
              <b>{rule.who}</b>: {rule.label}, without asking you.
              <small>Since {since(rule.at)}</small>
            </div>
            <button type="button" className="playbook__act" onClick={() => take(rule.id)}>Take it back</button>
          </li>
        ))}
      </ul>
    </PanelShell>
  );
}
