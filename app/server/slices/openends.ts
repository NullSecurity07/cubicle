import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Slice } from '../install.ts';
import { backupDir, listBackups, makeBackup } from '../openends/backup.ts';
import { checkAll } from '../openends/health.ts';
import { createInsights } from '../openends/insights.ts';
import { connectAll, createSafeBook, FILE, loadEntries, outsideTools, outsideView, type Connected } from '../openends/mcp.ts';
import { fileName, OUTSIDE, parseSkillFile, renderSkillFile } from '../openends/skillfile.ts';

// The open ends: tools that live in other programs, an honest answer about what is and is not working, a copy of
// everything the founder has written, what the work came to, and a skill that can travel.
// The tools a slice brings are collected once, while the app starts, so the outside programs are talked to here and
// nowhere else. One that is slow or broken is left out of this start and named on the screen.
const WAIT = Number(process.env.STAGE_OUTSIDE_WAIT ?? 4000);
const days = (path: string) => Math.min(Math.max(Number(new URL(path, 'http://localhost').searchParams.get('days')) || 7, 1), 30);

export default {
  name: 'openends',
  order: 120,
  async install(deps) {
    // A check run works on a throwaway workspace and has no business writing into the founder's own folders, so its
    // backups land beside that workspace instead.
    const dir = deps.fake && !process.env.STAGE_BACKUP_DIR ? join(deps.workspace, 'backups') : backupDir(process.env);
    const safe = createSafeBook(deps.workspace);
    const { entries, problem } = await loadEntries(deps.workspace);
    // A file the founder wrote wrong is one row on the screen, never a start that fails.
    const broken: Connected[] = problem ? [{ entry: { name: FILE }, rpc: null, tools: [], ok: false, detail: problem }] : [];
    const connections = [...broken, ...(entries.length ? await connectAll(entries, WAIT) : [])];
    for (const one of connections) if (!one.ok && one.entry.name !== FILE) console.log(`outside tool ${one.entry.name}: ${one.detail}`);

    const insights = createInsights({
      workspace: deps.workspace, skills: deps.skills,
      nameOf: async (roomId) => (await deps.store.loadStage()).rooms.find((one) => one.id === roomId)?.name ?? roomId,
    });
    const health = () => checkAll({
      workspace: deps.workspace, root: deps.root, backupDir: dir,
      backups: () => listBackups(dir),
      outside: () => connections.map((one) => ({ name: one.entry.name, ok: one.ok, detail: one.detail })),
    });

    return {
      tools: outsideTools(connections, safe),
      async route(req, res, path) {
        if (path === '/api/health' && req.method === 'GET') { deps.json(res, 200, { checks: await health() }); return true; }
        if (path === '/api/insights' && req.method === 'GET') { deps.json(res, 200, await insights.read(days(req.url ?? '/'))); return true; }
        if (path === '/api/backups' && req.method === 'GET') { deps.json(res, 200, { dir, kept: 5, backups: await listBackups(dir) }); return true; }
        if (path === '/api/backups' && req.method === 'POST') {
          const made = await makeBackup({ workspace: deps.workspace, dir });
          deps.json(res, 200, { ...made, dir, kept: 5, backups: await listBackups(dir) });
          return true;
        }
        if (path === '/api/outside' && req.method === 'GET') { deps.json(res, 200, { file: join(deps.workspace, FILE), servers: await outsideView(connections, safe) }); return true; }
        if (path === '/api/outside/safe' && req.method === 'POST') {
          const asking = await deps.body(req);
          if (typeof asking?.name !== 'string' || !asking.name) { deps.json(res, 400, { error: 'say which tool' }); return true; }
          await safe.set(asking.name, asking.safe === true);
          deps.json(res, 200, { file: join(deps.workspace, FILE), servers: await outsideView(connections, safe) });
          return true;
        }
        // A skill in: the same door everything else goes through, so the same caps hold. It arrives switched off.
        if (path === '/api/skill-files' && req.method === 'POST') {
          const sent = await deps.body(req);
          const text = String(sent?.text ?? '');
          if (text.length > 20_000) { deps.json(res, 400, { error: 'that file is far longer than a skill can be' }); return true; }
          try {
            const fields = parseSkillFile(text);
            const born = await deps.skills.create({ ...fields, by: { roomId: '', name: 'Somebody outside' }, source: { kind: 'taught', ref: OUTSIDE } });
            deps.json(res, 200, await deps.skills.setState(born.id, 'off'));
          } catch (error) { deps.json(res, 400, { error: (error as Error).message }); }
          return true;
        }
        // And out: one file, named after the skill, which another machine can read back in.
        const out = /^\/api\/skill-files\/([a-z0-9-]{1,80})$/.exec(path)?.[1];
        if (out && req.method === 'GET') {
          const skill = await deps.skills.get(out);
          deps.json(res, skill ? 200 : 404, skill ? { file: fileName(skill), text: renderSkillFile(skill) } : { error: 'unknown skill' });
          return true;
        }
        // What the founder wrote down about the outside programs, so the screen can show it as it is.
        if (path === '/api/outside/file' && req.method === 'GET') {
          deps.json(res, 200, { file: join(deps.workspace, FILE), text: await readFile(join(deps.workspace, FILE), 'utf8').catch(() => '') });
          return true;
        }
        return false;
      },
      async close() { for (const one of connections) await one.rpc?.close().catch(() => {}); },
    };
  },
} satisfies Slice;
