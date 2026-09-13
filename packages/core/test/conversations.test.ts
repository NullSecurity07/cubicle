import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import type { Vault } from '../src/vault.js';
import { stringifyNote } from '../src/frontmatter.js';
import { createProposal } from '../src/proposals.js';
import { pantryNote } from '../src/pantry.js';
import { listConversations, readConversation, agentThreadId, DM_THREAD_ID, CONVERSATIONS_MAX, type Thread } from '../src/conversations.js';

let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-convo-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

const find = (id: string): Thread => listConversations(vault).find((t) => t.id === id)!;
/** The index sorts on what the vault says, so a fixture that wants an order has to set the mtime. */
const touch = (rel: string, iso: string) => { const t = new Date(iso); utimesSync(vault.abs(rel), t, t); };

// ---------- meeting.open's shape, and the board's ----------

/** Exactly what `meeting.open` writes between turns: `status: in_progress`, no decision. */
function openMeeting(rel: string, o: { id: string; room: string; facilitator: string; participants: string[]; agenda: string; turns: [number, string, string][] }): void {
  vault.writeText(rel, stringifyNote(
    { id: o.id, room: o.room, opened: '2026-09-13T09:00:00.000Z', facilitator: o.facilitator, participants: o.participants, status: 'in_progress' },
    `# ${o.room === 'board' ? 'Board' : 'Meeting'}: ${o.agenda}\n\n## Agenda\n\n${o.agenda}\n\n## Transcript\n\n${o.turns.map(([r, who, text]) => `**Round ${r} — ${who}:** ${text}`).join('\n\n')}\n`,
  ), 'daemon');
}

/** And what it writes when it closes: a `decision`, no status, a `## Decisions` section after the transcript. */
function closeMeeting(rel: string, o: { id: string; room: string; facilitator: string; participants: string[]; agenda: string; turns: [number, string, string][]; decision: string }): void {
  vault.writeText(rel, stringifyNote(
    { id: o.id, room: o.room, opened: '2026-09-13T09:00:00.000Z', facilitator: o.facilitator, participants: o.participants, decision: o.decision },
    `# ${o.room === 'board' ? 'Board' : 'Meeting'}: ${o.agenda}\n\n## Agenda\n\n${o.agenda}\n\n## Transcript\n\n${o.turns.map(([r, who, text]) => `**Round ${r} — ${who}:** ${text}`).join('\n\n')}\n\n## Decisions\n\nSee [[Decisions/${o.decision}]].\n`,
  ), 'daemon');
}

describe('meetings, and a board session in the same shape (ruling P8-2)', () => {
  it('reads a closed meeting: turns in order, participants, and not open', () => {
    closeMeeting('Meetings/2026-09-13-0900-meeting-abc123.md', {
      id: 'meet_abc123', room: 'meeting', facilitator: 'coo', participants: ['coo', 'cto', 'cmo'], agenda: 'The week',
      turns: [[1, 'coo', 'We shipped the site.'], [1, 'cto', 'Two incidents,\nboth closed.'], [2, 'coo', 'Good.']],
      decision: 'dec_abc123',
    });
    const t = find('meeting:meet_abc123');
    expect(t).toMatchObject({ kind: 'meeting', room: 'meeting', title: 'Meeting: The week', open: false, turns: 3 });
    expect(t.participants).toEqual(['coo', 'cto', 'cmo']);
    expect(t.last).toMatchObject({ who: 'coo', text: 'Good.' });
    const turns = readConversation(vault, 'meeting:meet_abc123');
    expect(turns.map((x) => x.who)).toEqual(['coo', 'cto', 'coo']);
    // A model's turn can be several lines; the whole of it is one turn, and `## Decisions` is not a turn at all.
    expect(turns[1].text).toBe('Two incidents,\nboth closed.');
    expect(turns.every((x) => x.at === null)).toBe(true);
  });

  it('a meeting still in progress is open — the office shows a LIVE dot on it', () => {
    openMeeting('Meetings/2026-09-13-1000-meeting-def456.md', {
      id: 'meet_def456', room: 'meeting', facilitator: 'coo', participants: ['coo', 'cto'], agenda: 'Still talking',
      turns: [[1, 'coo', 'First.']],
    });
    expect(find('meeting:meet_def456')).toMatchObject({ open: true, turns: 1 });
  });

  it('room: board makes it a board thread, with a board id — no fourth parser', () => {
    openMeeting('Meetings/2026-09-13-1100-board-nurseries.md', {
      id: 'meet_board1', room: 'board', facilitator: 'advisor_skeptic', participants: ['advisor_skeptic', 'advisor_operator', 'advisor_investor'],
      agenda: 'Meal kits for nurseries', turns: [[1, 'advisor_skeptic', 'What is the core assumption?']],
    });
    const t = find('board:meet_board1');
    expect(t).toMatchObject({ kind: 'board', room: 'board', title: 'Board: Meal kits for nurseries', open: true });
    expect(readConversation(vault, 'board:meet_board1')[0].text).toBe('What is the core assumption?');
    expect(listConversations(vault).some((x) => x.id === 'meeting:meet_board1')).toBe(false);
  });
});

// ---------- the pantry ----------

describe('the pantry note, written by pantryNote itself', () => {
  it('reads the chat and stops at the idea', () => {
    vault.writeText('Pantry/2026-09-13-clo-and-cmo.md', pantryNote({
      date: '2026-09-13', cycle: 4, participants: ['clo', 'cmo'],
      turns: [
        { role: 'clo', name: 'Mira Voss', text: 'Nurseries all cook from scratch and hate it.' },
        { role: 'cmo', name: 'Dev Anand', text: 'IDEA: weekly meal kits for nursery kitchens' },
      ],
      idea: 'weekly meal kits for nursery kitchens', filed: 'meal-kits-for-nursery-kitchens', why: 'new',
    }), 'daemon');
    const t = find('pantry:2026-09-13-clo-and-cmo');
    expect(t).toMatchObject({ kind: 'pantry', room: 'pantry', title: 'Pantry: clo and cmo', open: false, turns: 2 });
    expect(t.participants).toEqual(['clo', 'cmo']);
    const turns = readConversation(vault, 'pantry:2026-09-13-clo-and-cmo');
    expect(turns.map((x) => x.who)).toEqual(['Mira Voss', 'Dev Anand']);
    expect(turns[0].text).toBe('Nurseries all cook from scratch and hate it.');
    // `## Idea` is the verdict on the chat, not something anybody said in it.
    expect(turns.some((x) => /Filed as/.test(x.text))).toBe(false);
  });

  it('a chat nobody could hold has no turns and still indexes', () => {
    vault.writeText('Pantry/2026-09-13-clo-and-coo.md', pantryNote({
      date: '2026-09-13', cycle: 5, participants: ['clo', 'coo'], turns: [], idea: null, filed: null, why: '',
    }), 'daemon');
    expect(find('pantry:2026-09-13-clo-and-coo')).toMatchObject({ turns: 0, last: null });
  });
});

// ---------- colleague.message ----------

/** The section `colleague.message` appends to the recipient's note. */
const said = (to: string, from: string, id: string, kind: string, at: string, body: string) =>
  vault.appendText(`Messages/${to}.md`, `\n## ${at} from ${from} (${kind}) <!-- id:${id} -->\n\n${body}\n`, from);

describe('agent messages, grouped per unordered pair', () => {
  it('both directions land in one thread, in stamp order', () => {
    said('cto', 'dev_manager', 'msg_1', 'question', '2026-09-13T09:00:00.000Z', 'Which palette for the hero?');
    said('dev_manager', 'cto', 'msg_2', 'fyi', '2026-09-13T09:05:00.000Z', 're:msg_1 The amber one.');
    const id = agentThreadId('cto', 'dev_manager');
    expect(id).toBe('agents:cto+dev_manager');
    const t = find(id);
    expect(t).toMatchObject({ kind: 'agents', turns: 2, open: false });
    expect(t.participants).toEqual(['cto', 'dev_manager']);
    expect(t.last).toMatchObject({ who: 'cto', text: 're:msg_1 The amber one.' });
    expect(readConversation(vault, id).map((x) => x.who)).toEqual(['dev_manager', 'cto']);
    // The id is the same whichever way round the pair is named.
    expect(agentThreadId('dev_manager', 'cto')).toBe(id);
  });

  it('a different pair is a different thread, and the read marker is not part of what was said', () => {
    said('cto', 'dev_manager', 'msg_1', 'fyi', '2026-09-13T09:00:00.000Z', 'One.');
    said('cto', 'qa_lead', 'msg_2', 'fyi', '2026-09-13T09:01:00.000Z', 'Two.\n<!-- read:2026-09-13T09:02:00.000Z -->');
    expect(listConversations(vault).filter((x) => x.kind === 'agents')).toHaveLength(2);
    expect(readConversation(vault, agentThreadId('cto', 'qa_lead'))[0].text).toBe('Two.');
  });
});

// ---------- the cabin ----------

describe('the owner and the CEO', () => {
  it('one note is two turns when the CEO has replied under ## CEO', () => {
    const { path: rel } = createProposal(vault, { kind: 'message', from: 'owner', to: 'ceo', title: 'what now', body: 'What should we do about the nurseries?' }, 'owner');
    vault.updateNote(rel, (n) => ({ data: n.data, body: `${n.body.trimEnd()}\n\n## CEO\n\nI have queued discovery on it.\n` }), 'daemon');
    const t = find(DM_THREAD_ID);
    expect(t).toMatchObject({ kind: 'dm', title: 'You and the CEO', open: false, turns: 2 });
    const turns = readConversation(vault, DM_THREAD_ID);
    expect(turns.map((x) => x.who)).toEqual(['owner', 'ceo']);
    expect(turns[0].text).toBe('What should we do about the nurseries?');
    expect(turns[1].text).toBe('I have queued discovery on it.');
    expect(turns.every((x) => typeof x.at === 'string')).toBe(true);
  });

  it('there is no cabin thread until somebody has spoken', () => {
    expect(listConversations(vault).some((x) => x.kind === 'dm')).toBe(false);
  });
});

// ---------- the index itself ----------

describe('the index', () => {
  it('is newest first and capped', () => {
    for (let i = 0; i < CONVERSATIONS_MAX + 5; i++) {
      const rel = `Meetings/2026-09-13-${String(i).padStart(4, '0')}-meeting-m${i}.md`;
      closeMeeting(rel, { id: `meet_${i}`, room: 'meeting', facilitator: 'coo', participants: ['coo'], agenda: `M${i}`, turns: [[1, 'coo', 'x']], decision: `dec_${i}` });
      touch(rel, new Date(Date.parse('2026-09-13T00:00:00.000Z') + i * 60_000).toISOString());
    }
    const list = listConversations(vault);
    expect(list).toHaveLength(CONVERSATIONS_MAX);
    expect(list[0].id).toBe(`meeting:meet_${CONVERSATIONS_MAX + 4}`);
    for (let i = 1; i < list.length; i++) expect(list[i - 1].updated >= list[i].updated).toBe(true);
    // Capped in the list, still readable by id: a thread the owner opened is a thread they want to read.
    expect(readConversation(vault, 'meeting:meet_0')).toHaveLength(1);
  });

  it('an id nobody wrote reads as no turns rather than throwing', () => {
    expect(readConversation(vault, 'meeting:nope')).toEqual([]);
    expect(readConversation(vault, 'nonsense')).toEqual([]);
  });

  it('an empty vault has no conversations', () => {
    expect(listConversations(vault)).toEqual([]);
  });
});
