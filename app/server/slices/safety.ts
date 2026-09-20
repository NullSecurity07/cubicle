import { resolve } from 'node:path';
import { NO_UNDO_LINE, UNDO_LINE } from '../../shared/safety.ts';
import { projectDir } from '../coder.ts';
import { wired } from '../prompt.ts';
import { checkCall } from '../safety/blocks.ts';
import { createCheckpoints } from '../safety/checkpoints.ts';
import { redact, secretValues } from '../safety/keys.ts';
import { createRules } from '../safety/rules.ts';
import { overdue, UNANSWERED } from '../safety/waiting.ts';
import type { Slice } from '../install.ts';

// The safety net around everything the people do on the founder's own machine: what nothing gets past, a copy of a
// project folder before a coding agent is let into it, the standing yeses the founder gave, keys taken out of
// anything read back, and a question nobody answers turned into a no.
// It installs first (`order`) so its refusals are decided before any other extra has an opinion about a call.
const CALLS_HELD = 60;

export default {
  name: 'safety',
  order: 10,
  install(deps) {
    const secrets = secretValues();
    const checkpoints = createCheckpoints({ dir: deps.workspace });
    const rules = createRules(resolve(deps.workspace, 'approvals.json'));
    // The calls waiting for the founder right now, so that "always allow this" is made from the call itself rather
    // than from whatever a page claims it was.
    const held = new Map<string, { roomId: string; name: string; args: Record<string, unknown> }>();

    // The project folder wired to this person, the same one `delegate_coding` will work in. No card, no folder, or a
    // folder that is not there: no snapshot, and the receipt says the step cannot be undone.
    async function folderFor(roomId: string): Promise<string | null> {
      try {
        const stage = await deps.store.loadStage();
        const cards = (stage.cards ?? []).filter((one) => one.kind === 'project');
        const [id] = wired(stage, roomId, cards.map((one) => one.id));
        const card = cards.find((one) => one.id === id);
        return card && card.kind === 'project' ? projectDir(card.path, [deps.workspace, deps.root]) : null;
      } catch { return null; }
    }

    deps.seams.on('tool:before', async (payload, next) => {
      const { call } = payload;
      held.set(call.id, { roomId: payload.roomId, name: call.name, args: call.args });
      for (const old of [...held.keys()].slice(0, Math.max(0, held.size - CALLS_HELD))) held.delete(old);
      if (payload.refusal) return next(payload);
      const stopped = checkCall(call.name, call.args, secrets);
      if (stopped) return next({ ...payload, refusal: stopped });
      if (call.name === 'delegate_coding') {
        const dir = await folderFor(payload.roomId);
        if (dir) await checkpoints.take(call.id, payload.roomId, dir).catch(() => null);
      }
      // A standing yes only ever skips the question. A refusal from here, from a tool that is not ready or from
      // another extra still ends the step: nothing the founder allowed in advance can outvote a no.
      const allowed = await rules.allows(payload.roomId, call.name, call.args).catch(() => false);
      return next(allowed ? { ...payload, approved: true } : payload);
    });

    deps.seams.on('tool:after', async (payload, next) => {
      const { event } = payload;
      held.delete(event.id);
      let result = event.result ? redact(event.result, secrets) : event.result;
      if (event.name === 'delegate_coding') {
        const saved = await checkpoints.seal(event.id).catch(() => false);
        result = `${result ?? ''}\n\n${saved ? UNDO_LINE : NO_UNDO_LINE}`.trim();
      }
      return next({ ...payload, event: { ...event, ...(result === event.result ? {} : { result }) } });
    });

    return {
      async route(req, res, path) {
        const rule = /^\/api\/safety\/rules(?:\/([\w-]{1,80}))?$/.exec(path);
        if (rule && !rule[1] && req.method === 'GET') { deps.json(res, 200, await rules.list()); return true; }
        if (rule && !rule[1] && req.method === 'POST') {
          const asked = await deps.body(req);
          const call = held.get(String(asked.id ?? ''));
          if (!call) { deps.json(res, 404, { error: 'that step is not waiting for you any more' }); return true; }
          // The founder may have edited what goes out before saying yes; the rule is for what they really allowed.
          const edited = asked.args && typeof asked.args === 'object' ? asked.args as Record<string, unknown> : {};
          const args = { ...call.args, ...Object.fromEntries(Object.entries(edited).filter(([key, value]) => key in call.args && typeof value === typeof call.args[key])) };
          const stage = await deps.store.loadStage();
          const who = stage.rooms.find((one) => one.id === call.roomId)?.name ?? 'Someone';
          const made = await rules.remember({ roomId: call.roomId, who, tool: call.name, args });
          deps.json(res, made ? 200 : 400, made ?? { error: 'there is nothing in this step to remember a rule about' });
          return true;
        }
        if (rule && rule[1] && req.method === 'DELETE') { await rules.forget(rule[1]); deps.json(res, 200, { ok: true }); return true; }

        const undone = /^\/api\/safety\/undo\/([\w.:-]{1,120})$/.exec(path);
        if (undone && req.method === 'POST') {
          const put = await checkpoints.undo(undone[1]);
          // The step is taken out of the conversation too, so nobody is left reading a report of work that is no
          // longer there. The founder's own words stay: only the reply goes.
          const messages = await deps.store.readChat(put.roomId).catch(() => []);
          const said = messages.find((one) => one.tools?.some((tool) => tool.id === undone[1]));
          if (said) await deps.store.cutChat(put.roomId, said.id, false);
          deps.json(res, 200, { ...put, cut: !!said });
          return true;
        }
        return false;
      },
      // Once every half minute, whatever has been waiting half a day. Answering it no releases the run that is
      // parked on it, and the founder reads in "Needs you" that it happened and why.
      async tick() {
        const now = Date.now();
        for (const entry of overdue(await deps.attention.list(), now)) {
          if (!deps.approvals.answer(entry.event!.id, { ok: false })) continue;
          await deps.attention.raise({
            id: `unanswered:${entry.event!.id}`, kind: 'run-failed', title: entry.title, detail: UNANSWERED,
            at: now, who: entry.who, roomId: entry.roomId, cardId: entry.cardId, taskId: entry.taskId,
          });
        }
      },
    };
  },
} satisfies Slice;
