import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { X, ChevronUp, ChevronDown, Search } from 'lucide-react';
import {
  markdownPreviewLimit,
  nodeText,
  readerMarkup,
  splitFrontmatter,
  type MarkdownDocument,
} from './markdown';

function saved<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback;
  } catch {
    return fallback;
  }
}
function remember(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Reading also works without storage. */
  }
}
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const output = [];
  let start = 0,
    at = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  while (at !== -1 && output.length < 1000) {
    output.push(
      text.slice(start, at),
      <mark data-hit key={at}>
        {text.slice(at, at + query.length)}
      </mark>,
    );
    start = at + query.length;
    at = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase(), start);
  }
  output.push(text.slice(start));
  return <>{output}</>;
}
export default function MarkdownReader({
  document: doc,
  onClose,
  onAsk,
}: {
  document: MarkdownDocument;
  onClose(): void;
  onAsk?: (content: string) => void | Promise<void>;
}) {
  const [text, setText] = useState<string>();
  const [file, setFile] = useState<File>();
  const [download, setDownload] = useState(doc.url || '');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [retry, setRetry] = useState(0);
  const [view, setView] = useState<'read' | 'source'>('read');
  const [query, setQuery] = useState('');
  const [indexOpen, setIndexOpen] = useState(false);
  const [headings, setHeadings] = useState<{ id: string; text: string; level: number }[]>([]);
  const [hit, setHit] = useState(0),
    [hitCount, setHitCount] = useState(0);
  const [font, setFont] = useState(() =>
    Math.min(24, Math.max(16, Number(saved('md-reader-font', 18)) || 18)),
  );
  const [asking, setAsking] = useState(false);
  const dialog = useRef<HTMLElement>(null),
    scroller = useRef<HTMLDivElement>(null);
  const positionKey = `md-reader-position:${doc.key}`;
  const positions = useRef(saved(positionKey, { read: 0, source: 0 }));
  const plugins = useMemo(() => [readerMarkup(query)], [query]);
  const preview = (text || '').slice(0, markdownPreviewLimit);
  const { metadata, body } = useMemo(() => splitFrontmatter(preview), [preview]);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = '';
    setError('');
    setText(undefined);
    void (async () => {
      let blob: Blob;
      if (doc.content !== undefined)
        blob = new Blob([doc.content], { type: 'text/markdown;charset=utf-8' });
      else {
        const response = await fetch(doc.url!, { signal: controller.signal });
        if (!response.ok)
          throw new Error(
            response.status === 404
              ? 'Questo file non è più disponibile.'
              : 'Non riesco ad aprire il file. Riprova.',
          );
        blob = await response.blob();
      }
      const content = await blob.text();
      if (controller.signal.aborted) return;
      setText(content);
      setFile(new File([blob], doc.name, { type: 'text/markdown' }));
      if (!doc.url) {
        objectUrl = URL.createObjectURL(blob);
        setDownload(objectUrl);
      }
    })().catch((e) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [doc, retry]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = window.document.getElementById('root');
    const wasInert = root?.inert;
    if (root) root.inert = true;
    const overflow = window.document.body.style.overflow;
    window.document.body.style.overflow = 'hidden';
    dialog.current?.focus();
    const persist = () => remember(positionKey, positions.current);
    window.document.addEventListener('visibilitychange', persist);
    window.addEventListener('pagehide', persist);
    return () => {
      persist();
      window.document.removeEventListener('visibilitychange', persist);
      window.removeEventListener('pagehide', persist);
      if (root) root.inert = !!wasInert;
      window.document.body.style.overflow = overflow;
      previous?.focus({ preventScroll: true });
    };
  }, [positionKey]);
  useLayoutEffect(() => {
    if (text === undefined || !scroller.current) return;
    scroller.current.scrollTop = Math.max(0, Number(positions.current[view]) || 0);
  }, [view, text]);
  useLayoutEffect(() => {
    const area = scroller.current;
    if (!area) return;
    if (view === 'read')
      setHeadings(
        [...area.querySelectorAll<HTMLElement>('[data-heading]')].map((h) => ({
          id: h.id,
          text: h.textContent || '',
          level: Number(h.tagName[1]),
        })),
      );
    const matches = area.querySelectorAll<HTMLElement>('mark[data-hit]');
    setHitCount(matches.length);
    setHit(0);
    if (query && matches.length) matches[0].scrollIntoView({ block: 'center' });
  }, [view, text, query]);
  const moveHit = (delta: number) => {
    if (!hitCount) return;
    const next = (hit + delta + hitCount) % hitCount;
    setHit(next);
    scroller.current
      ?.querySelectorAll<HTMLElement>('mark[data-hit]')
      [next]?.scrollIntoView({ block: 'center' });
  };
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice('Copiato.');
    } catch {
      setNotice('Copia non disponibile. Puoi selezionare il testo nella vista Sorgente.');
    }
  }
  function jump(id: string) {
    setIndexOpen(false);
    requestAnimationFrame(() =>
      scroller.current
        ?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
        ?.scrollIntoView({ block: 'start' }),
    );
  }
  const renderedMarkdown = useMemo(
    () => (
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={plugins}
        skipHtml
        components={{
          pre: ({ node, children }) => (
            <div className="md-code">
              <button onClick={() => void copy(node ? nodeText(node) : '')}>Copia codice</button>
              <pre tabIndex={0}>{children}</pre>
            </div>
          ),
          table: ({ children }) => (
            <div className="md-table" role="region" aria-label="Tabella scorrevole" tabIndex={0}>
              <table>{children}</table>
            </div>
          ),
          a: ({ href, children }) => {
            if (href?.startsWith('#'))
              return (
                <a
                  href={href}
                  onClick={(e) => {
                    e.preventDefault();
                    try {
                      const fragment = decodeURIComponent(href.slice(1));
                      jump(
                        scroller.current?.querySelector(`#${CSS.escape(fragment)}`)
                          ? fragment
                          : `md-${fragment}`,
                      );
                    } catch {}
                  }}
                >
                  {children}
                </a>
              );
            if (!href || !/^(https?:|mailto:)/i.test(href))
              return <span title="Riferimento relativo al documento">{children}</span>;
            return (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            );
          },
          img: ({ alt, src }) => (
            <span className="md-image-note">
              {alt || 'Immagine'}
              {src && /^https?:/i.test(src) && (
                <>
                  {' '}
                  ·{' '}
                  <a href={src} target="_blank" rel="noopener noreferrer">
                    Apri immagine
                  </a>
                </>
              )}
            </span>
          ),
        }}
      >
        {body}
      </Markdown>
    ),
    [body, plugins],
  );
  return createPortal(
    <section
      ref={dialog}
      className="markdown-reader"
      role="dialog"
      aria-modal="true"
      aria-label={`Documento: ${doc.name}`}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
        if (e.key === 'Tab') {
          const controls = [
            ...e.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]',
            ),
          ].filter((el) => el.getClientRects().length);
          const first = controls[0],
            last = controls.at(-1);
          if (
            e.shiftKey &&
            (window.document.activeElement === first ||
              window.document.activeElement === dialog.current)
          ) {
            e.preventDefault();
            last?.focus();
          } else if (!e.shiftKey && window.document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <header className="md-header">
        <div>
          <small>DOCUMENTO MARKDOWN</small>
          <h2 title={doc.name}>{doc.name}</h2>
        </div>
        <button className="icon-button" aria-label="Chiudi lettura" onClick={onClose}>
          <X size={22} />
        </button>
      </header>
      <div className="md-controls">
        <div className="md-views" role="group" aria-label="Vista documento">
          <button aria-pressed={view === 'read'} onClick={() => setView('read')}>
            Leggi
          </button>
          <button
            aria-pressed={view === 'source'}
            onClick={() => {
              setView('source');
              setIndexOpen(false);
            }}
          >
            Sorgente
          </button>
        </div>
        <button
          aria-expanded={indexOpen}
          disabled={view !== 'read' || !headings.length}
          onClick={() => setIndexOpen(!indexOpen)}
        >
          Indice
        </button>
        <div role="group" aria-label="Dimensione testo">
          <button
            aria-label="Riduci testo"
            disabled={font <= 16}
            onClick={() => {
              setFont(font - 2);
              remember('md-reader-font', font - 2);
            }}
          >
            A−
          </button>
          <button
            aria-label="Ingrandisci testo"
            disabled={font >= 24}
            onClick={() => {
              setFont(font + 2);
              remember('md-reader-font', font + 2);
            }}
          >
            A+
          </button>
        </div>
      </div>
      <div className="md-search">
        <Search size={18} aria-hidden="true" />
        <input
          type="search"
          aria-label="Cerca nel documento"
          placeholder="Cerca nel documento"
          maxLength={200}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              moveHit(e.shiftKey ? -1 : 1);
            }
          }}
        />
        <span role="status">
          {query ? `${hitCount ? hit + 1 : 0}/${hitCount}${hitCount >= 500 ? '+' : ''}` : ''}
        </span>
        <button
          className="icon-button"
          aria-label="Risultato precedente"
          disabled={!hitCount}
          onClick={() => moveHit(-1)}
        >
          <ChevronUp size={18} />
        </button>
        <button
          className="icon-button"
          aria-label="Risultato successivo"
          disabled={!hitCount}
          onClick={() => moveHit(1)}
        >
          <ChevronDown size={18} />
        </button>
      </div>
      {indexOpen && (
        <nav className="md-index" aria-label="Indice documento">
          {headings.map((h) => (
            <button
              key={h.id}
              style={{ paddingLeft: 12 + (h.level - 1) * 12 }}
              onClick={() => jump(h.id)}
            >
              {h.text}
            </button>
          ))}
        </nav>
      )}
      <div
        ref={scroller}
        className="md-scroll"
        style={{ '--md-font': `${font}px` } as CSSProperties}
        onScroll={(e) => {
          positions.current[view] = e.currentTarget.scrollTop;
        }}
      >
        {error && (
          <div role="alert">
            <p>{error}</p>
            {text === undefined && <button onClick={() => setRetry(retry + 1)}>Riprova</button>}
          </div>
        )}
        {text === undefined && !error && <p role="status">Apro il documento…</p>}
        {text !== undefined && (
          <>
            {text.length > markdownPreviewLimit && (
              <p className="md-limit">
                Anteprima dei primi 200.000 caratteri. Scarica o copia il sorgente per il documento
                completo.
              </p>
            )}
            {view === 'source' ? (
              <pre className="md-source" tabIndex={0}>
                <Highlight text={preview} query={query} />
              </pre>
            ) : (
              <article className="md-content">
                {metadata && (
                  <details open={query ? true : undefined} className="md-metadata">
                    <summary>Metadati</summary>
                    <pre>
                      <Highlight text={metadata} query={query} />
                    </pre>
                  </details>
                )}
                {renderedMarkdown}
              </article>
            )}
          </>
        )}
      </div>
      {notice && (
        <div className="md-notice" role="status">
          {notice}
        </div>
      )}
      <footer className="md-footer">
        <div className="md-file-actions">
          <button disabled={text === undefined} onClick={() => void copy(text!)}>
            Copia sorgente
          </button>
          {download && (
            <a href={download} download={doc.name}>
              Scarica
            </a>
          )}
          {!!navigator.share && (
            <button
              disabled={!file}
              onClick={() => {
                if (!file) return;
                if (!navigator.canShare?.({ files: [file] })) {
                  setNotice('Usa Scarica per condividere il file dal dispositivo.');
                  return;
                }
                void navigator.share({ files: [file], title: doc.name }).catch((e) => {
                  if (e.name !== 'AbortError')
                    setNotice('Condivisione non riuscita. Puoi scaricare il file.');
                });
              }}
            >
              Condividi
            </button>
          )}
        </div>
        {onAsk ? (
          <button
            className="primary"
            disabled={text === undefined || asking}
            onClick={() => {
              setAsking(true);
              void Promise.resolve()
                .then(() => onAsk(text!))
                .catch((e) => setNotice(e.message))
                .finally(() => setAsking(false));
            }}
          >
            Chiedi su questo file
          </button>
        ) : (
          <small>Apri una chat per fare una domanda su questo file.</small>
        )}
      </footer>
    </section>,
    window.document.body,
  );
}
