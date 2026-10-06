// The app as a systemd user service, so it keeps working while its window is closed.
//   pnpm service:install   write the unit (it is not switched on; the command that does it is printed)
//   pnpm service:install --print   show the unit and write nothing
//   pnpm service:status    installed, switched on, running
//   pnpm service:remove    switch it off and take the unit away
// It always runs the main checkout, even when this is run from a worktree: a service is the founder's app, not a branch.
import { resolve } from 'node:path';
import { SERVICE, installService, removeService, serviceInput, serviceState, unitText } from '../server/service.ts';

const input = serviceInput({ from: resolve(import.meta.dirname, '../..') });

const [what = 'status', ...rest] = process.argv.slice(2);
if (process.platform !== 'linux') { console.log('A service needs systemd, which this machine does not have. The app runs while its window is open.'); process.exit(1); }

if (what === 'install') {
  if (rest.includes('--print')) { process.stdout.write(unitText(input)); process.exit(0); }
  const { path, next } = await installService(input);
  console.log(`Wrote ${path}`);
  console.log(`It runs ${input.app} with the workspace ${input.workspace}, and nothing has been switched on.`);
  console.log(`To start it now and at every login:\n  ${next}`);
  console.log('To keep it running after you log out as well: loginctl enable-linger');
} else if (what === 'remove') {
  const { path, removed } = await removeService();
  console.log(removed ? `Switched ${SERVICE} off and removed ${path}.` : `There was no ${SERVICE} to remove.`);
} else if (what === 'status') {
  const state = await serviceState();
  if (!state.systemd) console.log('systemctl is not here, so the app runs only while its window is open.');
  else if (!state.installed) console.log(`Not installed. The app runs only while its window is open. pnpm service:install writes ${state.path}.`);
  else console.log([
    `Installed at ${state.path}`,
    `Starts at login: ${state.enabled ? 'yes' : 'no'}`,
    `Running now: ${state.active === 'active' ? 'yes' : `no (${state.active})`}`,
    ...(state.enabled ? [] : [`To switch it on: systemctl --user enable --now ${SERVICE}`]),
    ...(state.active === 'failed' ? [`What went wrong: journalctl --user -u ${SERVICE} -n 50`] : []),
  ].join('\n'));
} else {
  console.log('pnpm service:install | service:status | service:remove');
  process.exit(1);
}
