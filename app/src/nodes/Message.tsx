import { memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage, ToolEvent } from '../../shared/model';

const VERBS: Record<string, [doing: string, done: string]> = {
  write_doc: ['Rewriting', 'Rewrote'], append_doc: ['Adding to', 'Added to'], create_doc: ['Creating', 'Created'],
  list_files: ['Looking at', 'Looked at'], read_file: ['Reading', 'Read'], write_file: ['Saving', 'Saved'],
};
const compact = (count: number) => (count < 1000 ? String(count) : `${(count / 1000).toFixed(1)}k`);

// One tool call: what the person did, in a line. Opens to show exactly what was sent and what came back.
function Chip({ tool }: { tool: ToolEvent }) {
  const state = tool.ok === undefined ? 'run' : tool.ok ? 'ok' : 'fail';
  const [doing, done] = VERBS[tool.name] ?? [tool.name, tool.name];
  const subject = String(tool.args.doc ?? tool.args.title ?? tool.args.path ?? (tool.name === 'list_files' ? 'the shared files' : ''));
  return (
    <details className={`chip chip--${state}`}>
      <summary><span className="chip__mark" aria-hidden="true" />{state === 'fail' ? `Could not: ${doing.toLowerCase()}` : state === 'run' ? doing : done} {subject}</summary>
      <pre>{JSON.stringify(tool.args, null, 2)}{tool.result ? `\n\n${tool.result}` : ''}</pre>
    </details>
  );
}

const Words = memo(function Words({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}>
      {text}
    </Markdown>
  );
});

export function Message({ message, live = false }: { message: Omit<ChatMessage, 'id' | 'at'>; live?: boolean }) {
  if (message.role === 'user') return <p className="msg msg--user">{message.text}</p>;
  const tokens = message.usage ? message.usage.input + message.usage.output : 0;
  return (
    <div className="msg msg--assistant">
      {message.tools?.map((tool) => <Chip key={tool.id} tool={tool} />)}
      {message.text && <div className="md"><Words text={message.text} /></div>}
      {!live && message.provider && (
        <div className="msg__foot">
          {message.provider} · {message.model}{tokens ? ` · ${compact(tokens)} tokens` : ''}{message.stopped ? ' · stopped' : ''}
        </div>
      )}
    </div>
  );
}
