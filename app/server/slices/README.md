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
- `close()` — called when the app is leaving.

Files ending in `.test.ts` are not slices. A slice that will not import, or throws while installing, is named on the
console and skipped: a broken extra never stops the app from starting.

`deps.runs` is filled in just after start, so call it from a route, a tick or a tool — never while installing.
