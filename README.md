# Founder accelerator (working title)

A canvas where a founder works with a small workforce of people, each in their own room. The founder stays
the operator; the people speed the founder up. Built slowly, one narrow slice at a time.

- Slices so far: **The Stage** (canvas, wallpaper, cards, wires) and **Talking rooms** (each room is a chat with
  that person; docs are real files; a wire to a doc lets the person read it). Specs in `docs/specs/`.
- Run it: `cd app && pnpm install && pnpm dev`, then open http://localhost:7420. Model keys come from `.env` at the
  repository root (`GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`); your data lives in `workspace/`.
- The earlier product, CUBICLE v2 (an self-running company), is archived: tag `v2-final`, branch `archive/v2`.
  Its documents, ledgers and lessons are under `docs/archive/v2/`.
