// Brings the small set of HyperFrames registry items the video studio uses into the repository, so a film renders
// with no network. Run with `pnpm vendor:hyperframes` — and only then: nothing at film time ever calls the registry.
//
// The registry's item files are not at guessable URLs, so the CLI is the only honest way in: a throwaway project is
// scaffolded, `hyperframes add <name>` is run once an item, and whatever file the CLI says it wrote is copied as it
// came — not a byte changed. What a film needs changed (the word list, the frame's size, the CDN links) is changed
// by the adapters in `server/media/registry/index.ts` when a film is put together, and a test holds every one of
// those changes to the files as they are here. So a re-run of this script that brings a reshaped item in fails a
// unit test, not somebody's film.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// The set, and what each is for. Small on purpose: every item here has an adapter and a job in a film.
const ITEMS: { name: string; job: string }[] = [
  { name: 'caption-pill-karaoke', job: 'captions of the clean and brand packs' },
  { name: 'caption-highlight', job: 'captions of the creator pack' },
  { name: 'caption-kinetic-slam', job: 'captions of the neon pack' },
  { name: 'whip-pan', job: 'the act-break transition of the creator pack' },
  { name: 'zoom-through-transition', job: 'the act-break transition of the neon pack' },
  { name: 'flash-through-white', job: 'the act-break transition of the clean and brand packs' },
  { name: 'count-up', job: 'the figure on a stat scene' },
  { name: 'animated-bar-chart', job: 'the columns of a chart scene whose labels are short' },
];

const app = resolve(import.meta.dirname, '..');
const bin = join(app, 'node_modules/.bin/hyperframes');
const home = join(app, 'server/media/registry');
const version = JSON.parse(await readFile(join(app, 'node_modules/hyperframes/package.json'), 'utf8')).version as string;
// The CLI installs a dozen agent skills into the home directory on `init` unless it is told not to.
const env = { ...process.env, HYPERFRAMES_SKIP_SKILLS: '1', CI: '1' };

const scratch = await mkdtemp(join(tmpdir(), 'stage-hf-vendor-'));
try {
  await run(bin, ['init', 'p', '--resolution', 'landscape', '--non-interactive'], { cwd: scratch, env });
  const project = join(scratch, 'p');
  await mkdir(join(home, 'items'), { recursive: true });
  const items: { name: string; type: string; file: string; bytes: number; sha256: string; job: string }[] = [];
  for (const { name, job } of ITEMS) {
    const { stdout } = await run(bin, ['add', name, '--json', '--no-clipboard'], { cwd: project, env });
    const told = JSON.parse(stdout.slice(stdout.indexOf('{'))) as { ok: boolean; type: string; written: string[] };
    const html = told.written.filter((one) => one.endsWith('.html'));
    if (!told.ok || html.length !== 1) throw new Error(`${name}: expected the CLI to write one html file, it wrote ${JSON.stringify(told.written)}`);
    const file = `${name}.html`;
    await copyFile(html[0], join(home, 'items', file));
    const bytes = await readFile(join(home, 'items', file));
    items.push({ name, type: told.type.replace('hyperframes:', ''), file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), job });
    console.log('vendored', name, `(${told.type}, ${bytes.length} bytes, from ${basename(html[0])})`);
  }
  const manifest = {
    source: 'https://github.com/heygen-com/hyperframes (registry/), installed with `hyperframes add`',
    licence: 'Apache-2.0',
    cli: version,
    fetched: new Date().toISOString().slice(0, 10),
    items,
  };
  await writeFile(join(home, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(home, 'CREDITS.md'), credits(manifest));
  console.log(`\n${items.length} items in server/media/registry/ · run \`npx vitest run server/media/registry\` to hold the adapters to them`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}

function credits(manifest: { cli: string; fetched: string; items: { name: string; type: string; job: string }[] }): string {
  return `# Registry graphics — where they came from, and under what terms

The files in \`items/\` are blocks and components from the **HyperFrames registry**
(<https://github.com/heygen-com/hyperframes>, directory \`registry/\`), copyright HeyGen and the HyperFrames
contributors, published under the **Apache License 2.0** (<https://www.apache.org/licenses/LICENSE-2.0>).

They were installed with \`hyperframes add <name>\` (CLI ${manifest.cli}) on ${manifest.fetched} by
\`scripts/vendor-hyperframes.ts\` and are kept here **exactly as the CLI wrote them**: \`manifest.json\` holds the
SHA-256 of every file and a test fails if one is edited by hand. That is deliberate. Apache-2.0 asks that a changed
file says it was changed, so the files are not changed: what a film needs different — its own words, its own frame
size, no CDN links — is substituted by the adapters in \`index.ts\` each time a film is put together, in the copy
that goes into the film and nowhere else.

| item | kind | used for |
| --- | --- | --- |
${manifest.items.map((one) => `| \`${one.name}\` | ${one.type} | ${one.job} |`).join('\n')}

What the adapters leave out of a film, because it would send a render to the network: the Google Fonts links
(Poppins, Anton, Montserrat, Space Mono, Bebas Neue, JetBrains Mono, Lato) and the jsDelivr copy of GSAP. The films
set their captions in the typefaces already bundled in \`templates/vendor/\` (see \`templates/assets/CREDITS.md\`)
and load the GSAP that is bundled beside them.

To refresh: \`pnpm vendor:hyperframes\`, then \`npx vitest run server/media/registry\`.
`;
}
