# Slices

A slice is one feature, dropped in as new files. **A slice never edits `index.ts`.** That file is shared by everyone,
so every feature that edits it collides with every other feature being built at the same time.

Put one `*.ts` file here. Default-export a `Slice` from `../install.ts`:

```ts
export default { name: 'reminders', order: 100, install(deps) { return { tools: [...], async tick() {} }; } } satisfies Slice;
```

`install(deps)` is called once at start. `deps` holds the workspace, the store, the seams, the people's books and the
http helpers — everything `index.ts` has. What you give back may include:

- `tools` — added to the one tool list before anybody is offered it.
- `route(req, res, path)` — return `true` when you answered the request, `false` to leave it alone. Built-in paths are
  tried first, so pick a path of your own under `/api/`.
- `tick()` — run on the same half-minute interval as everything else; a throw is written down and ignored.
- `offer(tools, stage, roomId)` — narrow what one person is offered for one turn. You may only take tools away.
- `close()` — called when the app is leaving. Take off everything you put on: keep what `deps.seams.on`,
  `hub.open` and `deps.attention.watch` hand back and call each one here. The unit test that installs this whole
  folder checks that nothing is left behind.

Files ending in `.test.ts` are not slices. A slice that will not import, or throws while installing, is named on the
console and skipped: a broken extra never stops the app from starting.

`deps.runs` is filled in just after start, so call it from a route, a tick or a tool — never while installing.

Things more than one slice needs live in `../slice-kit.ts`, never in another slice: `newId`, `which` (a program on
this machine, kept a minute), `offerWhenWired` (offer a list of tools only with one kind of card wired),
`sharedLibrary` and `patchStageVia`. `../seams.ts` has `withSystem` for adding a paragraph to the system prompt, and
`../readers.ts` has `getPublic` for reading the open web safely.

## Switches for checks

Set in the environment of a check or a test run, beside the other `STAGE_*` switches in the top README:

- `STAGE_OUTSIDE_WAIT` — how long, in milliseconds, the openends slice waits for each outside (MCP) program at start
  before leaving it out of this start. 4000 by default.
- `STAGE_TWENTY_IN_FAKE=1` — lets the Twenty mirror run in fake mode, for a check against a real Twenty. It is off in
  fake mode otherwise, so a test run never writes into somebody's CRM.
- `STAGE_FAKE_TELEGRAM=0` — turns off the stand-in Telegram that the reach slice uses in fake mode, for a check that
  wants no phone at all.
- `STAGE_BACKUP_DIR` — where backups go, over everything else. Without it: the folder chosen in Health for this workspace (kept in `backup-to.json` inside it); else `~/Cubicle backups` for the app's own workspace, and `<workspace>/backups` for any other workspace or a fake run.
- `STAGE_ENV_FILE` — the `.env` file the Keys panel and "Back up to…" write. The repository root's `.env` by
  default, and `.env` beside the workspace in fake mode, so a check run never writes into the founder's own keys.
