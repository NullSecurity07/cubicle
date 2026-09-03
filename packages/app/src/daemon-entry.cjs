// The tray runs the daemon on the system Node, from its build output — never through tsx. A checkout that was
// never built has no dist/cli.js, and spawning it would fail silently, so resolving it is a loud step of its own.
const fs = require('node:fs');
const path = require('node:path');

/** Absolute path to the built daemon CLI under `root`, or throws telling the owner how to build it. */
function resolveDaemonEntry(root) {
  const entry = path.join(root, 'packages', 'daemon', 'dist', 'cli.js');
  if (!fs.existsSync(entry)) throw new Error('daemon not built: run pnpm -r build');
  return entry;
}

module.exports = { resolveDaemonEntry };
