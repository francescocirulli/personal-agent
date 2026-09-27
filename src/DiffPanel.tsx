import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  ChevronLeft,
  RefreshCw,
  FileDiff as FileDiffIcon,
  Minus,
  Plus,
  WrapText,
} from 'lucide-react';
import { api, type Chat } from './api';
import type { DiffView, FileDiff } from '../server/git-diff';

const labels: Record<string, string> = {
  A: 'Aggiunto',
  M: 'Modificato',
  D: 'Eliminato',
  R: 'Rinominato',
  C: 'Copiato',
  T: 'Tipo cambiato',
  U: 'Conflitto',
};
export function DiffPanel({
  chat,
  open,
  onClose,
  running,
  initialMode,
}: {
  chat: Chat;
  open: boolean;
  onClose(): void;
  running: boolean;
  initialMode?: 'local' | 'branch';
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<'local' | 'branch'>('local');
  const [base, setBase] = useState(() => {
    try {
      return localStorage.getItem(`diff-base:${chat.id}`) || '';
    } catch {
      return '';
    }
  });
  const [view, setView] = useState<DiffView>();
  const [file, setFile] = useState('');
  const [diff, setDiff] = useState<FileDiff>();
  const [error, setError] = useState('');
  const [fileError, setFileError] = useState('');
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const back = useRef<HTMLButtonElement>(null);
  const [reading, setReading] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('diff-reading') || '{}');
      return {
        zoom: Number.isFinite(saved.zoom) ? Math.max(80, Math.min(200, saved.zoom)) : 100,
        wrap: saved.wrap === true,
      };
    } catch {
      return { zoom: 100, wrap: false };
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('diff-reading', JSON.stringify(reading));
    } catch {
      /* Optional preference. */
    }
  }, [reading]);
  useEffect(() => {
    if (open && initialMode) {
      setMode(initialMode);
      setFile('');
      setView(undefined);
    }
  }, [open, initialMode]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => {
      dialog.current?.close();
      previous?.focus({ preventScroll: true });
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const refresh = () => {
      if (!document.hidden && !loading) setRevision((n) => n + 1);
    };
    const interval = setInterval(refresh, 15000);
    window.addEventListener('git-change', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(interval);
      window.removeEventListener('git-change', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [open, loading]);
  const query = new URLSearchParams({
    mode,
    ...(mode === 'branch' && base ? { base } : {}),
  }).toString();
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    api<DiffView>(`/conversations/${chat.id}/diff?${query}`)
      .then((data) => {
        if (!cancelled) setView(data);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e.message);
          setView(undefined);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [chat.id, open, query, revision]);
  useEffect(() => {
    if (!open || !file) return;
    let cancelled = false;
    setFileError('');
    api<FileDiff>(`/conversations/${chat.id}/diff?${query}&file=${encodeURIComponent(file)}`)
      .then((data) => {
        if (!cancelled) setDiff(data);
      })
      .catch((e) => {
        if (!cancelled) {
          setFileError(e.message);
          setDiff(undefined);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [chat.id, open, query, file, revision]);
  useEffect(() => {
    if (file) back.current?.focus();
  }, [file]);
  function changeMode(value: 'local' | 'branch') {
    setMode(value);
    setFile('');
    setView(undefined);
  }
  function chooseBase(value: string) {
    setBase(value);
    setFile('');
    setView(undefined);
    try {
      localStorage.setItem(`diff-base:${chat.id}`, value);
      window.dispatchEvent(new Event('git-change'));
    } catch {
      /* Optional preference. */
    }
  }
  if (!open) return null;
  return createPortal(
    <dialog
      ref={dialog}
      className="branch-sheet diff-sheet"
      aria-labelledby="diff-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="branch-sheet-content">
        <header>
          <h2 id="diff-title">Modifiche della chat</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Chiudi modifiche"
            onClick={onClose}
          >
            <X size={22} />
          </button>
        </header>
        {!!file && (
          <div className="diff-reading" role="group" aria-label="Lettura del codice">
            <button
              type="button"
              aria-label="Riduci zoom"
              disabled={reading.zoom <= 80}
              onClick={() => setReading((r) => ({ ...r, zoom: Math.max(80, r.zoom - 20) }))}
            >
              <Minus size={18} />
            </button>
            <button
              type="button"
              aria-label="Ripristina zoom"
              title="Ripristina zoom al 100%"
              onClick={() => setReading((r) => ({ ...r, zoom: 100 }))}
            >
              {reading.zoom}%
            </button>
            <button
              type="button"
              aria-label="Aumenta zoom"
              disabled={reading.zoom >= 200}
              onClick={() => setReading((r) => ({ ...r, zoom: Math.min(200, r.zoom + 20) }))}
            >
              <Plus size={18} />
            </button>
            <button
              type="button"
              aria-pressed={reading.wrap}
              onClick={() => setReading((r) => ({ ...r, wrap: !r.wrap }))}
            >
              <WrapText size={18} /> A capo
            </button>
          </div>
        )}
        <div className="branch-sheet-scroll">
          <p className="diff-repository">
            {chat.repo || 'Repository locale'} ·{' '}
            {view?.git.branch ||
              (view?.git.detached
                ? `Commit ${view.git.head?.slice(0, 7)}`
                : 'Branch non disponibile')}
          </p>
          <div className="diff-tabs" role="group" aria-label="Tipo di confronto">
            <button
              type="button"
              aria-pressed={mode === 'local'}
              onClick={() => changeMode('local')}
            >
              Modifiche locali
            </button>
            <button
              type="button"
              aria-pressed={mode === 'branch'}
              onClick={() => changeMode('branch')}
            >
              Confronto branch
            </button>
          </div>
          {mode === 'branch' && (
            <label>
              Rispetto al branch
              <select
                aria-label="Branch di confronto"
                value={base || view?.base || ''}
                onChange={(e) => chooseBase(e.target.value)}
              >
                <option value="">Automatico</option>
                {base && !view?.git.branches.some((b) => b.ref === base) && (
                  <option value={base}>{base}</option>
                )}
                {view?.git.branches.map((b) => (
                  <option key={b.ref} value={b.ref}>
                    {b.name}
                    {b.remote ? ' · remoto' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="diff-help">
            {mode === 'local'
              ? 'Differenze rispetto all’ultimo commit: modifiche preparate per il commit, altre modifiche locali e file nuovi.'
              : 'Differenze dall’antenato comune con il branch scelto: commit del branch e modifiche locali. I riferimenti remoti sono quelli già presenti nel checkout.'}
          </p>
          {running && (
            <p role="status">L’agente sta lavorando: i file possono cambiare durante la lettura.</p>
          )}
          <button
            type="button"
            className="diff-refresh"
            disabled={loading}
            onClick={() => setRevision((n) => n + 1)}
          >
            <RefreshCw size={16} /> Aggiorna modifiche
          </button>
          {loading && <p role="status">Aggiornamento modifiche…</p>}
          {error && <p role="alert">{error}</p>}
          {view && !view.git.ready && (
            <p>
              Il repository non è ancora disponibile. Preparalo dal pannello Repository e branch; le
              chat senza Git non hanno diff.
            </p>
          )}
          {view?.git.ready && !file && (
            <>
              <p role="status">
                {view.total
                  ? `${view.total} file con differenze`
                  : 'Nessuna differenza nel confronto selezionato.'}
              </p>
              {view.limited && <p role="status">Mostrati i primi 500 file.</p>}
              <ul className="diff-files">
                {view.files.map((entry) => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      onClick={() => {
                        setDiff(undefined);
                        setFileError('');
                        setFile(entry.path);
                      }}
                    >
                      <FileDiffIcon size={18} aria-hidden="true" />
                      <span>
                        <strong>{entry.path}</strong>
                        {entry.previousPath && <small>Da {entry.previousPath}</small>}
                        <small>
                          {labels[entry.status] || entry.status}
                          {entry.untracked
                            ? ' · nuovo file'
                            : entry.indexOnly
                              ? ' · nell’indice'
                              : ''}
                        </small>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {!!file && (
            <section className="diff-detail" aria-label="Differenze del file">
              <button ref={back} type="button" onClick={() => setFile('')}>
                <ChevronLeft size={18} /> Tutti i file modificati
              </button>
              <h3>{file}</h3>
              {fileError && <p role="alert">{fileError}</p>}
              {!diff && !fileError && <p role="status">Caricamento differenze…</p>}
              {diff?.binary && <p>File binario: confronto testuale non disponibile.</p>}
              {diff?.note && <p>{diff.note}</p>}
              {diff?.limited && (
                <p role="status">Anteprima limitata: il contenuto completo non è visualizzato.</p>
              )}
              {diff?.patch && (
                <pre
                  className={`diff-patch${reading.wrap ? ' diff-wrap' : ''}`}
                  style={{ fontSize: `${(14 * reading.zoom) / 100}px` }}
                  tabIndex={0}
                  role="region"
                  aria-label="Righe aggiunte e rimosse"
                >
                  <code>
                    {diff.patch.split('\n').map((line, i) => (
                      <span
                        key={i}
                        className={
                          line.startsWith('@@')
                            ? 'diff-hunk'
                            : line.startsWith('+') && !line.startsWith('+++')
                              ? 'diff-add'
                              : line.startsWith('-') && !line.startsWith('---')
                                ? 'diff-remove'
                                : ''
                        }
                      >
                        {line || ' '}
                        {'\n'}
                      </span>
                    ))}
                  </code>
                </pre>
              )}
            </section>
          )}
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
