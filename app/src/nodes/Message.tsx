import type { ChatMessage, ToolEvent } from '../../shared/model';
import { fileUrl } from '../api';
import { SLICES } from '../slices';
import { Approval } from './Approval';
import { Words } from './Rich';

const VERBS: Record<string, [doing: string, done: string]> = {
  read_doc: ['Reading', 'Read'], write_doc: ['Rewriting', 'Rewrote'], append_doc: ['Adding to', 'Added to'], create_doc: ['Creating', 'Created'],
  remember: ['Remembering', 'Remembered'], propose_task: ['Proposing', 'Proposed'], list_tasks: ['Reading', 'Read'],
  ask_person: ['Asking', 'Asked'], delegate_coding: ['Coding:', 'Coded:'],
  send_email: ['Sending email to', 'Emailed'], read_inbox: ['Checking', 'Checked'], run_code: ['Running', 'Ran'],
  web_search: ['Searching', 'Searched'], web_fetch: ['Reading', 'Read'], browse: ['Browsing', 'Browsed'],
  recall: ['Looking up', 'Looked up'], propose_decision: ['Proposing', 'Proposed'], read_decision: ['Reading', 'Read'],
  list_files: ['Looking at', 'Looked at'], read_file: ['Reading', 'Read'], write_file: ['Saving', 'Saved'],
  generate_image: ['Drawing', 'Drew'], generate_voice: ['Saying', 'Said'], generate_video: ['Filming', 'Filmed'],
};
const compact = (count: number) => (count < 1000 ? String(count) : `${(count / 1000).toFixed(1)}k`);

// One tool call: what the person did, in a line. Opens to show exactly what was sent and what came back.
function Chip({ tool }: { tool: ToolEvent }) {
  if (tool.waiting) return <Approval tool={tool} />;
  const state = tool.ok === undefined ? 'run' : tool.ok ? 'ok' : 'fail';
  const [doing, done] = VERBS[tool.name] ?? [tool.name, tool.name];
  const many = (tool.args.queries ?? tool.args.urls) as unknown;
  const subject = Array.isArray(many) ? (many.length === 1 ? String(many[0]) : `${many.length} ${tool.args.queries ? 'queries' : 'pages'} at once`)
    : tool.name === 'browse' ? [tool.args.action, tool.args.url ?? tool.args.ref].filter(Boolean).join(' ')
    : tool.name === 'remember' ? String(tool.args.fact ?? '').slice(0, 60) : tool.name === 'list_tasks' ? 'the board'
    : tool.name === 'ask_person' ? String(tool.args.name ?? '') : tool.name === 'recall' ? String(tool.args.query ?? '').slice(0, 60)
    : tool.name === 'delegate_coding' ? String(tool.args.task ?? '').replace(/\s+/g, ' ').slice(0, 60)
    : tool.name === 'generate_image' ? String(tool.args.prompt ?? '').replace(/\s+/g, ' ').slice(0, 60)
    : tool.name === 'generate_voice' ? `"${String(tool.args.text ?? '').replace(/\s+/g, ' ').slice(0, 55)}"`
    : tool.name === 'generate_video' ? String(tool.args.title ?? '').replace(/\s+/g, ' ').slice(0, 60)
    : tool.name === 'run_code' ? `${tool.args.language ?? ''} code` : tool.name === 'read_inbox' ? 'the mailbox'
    : String(tool.args.to ?? tool.args.doc ?? tool.args.title ?? tool.args.path ?? (tool.name === 'list_files' ? 'the shared files' : ''));
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

export function Message({ message, live = false, ...actions }: { message: Omit<ChatMessage, 'id' | 'at'>; live?: boolean } & Actions) {
  if (message.role === 'user') return message.from
    ? <div className="msg msg--colleague"><span>{message.from} asked</span>{message.text}</div>
    : <div className="msg msg--user"><Attachments message={message} />{message.text}<Tools {...actions} /></div>;
  const tokens = message.usage ? message.usage.input + message.usage.output : 0;
  return (
    <div className="msg msg--assistant">
      {message.tools?.map((tool) => <Chip key={tool.id} tool={tool} />)}
      {message.text && <div className="md"><Words text={message.text} /></div>}
      {!live && message.provider && (
        <div className="msg__foot">
          {message.provider} · {message.model}{tokens ? ` · ${compact(tokens)} tokens` : ''}{message.stopped ? ' · stopped' : ''}
          <Tools {...actions} />
        </div>
      )}
    </div>
  );
}
