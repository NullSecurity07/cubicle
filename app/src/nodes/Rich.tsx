import { Children, memo, useEffect, useId, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const VIDEO = /\.(mp4|webm|mov)(\?.*)?$/i;
const AUDIO = /\.(wav|mp3|ogg|m4a)(\?.*)?$/i;
// A table cell is the one place markdown gives no way to start a new line, so models write <br> there and the founder
// reads it as letters. Only this one tag, only in a cell, and only as a break: nothing else here becomes HTML.
const BR = /<br\s*\/?>/i;
export function broken(children: ReactNode): ReactNode[] {
  return Children.toArray(children).flatMap((child, index): ReactNode[] => (typeof child === 'string' && BR.test(child)
    ? child.split(BR).flatMap((piece, at) => (at ? [<br key={`${index}-${at}`} />, piece] : [piece]))
    : [child]));
}

// A diagram written as Mermaid text. The library is large, so it loads only when a reply first contains one.
function Diagram({ source }: { source: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [svg, setSvg] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let gone = false;
    setFailed(false);
    // While a reply streams the diagram text is half written: draw only text that parses, a moment after it stops changing.
    const timer = setTimeout(() => {
      import('mermaid').then(async ({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict', fontFamily: 'inherit' });
        if (!(await mermaid.parse(source, { suppressErrors: true }))) { if (!gone) setFailed(true); return; }
        const drawn = await mermaid.render(`m${id}${Date.now().toString(36)}`, source);
        if (!gone) setSvg(drawn.svg);
      }).catch(() => { if (!gone) setFailed(true); });
    }, 250);
    return () => { gone = true; clearTimeout(timer); };
  }, [id, source]);
  if (failed || !svg) return <pre><code>{source}</code></pre>;
  return <div className="diagram" role="img" aria-label="Diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}

// A page a person wrote. It runs in a sandboxed frame with no access to this app, its origin or the network of cookies.
function Artifact({ source }: { source: string }) {
  const [shown, setShown] = useState(true);
  return (
    <div className="artifact">
      <div className="artifact__bar"><span>Preview</span><button type="button" onClick={() => setShown(!shown)}>{shown ? 'Show code' : 'Show preview'}</button></div>
      {shown ? <iframe title="Preview" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={source} /> : <pre><code>{source}</code></pre>}
    </div>
  );
}

function Code({ className, children }: { className?: string; children?: ReactNode }) {
  const language = /language-(\w+)/.exec(className ?? '')?.[1];
  const source = String(children ?? '').replace(/\n$/, '');
  if (language === 'mermaid') return <Diagram source={source} />;
  if (language === 'html' && /<\w+[\s>]/.test(source) && source.length > 40) return <Artifact source={source} />;
  return <code className={className}>{children}</code>;
}

// Markdown as people write it: tables, links that open outside, pictures, video, diagrams and live HTML previews.
export const Words = memo(function Words({ text }: { text: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ node: _node, href, children, ...props }) => (href && VIDEO.test(href) ? <video className="md__media" src={href} controls preload="metadata" />
          : href && AUDIO.test(href) ? <audio className="md__media md__media--sound" src={href} controls preload="metadata" />
          : <a {...props} href={href} target="_blank" rel="noreferrer">{children}</a>),
        img: ({ node: _node, src, alt }) => (typeof src === 'string' && VIDEO.test(src) ? <video className="md__media" src={src} controls preload="metadata" />
          : typeof src === 'string' && AUDIO.test(src) ? <audio className="md__media md__media--sound" src={src} controls preload="metadata" />
          : <img className="md__media" src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} loading="lazy" />),
        code: ({ node: _node, className, children }) => <Code className={className}>{children}</Code>,
        td: ({ node: _node, children, ...props }) => <td {...props}>{broken(children)}</td>,
        th: ({ node: _node, children, ...props }) => <th {...props}>{broken(children)}</th>,
        pre: ({ node: _node, children }) => {
          const only = Array.isArray(children) ? children[0] : children;
          const language = /language-(mermaid|html)/.exec((only as { props?: { className?: string } })?.props?.className ?? '');
          return language ? <>{children}</> : <pre>{children}</pre>;
        },
      }}
    >
      {text}
    </Markdown>
  );
});
