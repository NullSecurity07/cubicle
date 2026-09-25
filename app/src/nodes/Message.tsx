import type { ChatMessage, ToolEvent } from '../../shared/model';
import { safeHost } from '../../shared/sources';
import { fileUrl } from '../api';
import { compact } from '../numbers';
import { SLICES } from '../slices';
import { Approval } from './Approval';
import { Words } from './Rich';

const VERBS: Record<string, [doing: string, done: string]> = {
  read_doc: ['Reading', 'Read'], write_doc: ['Rewriting', 'Rewrote'], append_doc: ['Adding to', 'Added to'], create_doc: ['Creating', 'Created'],
  remember: ['Remembering', 'Remembered'], propose_task: ['Proposing', 'Proposed'], list_tasks: ['Reading', 'Read'],
  ask_person: ['Asking', 'Asked'], code_task: ['Coding:', 'Coded:'], code_reply: ['Telling the coder:', 'Told the coder:'], code_stop: ['Stopping the coder', 'Stopped the coder'], code_status: ['Checking the coder', 'Checked the coder'],
  send_email: ['Sending email to', 'Emailed'], read_inbox: ['Checking', 'Checked'], run_code: ['Running', 'Ran'],
  web_search: ['Searching', 'Searched'], web_fetch: ['Reading', 'Read'], browse: ['Browsing', 'Browsed'],
  recall: ['Looking up', 'Looked up'], reflect: ['Looking back at', 'Looked back at'], propose_decision: ['Proposing', 'Proposed'], read_decision: ['Reading', 'Read'],
  list_files: ['Looking at', 'Looked at'], read_file: ['Reading', 'Read'], write_file: ['Saving', 'Saved'],
  generate_image: ['Drawing', 'Drew'], generate_voice: ['Saying', 'Said'], generate_video: ['Filming', 'Filmed'], edit_video: ['Editing', 'Edited'],
  delegate_task: ['Handing to', 'Handed to'], search_source: ['Searching', 'Searched'], propose_source: ['Proposing', 'Proposed'],
  map_folder: ['Mapping the folder', 'Mapped the folder'], ask_graph: ['Asking the map:', 'Asked the map:'], affected_by: ['Tracing what depends on', 'Traced what depends on'],
  add_lead: ['Adding lead', 'Added lead'], score_lead: ['Scoring', 'Scored'], note_lead: ['Noting on', 'Noted on'], move_lead: ['Moving', 'Moved'],
  list_leads: ['Reading', 'Read'], find_leads: ['Finding', 'Found'],
  make_deck: ['Making the deck', 'Made the deck'], edit_deck: ['Editing the deck', 'Edited the deck'], read_deck: ['Reading the deck', 'Read the deck'],
  make_site: ['Making the site', 'Made the site'], edit_site: ['Editing the site', 'Edited the site'], read_site: ['Reading the site', 'Read the site'],
  read_metrics: ['Reading the numbers', 'Read the numbers'], log_metric: ['Writing a number', 'Wrote a number'], propose_target: ['Suggesting a target', 'Suggested a target'],
  read_interview: ['Reading the interview', 'Read the interview'],
  read_survey: ['Reading the survey', 'Read the survey'],
  read_runway: ['Reading the runway', 'Read the runway'], propose_flow: ['Suggesting a flow', 'Suggested a flow'], propose_scenario: ['Suggesting a scenario', 'Suggested a scenario'],
  read_youtube: ['Reading the video', 'Read the video'], read_feed: ['Reading the feed of', 'Read the feed of'], read_reddit: ['Reading Reddit:', 'Read Reddit:'],
  use_skill: ['Reading the skill', 'Read the skill'], note_founder: ['Noting about you:', 'Noted about you:'], ask_founder: ['Asking you:', 'Asked you:'],
  crawl_site: ['Reading the site', 'Read the site'], watch_page: ['Watching', 'Watching'], list_watches: ['Listing', 'Listed'], stop_watching: ['Stopping the watch on', 'Stopped watching'],
};
// Where the founder was when they said it, when they were not at the stage.
const VIA: Record<NonNullable<ChatMessage['via']>, string> = { phone: 'from your phone', call: 'from another program' };

// A tool from an outside (MCP) server is named `mcp_<server>_<tool>`; the receipt says it in words.
const outside = (name: string) => name.replace(/^mcp_/, '').replace(/_/g, ' ');

// What a receipt says about one tool call: the verb while it runs, the verb once it is done, and what it was about.
export function receiptOf(tool: Pick<ToolEvent, 'name' | 'args' | 'question'>): { doing: string; done: string; subject: string } {
  if (tool.name.startsWith('mcp_')) return { doing: 'Using', done: 'Used', subject: outside(tool.name) };
  const [doing, done] = VERBS[tool.name] ?? [tool.name, tool.name];
  const many = (tool.args.queries ?? tool.args.urls) as unknown;
  // A search inside a source names the site before its queries, so the founder sees where a person looked.
  const subject = tool.name === 'search_source' ? `${tool.args.source ?? ''}: ${(Array.isArray(many) ? many : []).join(', ')}`
    : tool.name === 'propose_source' ? safeHost(String(tool.args.url ?? ''))
    : Array.isArray(many) ? (many.length === 1 ? String(many[0]) : `${many.length} ${tool.args.queries ? 'queries' : 'pages'} at once`)
    : tool.name === 'browse' ? [tool.args.action, tool.args.url ?? tool.args.ref].filter(Boolean).join(' ')
    : tool.name === 'remember' ? String(tool.args.fact ?? '').slice(0, 60) : tool.name === 'list_tasks' ? 'the board'
    : tool.name === 'add_lead' ? `${String(tool.args.person ?? '')} at ${String(tool.args.company ?? '')}`.slice(0, 60)
    : tool.name === 'score_lead' ? `${String(tool.args.lead ?? '').slice(0, 50)}: ${String(tool.args.score ?? '')}/10`
    : tool.name === 'move_lead' ? `${String(tool.args.lead ?? '').slice(0, 45)} to ${String(tool.args.stage ?? '')}`
    : tool.name === 'note_lead' ? String(tool.args.lead ?? '').slice(0, 60) : tool.name === 'list_leads' ? 'the leads'
    : tool.name === 'find_leads' ? `${String(tool.args.count ?? '')} leads with OpenOutreach${tool.args.emails === true ? ', with emails' : ''}`
    : tool.name === 'ask_person' ? String(tool.args.name ?? '') : tool.name === 'recall' ? String(tool.args.query ?? '').slice(0, 60) : tool.name === 'reflect' ? String(tool.args.about ?? '').slice(0, 60)
    : tool.name === 'use_skill' ? String(tool.args.name ?? '').slice(0, 60)
    : tool.name === 'note_founder' ? String(tool.args.fact ?? '').replace(/\s+/g, ' ').slice(0, 60)
    : tool.name === 'ask_founder' ? String(tool.question ?? tool.args.question ?? '').replace(/\s+/g, ' ').slice(0, 60)
    : tool.name === 'code_task' ? String(tool.args.brief ?? '').replace(/\s+/g, ' ').slice(0, 60)
    : tool.name === 'ask_graph' ? String(tool.args.question ?? '').replace(/\s+/g, ' ').slice(0, 60)
    : tool.name === 'affected_by' ? String(tool.args.name ?? '').slice(0, 60)
    : tool.name === 'code_reply' ? String(tool.args.text ?? '').replace(/\s+/g, ' ').slice(0, 60)
    : tool.name === 'generate_image' ? String(tool.args.prompt ?? '').replace(/\s+/g, ' ').slice(0, 60)
    : tool.name === 'generate_voice' ? `"${String(tool.args.text ?? '').replace(/\s+/g, ' ').slice(0, 55)}"`
    : tool.name === 'generate_video' ? String(tool.args.title ?? '').replace(/\s+/g, ' ').slice(0, 60)
    : tool.name === 'edit_video' ? String(tool.args.notes ?? '').replace(/\s+/g, ' ').slice(0, 60)
    : tool.name === 'run_code' ? `${tool.args.language ?? ''} code` : tool.name === 'read_inbox' ? 'the mailbox'
    : tool.name === 'read_youtube' ? String(tool.args.url ?? '').replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)
    : tool.name === 'crawl_site' || tool.name === 'watch_page' || tool.name === 'stop_watching' ? String(tool.args.url ?? '').replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)
    : tool.name === 'list_watches' ? 'the watched pages'
    : tool.name === 'read_feed' ? safeHost(String(tool.args.url ?? '')) || String(tool.args.url ?? '').slice(0, 60)
    : tool.name === 'read_reddit' ? String(tool.args.query ?? tool.args.url ?? (tool.args.subreddit ? `r/${tool.args.subreddit}` : '')).slice(0, 60)
    : String(tool.args.to ?? tool.args.doc ?? tool.args.title ?? tool.args.path ?? (tool.name === 'list_files' ? 'the shared files' : ''));
  return { doing, done, subject };
}

// One tool call: what the person did, in a line. Opens to show exactly what was sent and what came back.
function Chip({ tool }: { tool: ToolEvent }) {
  if (tool.waiting) return <Approval tool={tool} />;
  const state = tool.ok === undefined ? 'run' : tool.ok ? 'ok' : 'fail';
  const { doing, done, subject } = receiptOf(tool);
  return (
    <details className={`chip chip--${state}`}>
      <summary><span className="chip__mark" aria-hidden="true" />{state === 'fail' ? `Could not: ${doing.toLowerCase()}` : state === 'run' ? doing : done} {subject}</summary>
      <pre>{JSON.stringify(tool.args, null, 2)}{tool.result ? `\n\n${tool.result}` : ''}</pre>
      {/* What a slice offers to do about this one step, if any of them has anything to say about it. */}
      {SLICES.map((slice) => (slice.receipt ? <slice.receipt key={slice.name} tool={tool} /> : null))}
    </details>
  );
}

type Actions = { onEdit?: () => void; onDelete?: () => void; onRegenerate?: () => void };

function Attachments({ message }: { message: Pick<ChatMessage, 'attachments'> }) {
  if (!message.attachments?.length) return null;
  return (
    <div className="attached">
      {message.attachments.map((file) => (file.type.startsWith('image/')
        ? <img key={file.path} src={fileUrl(file.path)} alt={file.path.split('/').pop()} loading="lazy" />
        : <a key={file.path} href={fileUrl(file.path)} target="_blank" rel="noreferrer">{file.path.split('/').pop()?.replace(/^[a-z0-9]+-/, '')}</a>))}
    </div>
  );
}

function Tools({ onEdit, onDelete, onRegenerate }: Actions) {
  if (!onEdit && !onDelete && !onRegenerate) return null;
  return (
    <span className="msg__tools nodrag">
      {onRegenerate && <button type="button" aria-label="Regenerate" title="Answer again" onClick={onRegenerate}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.500-3.500M13 2.500v3h-3" /></svg></button>}
      {onEdit && <button type="button" aria-label="Edit message" title="Edit and ask again" onClick={onEdit}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13l.600-2.800L10.800 3l2.200 2.200-7.200 7.200z" /></svg></button>}
      {onDelete && <button type="button" aria-label="Delete message" title="Delete (kept in the workspace trash)" onClick={onDelete}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg></button>}
    </span>
  );
}

// A reply still streaming has no id and no room yet, so what a slice draws at its foot waits until it is finished.
type Shown = Omit<ChatMessage, 'id' | 'at'> & Partial<Pick<ChatMessage, 'id' | 'at'>>;

export function Message({ message, live = false, roomId, ...actions }: { message: Shown; live?: boolean; roomId?: string } & Actions) {
  if (message.role === 'user') return message.from
    ? <div className="msg msg--colleague"><span>{message.from} asked</span>{message.text}</div>
    // The founder is not always at the stage: when they said this somewhere else, the bubble says quietly where.
    : <div className="msg msg--user">{message.via && <span className="msg__via">{VIA[message.via]}</span>}<Attachments message={message} />{message.text}<Tools {...actions} /></div>;
  const tokens = message.usage ? message.usage.input + message.usage.output : 0;
  return (
    <div className="msg msg--assistant">
      {message.tools?.map((tool) => <Chip key={tool.id} tool={tool} />)}
      {message.text && <div className="md"><Words text={message.text} /></div>}
      {!live && message.provider && (
        <div className="msg__foot">
          {message.provider} · {message.model}{tokens ? ` · ${compact(tokens)} tokens` : ''}{message.stopped ? ' · stopped' : ''}
          <Tools {...actions} />
          {/* What a slice offers to do with this finished reply, where the reply's own actions are. */}
          {message.id && roomId && SLICES.map((slice) => (slice.reply ? <slice.reply key={slice.name} message={{ ...message, id: message.id!, at: message.at ?? 0 }} roomId={roomId} /> : null))}
        </div>
      )}
    </div>
  );
}
