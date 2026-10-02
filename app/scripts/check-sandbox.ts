// Check on this machine that the locked-down sandbox still runs the heavy Python a person reaches for: pandas and
// matplotlib, loaded from the package cache (fetched and hash-checked on first use, so the first run needs the
// network), a chart saved into the folder and read back. Too slow and too network-bound for the unit suite. Run with
// `pnpm check:sandbox`; STAGE_PY_PACKAGES points it at another package cache.
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCode } from '../server/sandbox.ts';

const dir = await mkdtemp(join(tmpdir(), 'check-sandbox-'));
const started = Date.now();
try {
  const result = await runCode({ language: 'python', code: "import pandas as pd\nimport matplotlib.pyplot as plt\nframe = pd.DataFrame({'month': [1, 2, 3], 'cash': [48000, 41500, 35000]})\nplt.plot(frame.month, frame.cash)\nplt.savefig('chart.png')\nprint(int(frame.cash.sum()))" }, dir);
  const chart = await stat(join(dir, 'chart.png')).then((file) => file.size, () => 0);
  const ok = result.ok && result.output === '124500' && chart > 1000;
  console.log(`${ok ? 'ok' : 'FAILED'}: pandas and matplotlib in the sandbox, ${((Date.now() - started) / 1000).toFixed(1)} s, chart ${chart} bytes${ok ? '' : `\n${result.output}`}`);
  process.exitCode = ok ? 0 : 1;
} finally { await rm(dir, { recursive: true, force: true }); }
