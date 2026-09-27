import { memo, useEffect, useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Element } from 'hast';
import { nodeText } from './markdown';

function CopyButton({ text, label }: { text: string; label: string }) {
  const [status, setStatus] = useState('');
  useEffect(() => setStatus(''), [text]);
  return (
    <div className="chat-copy">
      <button
        aria-label={label}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setStatus('Copiato');
          } catch {
            setStatus('Copia non disponibile. Seleziona il testo per copiarlo.');
          }
        }}
      >
        {label}
      </button>
      {status && <span role="status">{status}</span>}
    </div>
  );
}

function tableText(node?: Element): string {
  if (!node) return '';
  const rows: string[] = [];
  const walk = (element: Element) => {
    if (element.tagName === 'tr') {
      rows.push(
        element.children
          .filter((child): child is Element => child.type === 'element')
          .map((cell) => nodeText(cell).replace(/[\t\r\n]+/g, ' '))
          .join('\t'),
      );
    } else {
      for (const child of element.children) if (child.type === 'element') walk(child);
    }
  };
  walk(node);
  return rows.join('\n');
}

const components: Components = {
  a: ({ node, href, ...props }) => (
    <a
      {...props}
      href={href}
      target={href?.startsWith('#') ? undefined : '_blank'}
      rel="noopener noreferrer"
      onClick={(event) => {
        if (!href?.startsWith('#')) return;
        try {
          const target = event.currentTarget
            .closest('.chat-markdown')
            ?.querySelector<HTMLElement>(`#${CSS.escape(decodeURIComponent(href.slice(1)))}`);
          if (target) {
            event.preventDefault();
            target.scrollIntoView({ block: 'center' });
            target.focus({ preventScroll: true });
          }
        } catch {
          /* Leave malformed fragments to the browser. */
        }
      }}
    />
  ),
  table: ({ node, children }) => (
    <div className="chat-table">
      <div className="chat-block-toolbar">
        <span>Tabella</span>
        <CopyButton label="Copia tabella" text={tableText(node)} />
      </div>
      <div className="chat-table-scroll" role="region" aria-label="Tabella scorrevole" tabIndex={0}>
        <table>{children}</table>
      </div>
    </div>
  ),
  pre: ({ node, children }) => {
    const code = node?.children.find(
      (child): child is Element => child.type === 'element' && child.tagName === 'code',
    );
    const classes = code?.properties.className;
    const language = Array.isArray(classes)
      ? String(classes.find((value) => String(value).startsWith('language-')) || '').slice(9)
      : '';
    return (
      <div className="chat-code">
        <div className="chat-block-toolbar">
          <span>{language || 'Codice'}</span>
          <CopyButton label="Copia codice" text={node ? nodeText(node) : ''} />
        </div>
        <pre tabIndex={0} aria-label="Blocco di codice">
          {children}
        </pre>
      </div>
    );
  },
};
const plugins = [remarkGfm];

export const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }) {
  return (
    <div className="chat-markdown">
      <Markdown
        remarkPlugins={plugins}
        remarkRehypeOptions={{ footnoteLabel: 'Note', footnoteBackLabel: 'Torna al riferimento' }}
        components={components}
      >
        {text}
      </Markdown>
    </div>
  );
});
